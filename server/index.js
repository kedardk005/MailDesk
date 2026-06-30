// Load environment variables from .env
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const connectDB = require('./config/db');

// Create Express app
const app = express();

// Connect to MongoDB
connectDB();

// Apply Middlewares
app.use(cors());
app.use(express.json());

// Import routes and middleware
const authRoutes = require('./routes/authRoutes');
const { protect } = require('./middleware/authMiddleware');

// Base health route
app.get('/api/health', (req, res) => {
  res.json({ status: "Server is running" });
});

// Auth routes
app.use('/api/auth', authRoutes);

// User CRUD routes (Admin only)
const userRoutes = require('./routes/userRoutes');
app.use('/api/users', userRoutes);

// Gmail routes
const gmailRoutes = require('./routes/gmailRoutes');
app.use('/api/gmail', gmailRoutes);

// Task routes
const taskRoutes = require('./routes/taskRoutes');
app.use('/api/tasks', taskRoutes);

const commentRoutes = require('./routes/commentRoutes');
app.use('/api/tasks/:id/comments', commentRoutes);

// Notification routes
const notificationRoutes = require('./routes/notificationRoutes');
app.use('/api/notifications', notificationRoutes);

// Reports routes
const reportsRoutes = require('./routes/reportsRoutes');
app.use('/api/reports', reportsRoutes);

// AI routes
const aiRoutes = require('./routes/aiRoutes');
app.use('/api/ai', aiRoutes);

// Protected test route - returns logged-in user profile
app.get('/api/auth/me', protect, (req, res) => {
  res.json(req.user);
});

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.io on the HTTP server
const io = new Server(server, {
  cors: {
    origin: "*", // Accept all origins for development setup
    methods: ["GET", "POST"]
  }
});

// Expose io object to req.app for controllers
app.set('io', io);

// Simple Socket.io connection logging for developer visibility
io.on('connection', (socket) => {
  console.log(`Client connected via socket: ${socket.id}`);
  
  // Connect user socket instance to unique user ID channel
  socket.on('join', (userId) => {
    if (userId) {
      socket.join(userId.toString());
      console.log(`Socket client ${socket.id} joined channel: ${userId}`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// Import cron evaluation scheduler
const { startCronJobs } = require('./utils/cronJobs');

// Start listening on PORT
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Start overdue checking scheduler
  startCronJobs(io);
});
