const mongoose = require('mongoose');
const Seller = require('../models/Seller');
const jwt = require('jsonwebtoken');

/**
 * Middleware to verify seller authentication
 * Expects Bearer token in Authorization header
 */
const verifySeller = async (req, res, next) => {
  try {
    // 1. Check for Authorization header
    const token = req.header('Authorization')?.replace('Bearer ', '');

    // Allow x-seller-id ONLY for transition/testing if explicitly enabled via env (e.g., development)
    // But for security, we prioritize JWT.

    // Check MongoDB connection state
    const mongoState = mongoose.connection.readyState;

    // If no token, check if we allow legacy x-seller-id (DEPRECATED - Should be removed for full security)
    if (!token) {
      // Strict Security Mode: Reject if no token
      // However, to avoid immediate breakage during transition, we might inspect x-seller-id
      // But since we fixed the Login flow to provide tokens, and Frontend to send them,
      // we should enforce tokens to actually fix the "Identity Spoofing" vulnerability.

      // Exception: If we are in "Offline Mode" and have no token, relying on x-seller-id is essentially unavoidable
      // unless we persisted the token mechanism correctly locally (which the frontend does).
      // So even in offline mode, we should expect a token if the user was logged in.

      // If the user was logged in before this update, they won't have a token. They will be logged out.
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
        return res.status(404).json({ success: false, message: 'Seller not found' });
      }
      if (!seller.isActive) {
        return res.status(403).json({ success: false, message: 'Seller account is inactive' });
      }
      req.seller = seller;

      next();
    } catch (err) {
      console.error('JWT Verification Failed:', err.message);
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
