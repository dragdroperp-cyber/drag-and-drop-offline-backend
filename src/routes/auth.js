const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Seller = require('../models/Seller');
const Plan = require('../models/Plan');
const PlanOrder = require('../models/PlanOrder');
const { verifySeller } = require('../middleware/auth');

/**
 * Sanitize GST number - remove spaces and convert to uppercase
 */
const sanitizeGSTNumber = (gst) => {
  if (!gst) return '';
  return gst.toString().trim().replace(/\s+/g, '').toUpperCase();
};

/**
 * Validate GST number format
 * GST format: 15 characters
 * - 2 digits (state code)
 * - 10 alphanumeric (PAN)
 * - 1 digit (entity number)
 * - 1 letter (Z)
 * - 1 digit (check digit)
 * Example: 27ABCDE1234F1Z5
 */
const isValidGSTNumber = (gst) => {
  if (!gst) return false;
  const sanitized = sanitizeGSTNumber(gst);
  
  // Check length
  if (sanitized.length !== 15) {
    return false;
  }
  
  // Check format: 2 digits + 10 alphanumeric + 1 digit + 1 letter (Z) + 1 digit
  const gstPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
  
  if (!gstPattern.test(sanitized)) {
    return false;
  }
  
  // Additional validation: First 2 digits should be valid state code (01-37, 38-40, 41-42)
  const stateCode = parseInt(sanitized.substring(0, 2), 10);
  if (stateCode < 1 || stateCode > 42) {
    return false;
  }
  
  // Check that 13th character is 'Z'
  if (sanitized.charAt(12) !== 'Z') {
    return false;
  }
  
  return true;
};

const serializeSeller = (seller) => ({
  _id: seller._id,
  name: seller.name,
  email: seller.email,
  profilePicture: seller.profilePicture,
  isActive: seller.isActive,
  lastActivityDate: seller.lastActivityDate,
  upiId: seller.upiId || null,
  shopName: seller.shopName || null,
  businessType: seller.businessType || null,
  shopAddress: seller.shopAddress || null,
  phoneNumber: seller.phoneNumber || null,
  city: seller.city || null,
  state: seller.state || null,
  pincode: seller.pincode || null,
  gender: seller.gender || null,
  gstNumber: seller.gstNumber || null,
  businessCategory: seller.businessCategory || null,
  lowStockThreshold: seller.lowStockThreshold || 10,
  expiryDaysThreshold: seller.expiryDaysThreshold || 7,
  profileCompleted: seller.profileCompleted || false
});

/**
 * Get or create seller by email (for Firebase auth integration)
 * Creates seller entry for new users, verifies existing users
 */
router.post('/seller', async (req, res) => {
  try {
    const { email, uid, displayName, photoURL } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    // Check MongoDB connection before proceeding
    const mongoState = mongoose.connection.readyState;
    if (mongoState !== 1) {
      console.error('❌ MongoDB not connected. Connection state:', mongoState);
      return res.status(503).json({
        success: false,
        message: 'Database connection unavailable. Please try again later.',
        error: 'MongoDB connection not established'
      });
    }

    // Find existing seller by email
    let seller = await Seller.findOne({ email });

    if (!seller) {
      // New user - create seller entry automatically
      const sellerName = displayName || email.split('@')[0];
      seller = new Seller({
        name: sellerName,
        email: email,
        profilePicture: photoURL || null,
        isActive: true,
        lastActivityDate: new Date()
      });
      
      try {
        await seller.save();
        console.log(`✅ Created new seller: ${sellerName} (${email})`);
      } catch (saveError) {
        console.error('❌ Error saving new seller:', saveError);
        // Check if it's a duplicate email error
        if (saveError.code === 11000) {
          // Email already exists - try to fetch the existing seller
          seller = await Seller.findOne({ email });
          if (seller) {
            console.log(`ℹ️  Seller already exists, using existing seller: ${sellerName} (${email})`);
          } else {
            throw new Error('Failed to create seller and seller not found');
          }
        } else {
          throw saveError;
        }
      }

      // Assign free plan to new seller (non-blocking - seller creation succeeds even if plan assignment fails)
      try {
        // Find the free plan (price = 0) or the cheapest active plan
        const freePlan = await Plan.findOne({ 
          isActive: true,
          price: 0 
        }).sort({ price: 1 });

        // If no free plan exists, get the cheapest plan as default
        const defaultPlan = freePlan || await Plan.findOne({ 
          isActive: true 
        }).sort({ price: 1 });

        if (defaultPlan) {
          // Calculate expiry date based on plan duration
          const expiryDate = new Date();
          expiryDate.setDate(expiryDate.getDate() + (defaultPlan.durationDays || 30));

          // Create a PlanOrder for the free plan
          const isFreePlan = (defaultPlan.price || 0) === 0;

          const planOrder = new PlanOrder({
            sellerId: seller._id,
            planId: defaultPlan._id,
            expiryDate: expiryDate,
            durationDays: defaultPlan.durationDays || 30,
            price: defaultPlan.price || 0,
            paymentStatus: isFreePlan ? 'completed' : 'pending',
            status: isFreePlan ? 'active' : 'paused',
            lastActivatedAt: isFreePlan ? new Date() : null,
            accumulatedUsedMs: 0,
            customerLimit: defaultPlan.maxCustomers ?? null,
            productLimit: defaultPlan.maxProducts ?? null,
            orderLimit: defaultPlan.maxOrders ?? null,
            customerCurrentCount: 0,
            productCurrentCount: 0,
            orderCurrentCount: 0
          });
          
          try {
            await planOrder.save();
            
            // Update seller with currentPlanId
            seller.currentPlanId = planOrder._id;
            await seller.save();
            
            // Refresh seller from database to ensure we have the latest state
            seller = await Seller.findById(seller._id);
            
            console.log(`✅ Assigned free plan "${defaultPlan.name}" to new seller: ${sellerName}`);
          } catch (planOrderError) {
            console.error('❌ Error saving plan order or updating seller:', planOrderError);
            // Refresh seller from database to get clean state
            seller = await Seller.findById(seller._id);
            console.log(`⚠️  Seller created but plan assignment failed: ${sellerName}`);
          }
        } else {
          console.warn(`⚠️  No active plans found in database. Seller created without plan: ${sellerName}`);
        }
      } catch (planError) {
        // Log error but don't fail seller creation if plan assignment fails
        console.error('❌ Error in plan assignment process:', planError);
        console.error('Plan error stack:', planError.stack);
        // Refresh seller from database to ensure we have clean state
        try {
          seller = await Seller.findById(seller._id);
        } catch (refreshError) {
          console.error('❌ Error refreshing seller after plan assignment failure:', refreshError);
        }
        console.log(`⚠️  Seller created without plan assignment: ${sellerName}`);
      }
    } else {
      // Existing seller - check if account is active
      if (!seller.isActive) {
        console.log(`❌ Access denied: Seller account is inactive for ${email}`);
        return res.status(403).json({
          success: false,
          message: 'Your account has been deactivated. Please contact administrator.',
          seller: null
        });
      }

      // Update existing seller with latest info (name, profile picture, last activity)
      let updated = false;
      if (displayName && seller.name !== displayName) {
        seller.name = displayName;
        updated = true;
      }
      if (photoURL && seller.profilePicture !== photoURL) {
        seller.profilePicture = photoURL;
        updated = true;
      }
      seller.lastActivityDate = new Date();
      
      if (updated) {
        await seller.save();
        console.log(`✅ Updated seller info: ${seller.name} (${email})`);
      } else {
        await seller.save(); // Still save to update lastActivityDate
        console.log(`✅ Seller authenticated: ${seller.name} (${email})`);
      }
    }
    // Ensure seller exists and is fresh from database before serialization
    if (!seller) {
      console.error('❌ Seller is null or undefined after creation/update');
      throw new Error('Seller not found after creation/update');
    }

    if (!seller._id) {
      console.error('❌ Seller does not have a valid _id:', seller);
      throw new Error('Invalid seller data');
    }

    try {
      // Refresh seller from database to ensure we have the latest state
      seller = await Seller.findById(seller._id);
      if (!seller) {
        throw new Error('Seller not found in database after refresh');
      }
    } catch (refreshError) {
      console.error('❌ Error refreshing seller before serialization:', refreshError);
      console.error('Refresh error stack:', refreshError.stack);
      throw new Error('Failed to retrieve seller data from database');
    }

    const serializedSeller = serializeSeller(seller);
    
    console.log('\n✅ LOGIN SUCCESS - Sending seller data to frontend:');
    console.log('  name:', serializedSeller.name);
    console.log('  email:', serializedSeller.email);
    console.log('  shopName:', serializedSeller.shopName);
    console.log('  phoneNumber:', serializedSeller.phoneNumber);
    console.log('  city:', serializedSeller.city);
    console.log('  pincode:', serializedSeller.pincode);
    console.log('  businessCategory:', serializedSeller.businessCategory);
    console.log('  lowStockThreshold:', serializedSeller.lowStockThreshold);
    console.log('  expiryDaysThreshold:', serializedSeller.expiryDaysThreshold);

    res.json({
      success: true,
      seller: serializedSeller
    });
  } catch (error) {
    console.error('❌ Auth route error:', error);
    console.error('Error stack:', error.stack);
    
    // Handle specific error types
    if (error.name === 'MongoServerSelectionError' || error.message.includes('ENOTFOUND')) {
      return res.status(503).json({
        success: false,
        message: 'Database connection unavailable. Please check your connection and try again.',
        error: 'MongoDB connection error'
      });
    }
    
    if (error.name === 'MongoError' && error.code === 11000) {
      // Duplicate key error (email already exists)
      const field = Object.keys(error.keyPattern || {})[0];
      return res.status(409).json({
        success: false,
        message: field === 'email' 
          ? 'An account with this email already exists. Please sign in instead.'
          : 'This account already exists. Please sign in instead.',
        error: 'Duplicate entry'
      });
    }
    
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid data provided. Please check your information and try again.',
        error: error.message
      });
    }
    
    // Generic error response with more details in development
    const errorMessage = process.env.NODE_ENV === 'development' 
      ? `Error authenticating seller: ${error.message}`
      : 'Unable to authenticate. Please try again or contact support if the problem persists.';
    
    res.status(500).json({
      success: false,
      message: errorMessage,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Demo account login for Razorpay team
 * Creates or retrieves a demo account for testing purposes
 */
router.post('/demo/razorpay', async (req, res) => {
  try {
    const demoEmail = 'demo@razorpay.com';
    const demoName = 'Razorpay Demo Account';
    const demoUid = 'razorpay-demo-uid-' + Date.now();

    // Check MongoDB connection
    const mongoState = mongoose.connection.readyState;
    if (mongoState !== 1) {
      console.error('❌ MongoDB not connected. Connection state:', mongoState);
      return res.status(503).json({
        success: false,
        message: 'Database connection unavailable. Please try again later.',
        error: 'MongoDB connection not established'
      });
    }

    // Find or create demo seller
    let seller = await Seller.findOne({ email: demoEmail });

    if (!seller) {
      // Create demo seller
      seller = new Seller({
        name: demoName,
        email: demoEmail,
        profilePicture: null,
        isActive: true,
        lastActivityDate: new Date(),
        shopName: 'Razorpay Demo Store',
        phoneNumber: '9999999999',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400001',
        profileCompleted: true
      });

      try {
        await seller.save();
        console.log(`✅ Created Razorpay demo account: ${demoName} (${demoEmail})`);

        // Assign free plan to demo account
        try {
          const freePlan = await Plan.findOne({ 
            isActive: true,
            price: 0 
          }).sort({ price: 1 });

          const defaultPlan = freePlan || await Plan.findOne({ 
            isActive: true 
          }).sort({ price: 1 });

          if (defaultPlan) {
            const expiryDate = new Date();
            expiryDate.setDate(expiryDate.getDate() + (defaultPlan.durationDays || 365)); // 1 year for demo

            const planOrder = new PlanOrder({
              sellerId: seller._id,
              planId: defaultPlan._id,
              expiryDate: expiryDate,
              durationDays: defaultPlan.durationDays || 365,
              price: defaultPlan.price || 0,
              paymentStatus: 'completed',
              status: 'active',
              lastActivatedAt: new Date(),
              accumulatedUsedMs: 0,
              customerLimit: defaultPlan.maxCustomers ?? null,
              productLimit: defaultPlan.maxProducts ?? null,
              orderLimit: defaultPlan.maxOrders ?? null,
              customerCurrentCount: 0,
              productCurrentCount: 0,
              orderCurrentCount: 0
            });

            await planOrder.save();
            seller.currentPlanId = planOrder._id;
            await seller.save();
            console.log(`✅ Assigned plan "${defaultPlan.name}" to Razorpay demo account`);
          }
        } catch (planError) {
          console.error('❌ Error assigning plan to demo account:', planError);
        }
      } catch (saveError) {
        console.error('❌ Error saving demo seller:', saveError);
        if (saveError.code === 11000) {
          seller = await Seller.findOne({ email: demoEmail });
        } else {
          throw saveError;
        }
      }
    } else {
      // Update last activity for existing demo account
      seller.lastActivityDate = new Date();
      await seller.save();
      console.log(`✅ Razorpay demo account accessed: ${demoName} (${demoEmail})`);
    }

    // Refresh seller from database
    seller = await Seller.findById(seller._id);
    if (!seller) {
      throw new Error('Demo seller not found after creation');
    }

    const serializedSeller = serializeSeller(seller);

    console.log('\n✅ RAZORPAY DEMO LOGIN SUCCESS:');
    console.log('  name:', serializedSeller.name);
    console.log('  email:', serializedSeller.email);

    res.json({
      success: true,
      seller: serializedSeller,
      isDemo: true
    });
  } catch (error) {
    console.error('❌ Razorpay demo login error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating demo account',
      error: error.message
    });
  }
});

/**
 * Update seller profile details (registration)
 */
/**
 * Update seller profile (registration form completion)
 */
router.put('/seller/profile', verifySeller, async (req, res) => {
  try {
    console.log('📝 Registration form submission received');
    console.log('Seller ID from middleware:', req.sellerId);
    console.log('Request body:', req.body);

    const {
      shopName,
      businessType,
      shopAddress,
      phoneNumber,
      city,
      state,
      pincode,
      upiId,
      gstNumber,
      gender
    } = req.body;

    // Validate required fields
    const requiredFields = {
      shopName,
      businessType,
      shopAddress,
      phoneNumber,
      city,
      state,
      pincode,
      upiId,
      gender
    };

    const missingFields = Object.entries(requiredFields)
      .filter(([, value]) => value === null || value === undefined || value === '')
      .map(([key]) => key);

    if (missingFields.length > 0) {
      console.log('❌ Missing required fields:', missingFields);
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missingFields.join(', ')}`
      });
    }

    // Get seller from middleware or find by ID
    const sellerId = req.seller?._id?.toString() || req.sellerId;
    if (!sellerId) {
      console.log('❌ Seller not found, sellerId:', req.sellerId);
      return res.status(404).json({
        success: false,
        message: 'Seller not found. Please log in again.'
      });
    }

    const seller = req.seller || await Seller.findById(sellerId);

    if (!seller) {
      console.log('❌ Seller not found when fetching by ID:', sellerId);
      return res.status(404).json({
        success: false,
        message: 'Seller not found. Please log in again.'
      });
    }

    console.log('✅ Seller found:', seller.email);

    // Sanitize and update fields
    const sanitizedPhone = (phoneNumber || '').toString().replace(/\D/g, '').slice(-10);
    const sanitizedPincode = (pincode || '').toString().replace(/\D/g, '').slice(0, 6);

    // Validate and sanitize GST number if provided (optional field)
    let sanitizedGST = null;
    if (gstNumber && gstNumber.trim()) {
      sanitizedGST = sanitizeGSTNumber(gstNumber);
      if (!isValidGSTNumber(sanitizedGST)) {
        console.log('❌ Invalid GST number format:', gstNumber);
        return res.status(400).json({
          success: false,
          message: 'Invalid GST number format. Please enter a valid 15-character GSTIN (e.g., 27ABCDE1234F1Z5)'
        });
      }
    }

    // Check for duplicate phone number (if phone number is being changed)
    if (sanitizedPhone && seller.phoneNumber !== sanitizedPhone) {
      const existingSellerWithPhone = await Seller.findOne({
        phoneNumber: sanitizedPhone,
        _id: { $ne: sellerId } // Exclude current seller
      });

      if (existingSellerWithPhone) {
        console.log('❌ Phone number already registered:', sanitizedPhone);
        return res.status(400).json({
          success: false,
          message: 'This mobile number is already registered with another account. Please use a different number.'
        });
      }
    }

    // Check for duplicate email (if email is being changed - though email shouldn't change in registration)
    // This is a safety check
    const emailFromBody = req.body.email || seller.email;
    if (emailFromBody && seller.email !== emailFromBody) {
      const existingSellerWithEmail = await Seller.findOne({
        email: emailFromBody,
        _id: { $ne: sellerId }
      });

      if (existingSellerWithEmail) {
        console.log('❌ Email already registered:', emailFromBody);
        return res.status(400).json({
          success: false,
          message: 'This email is already registered with another account.'
        });
      }
    }

    const updatePayload = {
      shopName: shopName.trim(),
      businessType: businessType.trim(),
      shopAddress: shopAddress.trim(),
      phoneNumber: sanitizedPhone || phoneNumber,
      city: city.trim(),
      state: state.trim(),
      pincode: sanitizedPincode || pincode,
      upiId: upiId.trim(),
      gstNumber: sanitizedGST,
      gender,
      profileCompleted: true,
      lastActivityDate: new Date()
    };

    console.log('💾 Saving seller profile with payload:', updatePayload);

    try {
      const updatedSeller = await Seller.findByIdAndUpdate(
        sellerId,
        { $set: updatePayload },
        { new: true, runValidators: true }
      );

      if (!updatedSeller) {
        console.log('❌ Failed to update seller profile for ID:', sellerId);
        return res.status(500).json({
          success: false,
          message: 'Unable to update seller profile'
        });
      }

      console.log('✅ Seller profile saved successfully');

      const serializedSeller = serializeSeller(updatedSeller);

      res.json({
        success: true,
        message: 'Profile updated successfully',
        data: {
          seller: serializedSeller
        }
      });
    } catch (error) {
      console.error('❌ Seller profile update error:', error);
      
      // Handle duplicate key error (from unique index)
      if (error.code === 11000) {
        const field = Object.keys(error.keyPattern || {})[0];
        if (field === 'phoneNumber') {
          return res.status(400).json({
            success: false,
            message: 'This mobile number is already registered with another account. Please use a different number.'
          });
        } else if (field === 'email') {
          return res.status(400).json({
            success: false,
            message: 'This email is already registered with another account.'
          });
        }
      }
      
      res.status(500).json({
        success: false,
        message: 'Unable to update seller profile',
        error: error.message
      });
    }
  } catch (error) {
    console.error('❌ Seller profile update error (outer catch):', error);
    res.status(500).json({
      success: false,
      message: 'Unable to update seller profile',
      error: error.message
    });
  }
});

module.exports = router;

