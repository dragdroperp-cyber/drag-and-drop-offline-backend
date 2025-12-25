const jwt = require('jsonwebtoken');
const SuperAdmin = require('../models/SuperAdmin');

module.exports = async (req, res, next) => {
    try {
        const token = req.header('Authorization')?.replace('Bearer ', '');
        // Check if token exists
        if (!token) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        const secret = process.env.JWT_SECRET || 'hariommodiisthekey';
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
