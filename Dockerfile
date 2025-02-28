# Базовый образ для сборки
FROM node:20-bookworm-slim AS builder

# Установка системных зависимостей
RUN apt-get update && apt-get install -y \
    ca-certificates \
    chromium \
    fonts-liberation \
    libglib2.0-0 \
    libnss3 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    && rm -rf /var/lib/apt/lists/*

# Создание символической ссылки после установки пакетов
RUN ln -sf /usr/bin/chromium /usr/bin/chromium-browser

# Рабочая директория
WORKDIR /app

# Копируем зависимости
COPY package*.json ./
COPY nest-cli.json ./

# Установка зависимостей
RUN npm ci --omit=dev --ignore-scripts

# Копируем исходный код
COPY . .

# Сборка приложения
RUN npm run build

# Финальный образ
FROM node:20-bookworm-slim

# Установка runtime зависимостей
RUN apt-get update && apt-get install -y \
    chromium \
    libglib2.0-0 \
    libnss3 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    && rm -rf /var/lib/apt/lists/*

# Создание символической ссылки после установки пакетов
RUN ln -sf /usr/bin/chromium /usr/bin/chromium-browser

ENV NODE_ENV=production
ENV PORT=3000
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Создаем непривилегированного пользователя
RUN useradd -m appuser
WORKDIR /home/appuser/app

# Копируем артефакты сборки
COPY --from=builder --chown=appuser:appuser /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appuser /app/package*.json ./
COPY --from=builder --chown=appuser:appuser /app/dist ./dist

USER appuser

# Проверка здоровья
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl --fail http://localhost:${PORT}/health || exit 1

# Запуск приложения
CMD ["npm", "run", "start:prod"]
