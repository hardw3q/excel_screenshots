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
            <th>Выполнено</th>
            <th>Загрузить</th>
          </tr>
          </thead>
          <tbody>
          <tr v-for="task in tasks" :key="task.id">
            <td>{{ task.id }}</td>
            <td>
                <span :class="statusClass(task.status)">
                  {{ task.status }}
                </span>
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
      error: null
    };
  },
  async mounted() {
    await this.fetchTasks();
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
        const { data } = await axios.post('https://lk.nncsm.ru/screenshots/tasks/upload', formData, {
          headers: {
            'Content-Type': 'multipart/form-data'
          }
        });
        this.tasks.unshift(data);
      } catch (error) {
        console.error('Upload error:', error);
        alert('Error uploading file');
      } finally {
        this.isUploading = false;
        this.selectedFile = null;
      }
    },

    async fetchTasks() {
      try {
        const { data } = await axios.get(`https://lk.nncsm.ru/screenshots/tasks`);
        this.tasks = data;
        console.log(data)
      } catch (error) {
        console.error('Error fetching tasks:', error);
        this.error = 'Failed to load tasks';
      } finally {
        this.loading = false;
      }
    },

    // async downloadFile(key) {
    //   try {
    //     const { data } = await axios.get(`/tasks/${key}`);
    //     console.log(data)
    //     window.location.href = data.url;
    //   } catch (error) {
    //     console.error('Download error:', error);
    //     alert('Error generating download link');
    //   }
    // },

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

.spinner-border {
  display: inline-block;
}

.table {
  margin-top: 20px;
}

.btn:disabled {
  cursor: not-allowed;
}
</style>