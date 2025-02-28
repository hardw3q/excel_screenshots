# Stage 1: Builder
FROM node:20-bookworm-slim AS builder

# Установка Google Chrome Stable в стадии сборки
RUN apt-get update && apt-get install curl gnupg -y \
  && curl --location --silent https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
  && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
  && apt-get update \
  && apt-get install google-chrome-stable -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Рабочая директория
WORKDIR /app

# Копирование зависимостей
COPY package*.json ./
COPY nest-cli.json ./

# Установка зависимостей (включая dev для сборки)
RUN npm ci --ignore-scripts

# Установка NestJS CLI глобально для сборки
RUN npm install -g @nestjs/cli

# Копирование исходного кода
COPY . .

# Сборка приложения
RUN npm run build

# Удаление dev-зависимостей после сборки
RUN npm prune --production

# Stage 2: Финальный образ
FROM node:20-bookworm-slim

# Установка Google Chrome Stable в финальном образе
RUN apt-get update && apt-get install curl gnupg -y \
  && curl --location --silent https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
  && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
  && apt-get update \
  && apt-get install google-chrome-stable -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Создание непривилегированного пользователя
RUN useradd -m appuser
WORKDIR /home/appuser/app

# Копирование артефактов сборки из стадии builder
COPY --from=builder --chown=appuser:appuser /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appuser /app/package*.json ./
COPY --from=builder --chown=appuser:appuser /app/dist ./dist

USER appuser

# Проверка здоровья
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl --fail http://localhost:${PORT}/health || exit 1

EXPOSE 3000
# Запуск приложения
CMD ["npm", "run", "start:prod"]
