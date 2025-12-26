const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    process.env.ADMIN_FRONTEND_URL || 'http://localhost:5174',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:3000'
  ],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware (development only)
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    // console.log(`${req.method} ${req.path}`);
    next();
  });
}

// Persistent Request Logging (for Admin Stats)
const RequestLog = require('./src/models/RequestLog');
app.use((req, res, next) => {
  const start = Date.now();

  // Hook into response finish event
  res.on('finish', async () => {
    try {
      // Filter out options and irrelevant paths
      if (req.method === 'OPTIONS') return;

      const duration = Date.now() - start;

      // We explicitly don't await this to not block the response
      RequestLog.create({
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration,
        ip: req.ip,
        userAgent: req.get('user-agent')
      }).catch(err => console.error('Request logging failed', err));

    } catch (error) {
      console.error('Error in request logger:', error);
    }
  });

  next();
});

// MongoDB Connection with retry logic
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/dragAndDrop_inventory';

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

      // ('🔄 Attempting to connect to MongoDB...');
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
          // ('✅ MongoDB Reconnected');
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
      //('🔄 Will retry connection in 10 seconds...');
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
const adminRoutes = require('./src/routes/admin');
const dataRoutes = require('./src/routes/data');
const planValidityRoutes = require('./src/routes/planValidity');
const refundRoutes = require('./src/routes/refund');
app.get('/ping', (req, res) => {
  res.send('pong');
});

app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/plans', planValidityRoutes);
app.use('/api/refunds', refundRoutes);
app.use('/api/expenses', require('./src/routes/expense'));
//('✅ Refund routes registered at /api/refunds');

// Health check endpoint removed - this API is only for testing, not for sellers/staff

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
    error: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Serve Static files for main frontend
app.use(express.static(path.join(__dirname, '../frontend/build')));

// Serve Static files for admin frontend (mount at /admin)
app.use('/admin', express.static(path.join(__dirname, '../admin-frontend/dist')));

// Serve Admin React app for /admin/* routes
app.get(['/admin', '/admin/*'], (req, res) => {
  // Skip API routes within admin path if any
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, message: 'API route not found' });
  }

  res.sendFile(path.join(__dirname, '../admin-frontend/dist/index.html'), (err) => {
    if (err) {
      console.error('Error serving admin index.html:', err);
      // Fallback or error
      res.status(500).send('Error loading admin panel');
    }
  });
});

// Serve React app for client-side routing
app.get('*', (req, res) => {
  // Skip API routes
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, message: 'API route not found' });
  }

  // For all other routes (including /staff/*), serve the React app
  res.sendFile(path.join(__dirname, '../frontend/build/index.html'), (err) => {
    if (err) {
      console.error('Error serving index.html:', err);
      res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
  });
});

// 404 handler for API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ success: false, message: 'API route not found' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  //(`🚀 Server running on port ${PORT}`);
});

module.exports = app;

