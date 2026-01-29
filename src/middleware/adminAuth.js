const jwt = require('jsonwebtoken');
const SuperAdmin = require('../models/SuperAdmin');

module.exports = async (req, res, next) => {
    try {
        const token = req.cookies.adminToken || req.header('Authorization')?.replace('Bearer ', '');
        // Check if token exists
        if (!token) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        const secret = process.env.JWT_SECRET;
        if (!secret) {
            console.error('❌ JWT_SECRET is missing in environment variables');
            return res.status(500).json({ success: false, message: 'Server security configuration error' });
        }
        const decoded = jwt.verify(token, secret);

        const admin = await SuperAdmin.findById(decoded.id);

        if (!admin) {
            throw new Error();
        }

        req.admin = admin;
        next();
    } catch (error) {
        res.status(401).json({ success: false, message: 'Please authenticate as admin' });
    }
};
