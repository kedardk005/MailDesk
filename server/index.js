// Load environment variables from .env
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');

// Create Express app
const app = express();

// Connect to MongoDB
connectDB();

// Apply Rate Limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per windowMs
  message: { message: 'Too many authentication attempts from this IP, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // Limit each IP to 300 requests per windowMs
  message: { message: 'Too many requests from this IP, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply Middlewares
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }));
app.use(express.json());
app.use(mongoSanitize());

// Apply Limiters to routes
app.use('/api', generalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);

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
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ["GET", "POST"]
  }
});

// Expose io object to req.app for controllers
app.set('io', io);

// Socket.io connection authentication middleware
const jwt = require('jsonwebtoken');
const User = require('./models/User');

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('Authentication error. Token missing.'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) {
      return next(new Error('Authentication error. User not found.'));
    }

    // Verify token version (for password change revocation)
    if (user.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
      return next(new Error('Authentication error. Token version mismatch.'));
    }

    socket.data = socket.data || {};
    socket.data.user = user;
    next();
  } catch (err) {
    console.error('Socket authentication failed:', err.message);
    next(new Error('Authentication error. Invalid token.'));
  }
});

// Socket.io connection and room joins
io.on('connection', (socket) => {
  console.log(`Client connected via socket: ${socket.id}`);
  
  // Automatically join the user to their own notification channel
  if (socket.data?.user?._id) {
    const userId = socket.data.user._id.toString();
    socket.join(userId);
    console.log(`Socket client ${socket.id} automatically joined channel: ${userId}`);
  }

  // Fallback join handler (ignores argument, scopes to session user)
  socket.on('join', () => {
    if (socket.data?.user?._id) {
      const userId = socket.data.user._id.toString();
      socket.join(userId);
      console.log(`Socket client ${socket.id} joined channel (event): ${userId}`);
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
