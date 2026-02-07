const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

const io = new Server(server, {
    cors: {
        origin: (origin, callback) => {
            // Allow requests with no origin (like mobile apps, curl, or same-origin)
            if (!origin) return callback(null, true);

            // Always allow localhost/127.0.0.1 in development
            if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
                return callback(null, true);
            }

            const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(o => o);
            const defaultOrigins = [
                'http://localhost:3000',
                'http://localhost:5173',
                'http://localhost:5174',
                'http://localhost:5175'
            ];
            const origins = allowedOrigins.length > 0 ? allowedOrigins : defaultOrigins;

            const isAllowed = origins.some(o => origin === o || origin.startsWith(o));
            if (isAllowed) {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        },
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
        credentials: true
    }
});

app.set('io', io);

io.on("connection", (socket) => {
    // console.log("New client connected", socket.id);

    socket.on("join_seller_room", (sellerId) => {
        if (sellerId) {
            socket.join(`seller_${sellerId}`);
            // console.log(`Socket ${socket.id} joined room seller_${sellerId}`);
        }
    });

    socket.on("disconnect", () => {
        // console.log("Client disconnected", socket.id);
    });
});

// Nonce generation middleware
app.use((req, res, next) => {
    res.locals.nonce = crypto.randomBytes(16).toString('base64');
    next();
});

// Security Middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`, "https://apis.google.com", "https://www.gstatic.com", "https://www.googleapis.com", "https://checkout.razorpay.com"],
            styleSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`, "'unsafe-inline'", "https://fonts.googleapis.com"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: ["'self'", "http://localhost:*", "http://127.0.0.1:*", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com", "https://www.googleapis.com", "https://lumberjack-cx.razorpay.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'none'"],
            upgradeInsecureRequests: [],
        },
    },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" }
}));

// CORS configuration
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(o => o);
const defaultOrigins = [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175'
];
const origins = allowedOrigins.length > 0 ? allowedOrigins : defaultOrigins;

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps, curl, or same-origin)
        if (!origin) return callback(null, true);

        // Always allow localhost/127.0.0.1 in development
        if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
            return callback(null, true);
        }

        // Check against allowed origins
        const isAllowed = origins.some(o => origin === o || origin.startsWith(o));
        if (isAllowed) {
            callback(null, true);
        } else {
            console.warn(`[CORS_REJECTED] Origin: ${origin}`);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-seller-id', 'x-xsrf-token', 'xsrf-token', 'X-XSRF-TOKEN', 'x-session-id']
}));

// Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 300, // Limit each IP to 300 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

// Data Sanitization against NoSQL Injection
app.use(mongoSanitize());
app.use(cookieParser());

// Custom Security Protections
const { doubleSubmitCookie, csrfProtection, preventParamPollution } = require('./src/middleware/security');
app.use(preventParamPollution);
app.use(doubleSubmitCookie);
app.use(csrfProtection);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Smart Request Logging Middleware
const requestLogger = require('./src/middleware/requestLogger');
app.use(requestLogger);

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

            console.log('✅ Database Connected Successfully');

            // Run migrations
            // Migration code for backfillSellerSettings has been removed as per user request


            if (!listenersRegistered) {
                listenersRegistered = true;

                mongoose.connection.on('error', (err) => {
                    console.error('❌ MongoDB Connection Error:', err.message);
                    if (err.message.includes('ENOTFOUND')) {
                        /*
                        console.error('💡 DNS Resolution Error: Check your MongoDB connection string and network connectivity');
                        console.error('💡 If using MongoDB Atlas, ensure:');
                        console.error('   1. Your IP address is whitelisted in Atlas');
                        console.error('   2. Your network connection is active');
                        console.error('   3. The connection string is correct');
                        */
                    }
                });

                mongoose.connection.on('disconnected', () => {
                    console.warn('⚠️  MongoDB Disconnected. Attempting to reconnect...');
                    setTimeout(() => {
                        connectDB();
                    }, 5000);
                });

                mongoose.connection.on('reconnected', () => {
                    console.log('✅ Database Reconnected');
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

// Global API Response Interceptor to expose isReadOnlyMode status
app.use('/api', (req, res, next) => {
    const originalJson = res.json;
    res.json = function (data) {
        if (data && typeof data === 'object') {
            // Default to false if not set, otherwise use the request's status
            data.isReadOnlyMode = req.isReadOnlyMode === true;
        }
        return originalJson.call(this, data);
    };
    next();
});

// Routes
const syncRoutes = require('./src/routes/sync');
const authRoutes = require('./src/routes/auth');
const adminRoutes = require('./src/routes/admin');
const dataRoutes = require('./src/routes/data');
const planValidityRoutes = require('./src/routes/planValidity');
const refundRoutes = require('./src/routes/refund');
const publicRoutes = require('./src/routes/public');

// Admin Auth Middleware to protect sensitive test routes
const adminAuth = require('./src/middleware/adminAuth');

app.get('/ping', (req, res) => {
    res.send('pong');
});

// Protect test routes
app.get('/api/test-email', adminAuth, async (req, res) => {
    const { sendLoginEmail } = require('./src/utils/emailService');
    try {
        const testEmail = process.env.SMTP_USER;
        if (!testEmail) return res.status(400).json({ success: false, message: 'SMTP_USER not set in .env' });

        // console.log(`🧪 Running email test for: ${testEmail}`);
        await sendLoginEmail(testEmail, 'Test User', '127.0.0.1', 'Test Browser');
        res.json({ success: true, message: 'Test email triggered! Check your terminal for logs.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/test-inventory-email', adminAuth, async (req, res) => {
    const { checkAndSendInventoryAlerts } = require('./src/utils/inventoryAlerts');
    try {
        const sellerId = req.query.sellerId;
        if (!sellerId) return res.status(400).json({ success: false, message: 'sellerId query parameter is required' });

        // console.log(`🧪 Running inventory alert test for seller: ${sellerId}`);
        const result = await checkAndSendInventoryAlerts(sellerId);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/test-expiry-scheduler', adminAuth, async (req, res) => {
    const { runExpiryCheck } = require('./src/utils/expiryScheduler');
    try {
        // console.log(`🧪 Running manual expiry check job...`);
        await runExpiryCheck();
        res.json({ success: true, message: 'Expiry check job triggered! Check server logs.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/plans', planValidityRoutes);
app.use('/api/refunds', refundRoutes);
app.use('/api/expenses', require('./src/routes/expense'));
app.use('/api/settings', require('./src/routes/settings'));
app.use('/api/online-store', require('./src/routes/onlineStoreRoutes'));
app.use('/api/public', publicRoutes);
app.use('/api/targets', require('./src/routes/targetRoutes'));
// Initialize Background Schedulers
const { initExpiryScheduler } = require('./src/utils/expiryScheduler');
initExpiryScheduler();

//('✅ Refund routes registered at /api/refunds');

// Health check endpoint removed - this API is only for testing, not for sellers/staff

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(err.status || 500).json({
        success: false,
        message: err.message || 'Internal Server Error',
        // stack not exposed in production default via checking logic manually if needed, but safe here
        error: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

// Serve Static files for main frontend
app.use(express.static(path.join(__dirname, '../frontend/build')));

// Serve Static files for admin frontend (mount at /admin)
app.use('/admin', express.static(path.join(__dirname, '../admin-frontend/dist'), { fallthrough: true }));

// Serve Admin React app for /admin/* routes
app.get(['/admin', '/admin/*'], (req, res) => {
    // Skip API routes within admin path if any
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ success: false, message: 'API route not found' });
    }

    const indexPath = path.join(__dirname, '../admin-frontend/dist/index.html');
    fs.readFile(indexPath, 'utf8', (err, html) => {
        if (err) {
            return res.status(500).send('Error loading admin panel');
        }

        // Inject nonce into placeholders and all script/style tags
        const nonce = res.locals.nonce;
        const result = html
            .replace(/{{nonce}}/g, nonce)
            .replace(/<script/g, `<script nonce="${nonce}"`)
            .replace(/<style/g, `<style nonce="${nonce}"`);

        res.send(result);
    });
});

// Serve React app for client-side routing
app.get('*', (req, res) => {
    // Skip API routes
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ success: false, message: 'API route not found' });
    }

    const indexPath = path.join(__dirname, '../frontend/build/index.html');
    fs.readFile(indexPath, 'utf8', (err, html) => {
        if (err) {
            return res.status(500).send('Internal Server Error');
        }

        // Inject nonce into placeholders and all script/style tags
        const nonce = res.locals.nonce;
        const result = html
            .replace(/{{nonce}}/g, nonce)
            .replace(/<script/g, `<script nonce="${nonce}"`)
            .replace(/<style/g, `<style nonce="${nonce}"`);

        res.send(result);
    });
});

// 404 handler for API routes
app.use('/api/*', (req, res) => {
    res.status(404).json({ success: false, message: 'API route not found' });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    // console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = app;
