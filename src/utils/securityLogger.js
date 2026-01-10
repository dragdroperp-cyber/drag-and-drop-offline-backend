const SecurityLog = require('../models/SecurityLog');

/**
 * Log a security-related event to the database
 */
const logSecurityEvent = async (data) => {
    try {
        const {
            sellerId,
            event,
            message,
            req, // Optional: if provided, extract info from request
            severity = 'LOW',
            metadata = {}
        } = data;

        let ipAddress = data.ipAddress;
        let userAgent = data.userAgent;
        let path = data.path;
        let method = data.method;

        if (req) {
            ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown';
            userAgent = req.headers['user-agent'] || 'Unknown';
            path = req.originalUrl;
            method = req.method;
        }

        const log = new SecurityLog({
            sellerId,
            event,
            message,
            ipAddress,
            userAgent,
            path,
            method,
            severity,
            metadata
        });

        await log.save();

        // Log to console as well for immediate visibility
        const consoleMethod = severity === 'CRITICAL' || severity === 'HIGH' ? 'error' : 'warn';
        // console[consoleMethod](`[SECURITY_${event}] ${message} | IP: ${ipAddress} | User: ${sellerId || 'Guest'}`);

    } catch (error) {
        console.error('Error recording security log:', error.message);
    }
};

module.exports = { logSecurityEvent };
