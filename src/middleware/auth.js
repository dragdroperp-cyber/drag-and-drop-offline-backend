const mongoose = require('mongoose');
const Seller = require('../models/Seller');
const EcomCustomer = require('../models/EcomCustomer');
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

/**
 * Middleware to verify e-commerce customer authentication
 */
const verifyCustomer = async (req, res, next) => {
  try {
    const token = req.cookies?.customerToken || req.header('Authorization')?.replace('Bearer ', '');
    const mongoState = mongoose.connection.readyState;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.'
      });
    }

    try {
      const secret = process.env.JWT_SECRET;
      const decoded = jwt.verify(token, secret);
      req.customerId = decoded.id;

      if (mongoState !== 1) {
        return res.status(503).json({
          success: false,
          message: 'Database connection unavailable.'
        });
      }

      const customer = await EcomCustomer.findById(decoded.id);
      if (!customer || !customer.isActive) {
        return res.status(403).json({ success: false, message: 'Account disabled or not found' });
      }
      req.customer = customer;
      next();
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Authentication error'
    });
  }
};

/**
 * Middleware to verify session validity (Multi-device control)
 * Only blocks write operations (POST, PUT, DELETE, PATCH)
 */
const verifySession = async (req, res, next) => {
  try {

    // 1. Identify if this request is inherently read-only (always allowed)
    // Also skip specific POST endpoints that are used for fetching data (don't block the UI)
    const readOnlyPostEndpoints = ['/delta-sync', '/latest-fetch', '/check-session', '/sync'];
    const isReadOnlyPost = readOnlyPostEndpoints.some(ep => req.path.includes(ep) || req.originalUrl.includes(ep));
    const isAllowedReadOnly = req.method === 'GET' || isReadOnlyPost || req.path.includes('/all') || req.originalUrl.includes('/all');

    const seller = req.seller; // Set by verifySeller middleware
    const clientSessionId = req.header('x-session-id');

    // 2. Performance check: if no session control is active on this seller, allow
    if (!seller || !seller.currentSessionId) {
      req.isReadOnlyMode = false;
      return next();
    }

    // 3. Compare session IDs - RESTORED
    if (seller.currentSessionId !== clientSessionId) {
      req.isReadOnlyMode = true;

      // Allow /all to proceed but mark as read-only so data can be fetched
      // AND allow read-only operations (GET / specific POSTs like delta-sync)
      if (isAllowedReadOnly) {
        return next();
      }

      return res.status(403).json({
        success: false,
        message: 'Security restricted: Account is active on another device.',
        error: 'SESSION_INVALIDATED',
        isReadOnlyMode: true
      });
    }

    // Session is valid
    req.isReadOnlyMode = false;

    next();
  } catch (error) {
    console.error('Session validation error:', error);
    next(); // Fail-safe: allow if check fails (optional, but prevents total lockout on server bugs)
  }
};

module.exports = { verifySeller, verifyCustomer, verifySession };
