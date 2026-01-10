const mongoose = require('mongoose');
const Seller = require('../models/Seller');
const jwt = require('jsonwebtoken');
const { logSecurityEvent } = require('../utils/securityLogger');

/**
 * Middleware to verify seller authentication
 * Expects Bearer token in Authorization header
 */
const verifySeller = async (req, res, next) => {
  try {
    // 1. Check for token in cookies or Authorization header
    const token = req.cookies?.token || req.header('Authorization')?.replace('Bearer ', '');

    // Check MongoDB connection state
    const mongoState = mongoose.connection.readyState;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required. Please log in again.'
      });
    }

    // 2. Verify Token
    try {
      const secret = process.env.JWT_SECRET;
      if (!secret) return res.status(500).json({ success: false, message: 'Server configuration error' });
      const decoded = jwt.verify(token, secret);
      req.sellerId = decoded.id;

      // 3. Verify seller existence and status (Strict Mode: DB must be connected)
      if (mongoState !== 1) {
        return res.status(503).json({
          success: false,
          message: 'Service temporarily unavailable (Database Disconnected). Please try again later.'
        });
      }

      const seller = await Seller.findById(decoded.id);
      if (!seller) {
        logSecurityEvent({
          event: 'UNAUTHORIZED_ACCESS',
          message: 'Decoded token ID not found in database',
          req,
          severity: 'HIGH',
          metadata: { decodedId: decoded.id }
        });
        return res.status(404).json({ success: false, message: 'Seller not found' });
      }
      if (!seller.isActive) {
        logSecurityEvent({
          event: 'UNAUTHORIZED_ACCESS',
          message: `Attempted access with inactive account: ${seller.email}`,
          req,
          severity: 'MEDIUM',
          metadata: { sellerId: seller._id }
        });
        return res.status(403).json({ success: false, message: 'Seller account is inactive' });
      }
      req.seller = seller;

      next();
    } catch (err) {
      console.error('JWT Verification Failed:', err.message);
      logSecurityEvent({
        event: 'UNAUTHORIZED_ACCESS',
        message: `Invalid or expired token: ${err.message}`,
        req,
        severity: 'MEDIUM'
      });
      return res.status(401).json({ success: false, message: 'Invalid or expired token', error: err.message });
    }

  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({
      success: false,
      message: 'Authentication error',
      error: error.message
    });
  }
};

module.exports = { verifySeller };
