const mongoose = require('mongoose');
const Seller = require('../models/Seller');

/**
 * Middleware to verify seller authentication
 * Expects sellerId in request body or query params
 */
const verifySeller = async (req, res, next) => {
  try {
    console.log('verifySeller middleware - headers:', req.headers);
    console.log('verifySeller middleware - x-seller-id:', req.headers['x-seller-id']);
    console.log('verifySeller middleware - all sellerId sources:', {
      body: req.body.sellerId,
      query: req.query.sellerId,
      header: req.headers['x-seller-id']
    });

    // Check MongoDB connection first
    const mongoState = mongoose.connection.readyState;
    if (mongoState !== 1) { // 1 = connected
      console.warn('⚠️  MongoDB not connected, skipping seller verification');
      // Allow request to proceed if MongoDB is not connected (for offline mode)
      // Extract sellerId from request but don't verify
      const sellerId = req.body.sellerId || req.query.sellerId || req.headers['x-seller-id'];
      console.log('Offline mode - extracted sellerId:', sellerId);
      if (sellerId) {
        req.sellerId = sellerId;
      }
      return next();
    }

    const sellerId = req.body.sellerId || req.query.sellerId || req.headers['x-seller-id'];
    console.log('Normal mode - extracted sellerId:', sellerId);
    console.log('Normal mode - sellerId truthy check:', !!sellerId);
    
    if (!sellerId) {
      return res.status(401).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    // Verify seller exists and is active
    try {
      const seller = await Seller.findById(sellerId);
      
      if (!seller) {
        return res.status(404).json({
          success: false,
          message: 'Seller not found'
        });
      }

      if (!seller.isActive) {
        return res.status(403).json({
          success: false,
          message: 'Seller account is inactive'
        });
      }

      // Attach seller to request for use in controllers
      req.seller = seller;
      req.sellerId = sellerId;
      next();
    } catch (dbError) {
      // Handle MongoDB-specific errors
      if (dbError.name === 'MongoServerSelectionError' || dbError.message.includes('ENOTFOUND')) {
        console.error('❌ MongoDB connection error in auth middleware:', dbError.message);
        // Allow request to proceed if MongoDB is unreachable (offline mode)
        req.sellerId = sellerId;
        return next();
      }
      throw dbError; // Re-throw other errors
    }
  } catch (error) {
    console.error('Auth middleware error:', error);
    
    // If it's a MongoDB connection error, allow request to proceed
    if (error.name === 'MongoServerSelectionError' || error.message.includes('ENOTFOUND')) {
      const sellerId = req.body.sellerId || req.query.sellerId || req.headers['x-seller-id'];
      if (sellerId) {
        req.sellerId = sellerId;
      }
      return next();
    }
    
    res.status(500).json({
      success: false,
      message: 'Authentication error',
      error: error.message
    });
  }
};

module.exports = { verifySeller };

