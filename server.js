const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware (development only)
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });
}

// MongoDB Connection with retry logic
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/grocery-erp';

let mongoConnectPromise = null;
let listenersRegistered = false;

const connectDB = async () => {
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
    return;
  }

  if (mongoConnectPromise) {
    return mongoConnectPromise;
  }

  mongoConnectPromise = (async () => {
    try {
      const connectionOptions = {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 10000, // 10 seconds timeout
        socketTimeoutMS: 45000, // 45 seconds socket timeout
        connectTimeoutMS: 10000, // 10 seconds connection timeout
        retryWrites: true,
        retryReads: true,
        maxPoolSize: 10, // Maintain up to 10 socket connections
        minPoolSize: 2, // Maintain at least 2 socket connections
      };

      // Check if MONGODB_URI is set
      if (!process.env.MONGODB_URI) {
        console.warn('⚠️  MONGODB_URI not set in environment variables, using default localhost');
      }

      console.log('🔄 Attempting to connect to MongoDB...');
      await mongoose.connect(MONGODB_URI, connectionOptions);
      
      console.log('✅ MongoDB Connected Successfully');
      console.log(`📊 Database: ${mongoose.connection.name}`);
      console.log(`🔗 Host: ${mongoose.connection.host}`);

      if (!listenersRegistered) {
        listenersRegistered = true;

        mongoose.connection.on('error', (err) => {
          console.error('❌ MongoDB Connection Error:', err.message);
          if (err.message.includes('ENOTFOUND')) {
            console.error('💡 DNS Resolution Error: Check your MongoDB connection string and network connectivity');
            console.error('💡 If using MongoDB Atlas, ensure:');
            console.error('   1. Your IP address is whitelisted in Atlas');
            console.error('   2. Your network connection is active');
            console.error('   3. The connection string is correct');
          }
        });

        mongoose.connection.on('disconnected', () => {
          console.warn('⚠️  MongoDB Disconnected. Attempting to reconnect...');
          setTimeout(() => {
            connectDB();
          }, 5000);
        });

        mongoose.connection.on('reconnected', () => {
          console.log('✅ MongoDB Reconnected');
        });
      }

    } catch (error) {
      console.error('❌ MongoDB Connection Failed:', error.message);
      
      if (error.message.includes('ENOTFOUND')) {
        console.error('\n💡 DNS Resolution Error Detected!');
        console.error('Possible solutions:');
        console.error('1. Check your internet connection');
        console.error('2. Verify MongoDB Atlas connection string is correct');
        console.error('3. Check if MongoDB Atlas cluster is running (not paused)');
        console.error('4. Verify your IP is whitelisted in MongoDB Atlas');
        console.error('5. Check if you\'re behind a firewall/VPN that blocks MongoDB Atlas');
        console.error('\n📝 Current MONGODB_URI:', process.env.MONGODB_URI ? 'Set (hidden)' : 'Not set (using default)');
      } else if (error.message.includes('authentication failed')) {
        console.error('\n💡 Authentication Error:');
        console.error('1. Check your MongoDB username and password');
        console.error('2. Verify database user has proper permissions');
      } else if (error.message.includes('timeout')) {
        console.error('\n💡 Connection Timeout:');
        console.error('1. Check your network connection');
        console.error('2. MongoDB Atlas cluster might be slow or paused');
        console.error('3. Try increasing timeout values');
      }
      
      // Don't exit immediately - allow server to start and retry
      console.log('🔄 Will retry connection in 10 seconds...');
      setTimeout(() => {
        connectDB();
      }, 10000);
    }
  })()
    .finally(() => {
      mongoConnectPromise = null;
    });

  return mongoConnectPromise;
};

// Initial connection
connectDB();

// Routes
const syncRoutes = require('./src/routes/sync');
const authRoutes = require('./src/routes/auth');
const dataRoutes = require('./src/routes/data');
const planValidityRoutes = require('./src/routes/planValidity');
app.get('/ping', (req, res) => {
  res.send('pong');
});

app.use('/api/auth', authRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/plans', planValidityRoutes);

// Health check with MongoDB status
app.get('/api/health', (req, res) => {
  const mongoStatus = mongoose.connection.readyState;
  const statusMap = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting'
  };
  
  res.json({ 
    status: mongoStatus === 1 ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    mongodb: {
      status: statusMap[mongoStatus] || 'unknown',
      readyState: mongoStatus,
      connected: mongoStatus === 1
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
    error: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = app;

