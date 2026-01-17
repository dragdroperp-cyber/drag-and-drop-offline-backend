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
    // Get existing token or generate new one
    let token = req.cookies['XSRF-TOKEN'];
    if (!token) {
        token = crypto.randomBytes(32).toString('hex');
    }

    const isProduction = process.env.NODE_ENV === 'production';

    // Always set the cookie to ensure correct flags (especially httpOnly: false)
    // This fixes issues where a client might have a stale httpOnly cookie
    res.cookie('XSRF-TOKEN', token, {
        httpOnly: false, // Must be readable by frontend JS
        secure: isProduction || req.secure,
        sameSite: isProduction ? 'none' : 'lax',
        domain: process.env.COOKIE_DOMAIN || undefined,
        path: '/', // Crucial: make it visible to all paths
        maxAge: 24 * 60 * 60 * 1000 // 1 day
    });

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
    if (req.path.startsWith('/api/auth') ||
        req.path.startsWith('/api/plans/verify') ||
        req.path.startsWith('/api/public') ||
        req.path.includes('/online-store/public')) {
        return next();
    }

    // 1. Origin/Referer Check
    let origin = req.headers.origin || req.headers.referer;

    // Normalize origin (remove trailing slash)
    if (origin && origin.endsWith('/')) {
        origin = origin.slice(0, -1);
    }

    if (!origin) {
        console.warn(`[CSRF_BLOCK] Missing Origin/Referer for ${req.method} ${req.path}`);
        return res.status(403).json({
            success: false,
            message: 'Cross-Origin request blocked. Missing Origin/Referer header.'
        });
    }

    const isTrusted = trustedOrigins.some(trusted => {
        const normalizedTrusted = trusted.endsWith('/') ? trusted.slice(0, -1) : trusted;
        return origin === normalizedTrusted || origin.startsWith(normalizedTrusted);
    });

    if (!isTrusted) {
        console.warn(`[CSRF_BLOCK] Untrusted origin: ${origin}. Trusted: ${trustedOrigins.join(', ')}`);
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
