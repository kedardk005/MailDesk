import axios from 'axios';

// Create an Axios instance with base URL for backend API
const api = axios.create({
  baseURL: 'http://localhost:5015/api',
  headers: {
    'Content-Type': 'application/json'
  }
});

// Add a request interceptor to attach the JWT token dynamically
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

export default api;
