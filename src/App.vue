<template>
  <div class="container mt-5">

    <!-- Форма загрузки -->
    <div class="card mb-5">
      <div class="card-body">
        <h2 class="mb-4">Загрузить XLSX файл</h2>
        <form @submit.prevent="uploadFile" enctype="multipart/form-data">
          <div class="mb-3">
            <input
                type="file"
                class="form-control"
                accept=".xlsx"
                @change="onFileChange"
                :disabled="isUploading"
            >
          </div>
          <button
              type="submit"
              class="btn btn-primary"
              :disabled="!selectedFile || isUploading"
          >
            <span v-if="isUploading" class="spinner-border spinner-border-sm"></span>
            {{ isUploading ? 'Обработка...' : 'Начать обработку' }}
          </button>
        </form>
      </div>
    </div>

    <!-- Список задач -->
    <div class="card">
      <div class="card-body">
        <h2 class="mb-4">Задачи</h2>
        <div v-if="loading" class="text-center">
          <div class="spinner-border text-primary"></div>
        </div>

        <table v-else class="table table-hover">
          <thead>
          <tr>
            <th>ID</th>
            <th>Статус</th>
            <th>Прогресс</th>
            <th>Выполнено</th>
            <th>Загрузить</th>
          </tr>
          </thead>
          <tbody>
          <tr v-for="task in tasks" :key="task.id">
            <td>{{ task.id }}</td>
            <td>
                <span :class="statusClass(task.status)">
                  {{ statusText(task.status) }}
                </span>
            </td>
            <td>
              <div v-if="task.status === 'processing'">
                <div class="progress">
                  <div
                      class="progress-bar progress-bar-striped progress-bar-animated"
                      :style="{ width: progressWidth(task) }"
                  >
                  </div>

                  <span class="progress-text">
          {{ task.completed }}/{{ task.urlsCount }} ({{ Math.round((task.completed / task.urlsCount) * 100 )}}%)
        </span>
                </div>

              </div>
              <span v-else>-</span>
            </td>
            <td>{{ formatDate(task.processedAt) }}</td>
            <td>
              <form :action="`https://s3.timeweb.cloud/30489bee-screenshotservice/${task.s3Key}`">
                <button
                    v-if="task.status === 'completed'"
                    type="submit"
                    formmethod="get"
                    class="btn btn-success btn-sm"
                >
                  Загрузить архив
                </button>
              </form>
            </td>
          </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script>
import axios from 'axios';

export default {
  data() {
    return {
      selectedFile: null,
      isUploading: false,
      tasks: [],
      loading: true,
      error: null,
      pollingIntervals: {},
      backendHost:"https://hardw3q-excel-screenshots-0022.twc1.net"
    };
  },
  async mounted() {
    await this.fetchTasks();
  },
  beforeUnmount() {
    // Очистка всех интервалов при удалении компонента
    Object.values(this.pollingIntervals).forEach(clearInterval);
  },

  methods: {
    onFileChange(e) {
      this.selectedFile = e.target.files[0];
    },

    async uploadFile() {
      if (!this.selectedFile) return;

      this.isUploading = true;
      const formData = new FormData();
      formData.append('file', this.selectedFile);

      try {
        const { data } = await axios.post(`${this.backendHost}/tasks/upload`, formData, {
          headers: {
            'Content-Type': 'multipart/form-data'
          }
        });
        this.tasks.unshift(data);
        this.startTaskPolling(data.id);
      } catch (error) {
        console.error('Upload error:', error);
        alert('Ошибка при загрузке файла');
      } finally {
        this.isUploading = false;
        this.selectedFile = null;
      }
    },

    async fetchTasks() {
      try {
        const { data } = await axios.get(`${this.backendHost}/tasks`);
        this.tasks = data;
        // Запускаем опрос для активных задач
        data.forEach(task => {
          if (task.status === 'processing') {
            this.startTaskPolling(task.id);
          }
        });
      } catch (error) {
        console.error('Error fetching tasks:', error);
        this.error = 'Ошибка загрузки задач';
      } finally {
        this.loading = false;
      }
    },

    startTaskPolling(taskId) {
      if (this.pollingIntervals[taskId]) return;

      this.pollingIntervals[taskId] = setInterval(async () => {
        try {
          const { data } = await axios.get(`${this.backendHost}/tasks/byId/${taskId}`);
          const index = this.tasks.findIndex(t => t.id === taskId);
          if (index !== -1) {
            this.tasks.splice(index, 1, data);
          }

          // Останавливаем опрос если задача завершена
          if (data.status !== 'processing') {
            clearInterval(this.pollingIntervals[taskId]);
            delete this.pollingIntervals[taskId];
          }
        } catch (error) {
          console.error('Polling error:', error);
        }
      }, 3000); // Опрос каждые 3 секунды
    },

    progressWidth(task) {
      if (!task.urlsCount || task.urlsCount === 0) return '0%';
      const progress = (task.completed / task.urlsCount) * 100;
      return `${Math.min(progress, 100)}%`;
    },

    statusText(status) {
      return {
        'processing': 'В процессе',
        'completed': 'Завершено',
        'failed': 'Ошибка'
      }[status];
    },

    statusClass(status) {
      return {
        'text-success': status === 'completed',
        'text-warning': status === 'processing',
        'text-danger': status === 'failed'
      };
    },

    formatDate(dateString) {
      const options = {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      };
      return new Date(dateString).toLocaleDateString(undefined, options);
    }
  }
};
</script>

<style scoped>
.container {
  max-width: 800px;
}

.card {
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.progress {
  height: 25px;
  width: 200px;
}

.progress-bar {
  font-size: 0.9em;
  line-height: 25px;
}

.table {
  margin-top: 20px;
}

.btn:disabled {
  cursor: not-allowed;
}
.progress-text {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  color: black;
  font-weight: bold;
  text-shadow: 0 0 2px white;
}
</style>