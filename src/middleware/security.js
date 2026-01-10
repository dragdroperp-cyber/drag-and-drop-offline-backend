const crypto = require('crypto');

/**
 * Security Middleware Collection
 */

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(o => o);
const trustedOrigins = allowedOrigins.length > 0 ? allowedOrigins : [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175'
];

/**
 * Double Submit Cookie Middleware
 * Sets a non-httpOnly cookie that the client must send back in a header
 */
const doubleSubmitCookie = (req, res, next) => {
    // Generate token if not exists
    if (!req.cookies['XSRF-TOKEN']) {
        const token = crypto.randomBytes(32).toString('hex');
        const isProduction = process.env.NODE_ENV === 'production';

        res.cookie('XSRF-TOKEN', token, {
            httpOnly: false, // Must be readable by frontend JS
            secure: isProduction || isSecure,
            sameSite: isProduction ? 'none' : 'lax',
            domain: process.env.COOKIE_DOMAIN || undefined,
            path: '/', // Crucial: make it visible to all paths
            maxAge: 24 * 60 * 60 * 1000 // 1 day
        });
    }
    next();
};

/**
 * Enhanced CSRF protection using Origin check AND Double Submit Cookie
 */
const csrfProtection = (req, res, next) => {
    // Skip for safe methods
    const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
    if (safeMethods.includes(req.method)) {
        return next();
    }

    // Skip for Auth routes (login/signup) and publicly accessible webhooks
    if (req.path.startsWith('/api/auth') || req.path.startsWith('/api/plans/verify')) {
        return next();
    }

    // 1. Origin/Referer Check
    const origin = req.headers.origin || req.headers.referer;

    if (!origin) {
        return res.status(403).json({
            success: false,
            message: 'Cross-Origin request blocked. Missing Origin/Referer header.'
        });
    }

    const isTrusted = trustedOrigins.some(trusted => origin.startsWith(trusted));

    if (!isTrusted) {
        console.warn(`[CSRF_ATTEMPT] Blocked request from untrusted origin: ${origin}`);
        return res.status(403).json({
            success: false,
            message: 'Cross-Origin request blocked. Security violation.'
        });
    }

    // 2. Double Submit Cookie Check
    const cookieToken = req.cookies['XSRF-TOKEN'];
    const headerToken = req.headers['x-xsrf-token'];

    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
        console.warn(`[CSRF_ATTEMPT] Token mismatch. Cookie: ${!!cookieToken}, Header: ${!!headerToken}`);
        return res.status(403).json({
            success: false,
            message: 'CSRF token validation failed.'
        });
    }

    next();
};

/**
 * Prevent Parameter Pollution
 * (Simple implementation to ensure certain query params aren't arrays)
 */
const preventParamPollution = (req, res, next) => {
    const sensitiveParams = ['id', 'sellerId', 'email', 'token'];
    for (const param of sensitiveParams) {
        if (req.query[param] && Array.isArray(req.query[param])) {
            req.query[param] = req.query[param][0];
        }
    }
    next();
};

module.exports = {
    doubleSubmitCookie,
    csrfProtection,
    preventParamPollution
};
