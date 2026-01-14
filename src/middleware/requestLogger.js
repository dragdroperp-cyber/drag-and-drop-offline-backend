const RequestLog = require('../models/RequestLog');

const requestLogger = (req, res, next) => {
    const start = Date.now();

    // List of paths to exclude from ANY logging (console or DB)
    // Note: 'login' is handled specially based on status code
    const excludedPaths = [
        '/health',
        '/ping',
        '/status',
        '/favicon',
        '/static',
        '/assets',
        '/public',
        '/sync',
        '/heartbeat',
        '/polling',
        '/metrics',
        '/analytics',
        '/refresh-token',
        '/logout',
        '/verify-token',
        '/captcha',
        '/robots',
        '/sitemap'
    ];

    res.on('finish', () => {
        const duration = Date.now() - start;
        const { method, originalUrl, url } = req;
        const path = originalUrl || url;
        const statusCode = res.statusCode;

        // Check availability of user ID from common auth middleware locations
        const userId = req.user?._id || req.user?.id || req.userId || null;

        // 1. Check exclusions
        const isExcludedPath = excludedPaths.some(excluded => path.includes(excluded));

        // Special case: /login ignored only if successful (200)
        const isSuccessfulLogin = path.includes('/login') && statusCode === 200;

        if (isExcludedPath || isSuccessfulLogin) {
            return; // Skip logging entirely
        }

        // 2. Determine if we should save to MongoDB
        const isError = statusCode >= 500;
        const isAuthError = statusCode === 401 || statusCode === 403;
        const isCriticalPath = ['payment', 'order', 'admin'].some(keyword =>
            path.toLowerCase().includes(keyword)
        );

        const shouldSaveToDB = isError || isAuthError || isCriticalPath;

        // 3. Log to Console (Normal Logging)
        // console.log(`${method} ${path} ${statusCode} ${duration}ms${userId ? ` User:${userId}` : ''} ${shouldSaveToDB ? '[SAVED]' : ''}`);

        // 4. Save to MongoDB if criteria met
        if (shouldSaveToDB) {
            RequestLog.create({
                method,
                path,
                statusCode,
                responseTime: duration,
                userId: userId ? String(userId) : undefined
            }).catch(() => { /* Logging failed silently */ });
        }
    });

    next();
};

module.exports = requestLogger;
