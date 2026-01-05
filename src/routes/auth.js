const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Seller = require('../models/Seller');
const Plan = require('../models/Plan');
const PlanOrder = require('../models/PlanOrder');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Transaction = require('../models/Transaction');
const VendorOrder = require('../models/VendorOrder');
const SyncTracking = require('../models/SyncTracking');
const Refund = require('../models/Refund');
const ProductCategory = require('../models/ProductCategory');
const InviteToken = require('../models/InviteToken');
const { verifySeller } = require('../middleware/auth');
const { formatRemaining } = require('../utils/planTimers');
const { setActivePlanForSeller } = require('../controllers/planValidity');
const { sendLoginEmail } = require('../utils/emailService');

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

  // Check format: 2 digits + 10 alphanumeric (PAN) + 1 digit + Z + 1 digit
  const gstPattern = /^[0-9]{2}[A-Z0-9]{10}[0-9]{1}Z[0-9]{1}$/;

  if (!gstPattern.test(sanitized)) {
    return false;
  }

  // Additional validation: First 2 digits should be valid state code (01-37, 38-40, 41-42)
  const stateCode = parseInt(sanitized.substring(0, 2), 10);
  if (stateCode < 1 || stateCode > 42) {
    return false;
  }

  // Check that 14th character is 'Z'
  if (sanitized.charAt(13) !== 'Z') {
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
 * Get current authenticated seller information
 */
router.get('/seller', verifySeller, async (req, res) => {
  try {
    const sellerId = req.sellerId;
    //('🔍 GET SELLER INFO - Seller ID:', sellerId);

    if (!sellerId) {
      return res.status(401).json({
        success: false,
        message: 'Seller not authenticated'
      });
    }

    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({
        success: false,
        message: 'Seller not found'
      });
    }

    //('✅ Seller found:', seller.name, seller.email);

    res.json({
      success: true,
      seller: {
        _id: seller._id,
        name: seller.name,
        email: seller.email,
        profileCompleted: seller.profileCompleted,
        shopName: seller.shopName,
        phoneNumber: seller.phoneNumber,
        address: seller.address,
        gstNumber: seller.gstNumber,
        profilePicture: seller.profilePicture,
        isActive: seller.isActive,
        createdAt: seller.createdAt,
        lastActivityDate: seller.lastActivityDate
      }
    });
  } catch (error) {
    // Error getting seller info suppressed
    res.status(500).json({
      success: false,
      message: 'Error retrieving seller information',
      error: error.message
    });
  }
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

    //('🔐 SELLER AUTHENTICATION STARTED');
    //('📧 Email:', email);
    //('🆔 UID:', uid);

    // Find existing seller by email
    //('🔍 Looking for seller account...');
    let seller = await Seller.findOne({ email });
    let isNewSeller = false;

    if (!seller) {
      //('📝 No seller account found - creating new seller account for:', email);

      // Create new seller account
      seller = new Seller({
        name: displayName || email.split('@')[0], // Use display name or email prefix as name
        email: email,
        profilePicture: photoURL || null,
        isActive: true,
        lastActivityDate: new Date(),
        shopName: `${displayName || email.split('@')[0]}'s Store`, // Default shop name
        profileCompleted: false, // Mark as incomplete so they complete their profile
        firebaseUid: uid // Store Firebase UID for future reference
      });

      try {
        await seller.save();
        //(`✅ Created new seller account: ${seller.name} (${seller.email})`);
        isNewSeller = true;

        // Assign free plan to new seller
        try {
          //('🔍 Looking for free plan for new seller...');

          const freePlan = await Plan.findOne({
            isActive: true,
            price: 0
          }).sort({ price: 1 });

          //('📋 Free plan found:', freePlan ? freePlan.name : 'None');

          const defaultPlan = freePlan || await Plan.findOne({
            isActive: true
          }).sort({ price: 1 });

          //('📋 Default plan selected:', defaultPlan ? `${defaultPlan.name} (${defaultPlan.price})` : 'None');

          if (defaultPlan) {
            const expiryDate = new Date();
            expiryDate.setDate(expiryDate.getDate() + (defaultPlan.durationDays || 30)); // 30 days trial

            //('📅 Plan expiry date:', expiryDate.toISOString());

            const planOrder = new PlanOrder({
              sellerId: seller._id,
              planId: defaultPlan._id,
              price: defaultPlan.price,
              durationDays: defaultPlan.durationDays || 30,
              currency: 'INR',
              status: 'active',
              expiryDate: expiryDate,
              features: defaultPlan.features || {},
              paymentMethod: 'trial',
              isTrial: true,
              paymentStatus: 'completed', // Free trial, no payment needed
              lastActivatedAt: new Date(), // Activate immediately
              accumulatedUsedMs: 0, // Start with no usage
              customerLimit: defaultPlan?.maxCustomers ?? 10,
              productLimit: defaultPlan?.maxProducts ?? 10,
              orderLimit: defaultPlan?.maxOrders ?? 10,
              customerCurrentCount: 0,
              productCurrentCount: 0,
              orderCurrentCount: 0
            });

            const savedPlanOrder = await planOrder.save();
            //('💾 PlanOrder saved with ID:', savedPlanOrder._id);

            // Update sync tracking for trial plan assignment during signup
            try {
              await SyncTracking.updateLatestTime(seller._id, 'planOrders');
              //(`🔄 Sync tracking updated: planOrders for trial plan assignment ${savedPlanOrder._id}`);
            } catch (trackingError) {
              console.error('Error updating sync tracking for trial plan assignment:', trackingError);
            }

            seller.currentPlanId = planOrder._id;
            await seller.save();

            //(`✅ Assigned ${freePlan ? 'free' : 'trial'} plan "${defaultPlan.name}" to seller: ${seller.name}`);
            //(`📋 Seller currentPlanId set to: ${seller.currentPlanId}`);
          } else {
            // Create a default free plan if no plans exist
            //('🚨 No plans found - creating default free plan...');

            const defaultFreePlan = new Plan({
              name: 'Free Plan',
              description: 'Default free plan for new sellers',
              price: 0,
              currency: 'INR',
              durationDays: 30,
              isActive: true,
              features: {
                products: 10,
                orders: 50,
                staff: 1,
                storage: '1GB',
                support: 'basic'
              },
              createdAt: new Date(),
              updatedAt: new Date()
            });

            const savedPlan = await defaultFreePlan.save();
            //('✅ Created default free plan:', savedPlan.name);

            // Now assign this plan to the seller
            const expiryDate = new Date();
            expiryDate.setDate(expiryDate.getDate() + savedPlan.durationDays);

            const planOrder = new PlanOrder({
              sellerId: seller._id,
              planId: savedPlan._id,
              price: savedPlan.price,
              durationDays: savedPlan.durationDays,
              currency: 'INR',
              status: 'active',
              expiryDate: expiryDate,
              features: savedPlan.features,
              paymentMethod: 'trial',
              isTrial: true,
              paymentStatus: 'completed', // Free trial, no payment needed
              lastActivatedAt: new Date(), // Activate immediately
              accumulatedUsedMs: 0, // Start with no usage
              customerLimit: savedPlan.features?.maxCustomers ?? null,
              productLimit: savedPlan.features?.maxProducts ?? null,
              orderLimit: savedPlan.features?.maxOrders ?? null,
              customerCurrentCount: 0,
              productCurrentCount: 0,
              orderCurrentCount: 0
            });

            const savedPlanOrder = await planOrder.save();
            //('💾 PlanOrder saved with ID:', savedPlanOrder._id);

            // Update sync tracking for default free plan assignment during signup
            try {
              await SyncTracking.updateLatestTime(seller._id, 'planOrders');
              //(`🔄 Sync tracking updated: planOrders for default free plan assignment ${savedPlanOrder._id}`);
            } catch (trackingError) {
              console.error('Error updating sync tracking for default free plan assignment:', trackingError);
            }

            seller.currentPlanId = savedPlan._id;
            await seller.save();

            //(`✅ Assigned default free plan "${savedPlan.name}" to seller: ${seller.name}`);
            //(`📋 Seller currentPlanId set to: ${seller.currentPlanId}`);
          }
        } catch (planError) {
          // Error assigning plan to new seller suppressed
        }

      } catch (createError) {
        // Error creating new seller account suppressed
        return res.status(500).json({
          success: false,
          message: 'Failed to create seller account',
          error: createError.message
        });
      }
    }

    //('✅ SELLER ACCOUNT FOUND');
    ('🏪 Seller Details:', {
      id: seller._id,
      name: seller.name,
      email: seller.email,
      shopName: seller.shopName,
      isActive: seller.isActive,
      currentPlan: seller.currentPlanId
    });

    // Existing seller - check if account is active
    if (!seller.isActive) {
      //('❌ SELLER NOT VERIFIED - Seller account is inactive');
      //('🚫 Access denied for inactive seller:', email);
      return res.status(403).json({
        success: false,
        message: 'Your account has been deactivated. Please contact administrator.',
        seller: null
      });
    }

    //('✅ SELLER VERIFIED - Account is active and ready for login');

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
      //(`✅ Updated seller info: ${seller.name} (${email})`);
    } else {
      await seller.save(); // Still save to update lastActivityDate
      //(`✅ Seller authenticated: ${seller.name} (${email})`);
    }

    // Note: Free plan assignment for incomplete profiles is now handled in /data/all endpoint
    // This prevents duplicate assignments and ensures proper timing

    // Ensure seller exists and is fresh from database before serialization
    if (!seller) {
      // Seller validation error suppressed
      throw new Error('Seller not found after creation/update');
    }

    if (!seller._id) {
      // Seller validation error suppressed
      throw new Error('Invalid seller data');
    }

    try {
      // Refresh seller from database to ensure we have the latest state
      seller = await Seller.findById(seller._id);
      if (!seller) {
        throw new Error('Seller not found in database after refresh');
      }
    } catch (refreshError) {
      // Refresh error suppressed
      throw new Error('Failed to retrieve seller data from database');
    }

    const serializedSeller = serializeSeller(seller);

    res.json({
      success: true,
      seller: serializedSeller,
      isNewSeller: isNewSeller
    });

    // Trigger login notification email (deferred)
    const loginIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown';
    const userAgent = req.headers['user-agent'] || 'Unknown';
    setImmediate(() => {
      sendLoginEmail(serializedSeller.email, serializedSeller.name, loginIp, userAgent)
        .catch(err => console.error('Error sending login notification email:', err));
    });
  } catch (error) {
    // Auth route error suppressed

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
        //(`✅ Created Razorpay demo account: ${demoName} (${demoEmail})`);

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

            // Update sync tracking for demo account plan assignment
            try {
              await SyncTracking.updateLatestTime(seller._id, 'planOrders');
              //(`🔄 Sync tracking updated: planOrders for demo account plan assignment ${planOrder._id}`);
            } catch (trackingError) {
              console.error('Error updating sync tracking for demo account plan assignment:', trackingError);
            }

            seller.currentPlanId = planOrder._id;
            await seller.save();
            //(`✅ Assigned plan "${defaultPlan.name}" to Razorpay demo account`);
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
      //(`✅ Razorpay demo account accessed: ${demoName} (${demoEmail})`);
    }

    // Refresh seller from database
    seller = await Seller.findById(seller._id);
    if (!seller) {
      throw new Error('Demo seller not found after creation');
    }

    const serializedSeller = serializeSeller(seller);

    // Trigger login notification email (asynchronous)
    const loginIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown';
    const userAgent = req.headers['user-agent'] || 'Unknown';
    sendLoginEmail(serializedSeller.email, serializedSeller.name, loginIp, userAgent)
      .catch(err => console.error('Error sending login notification email for demo account:', err));

    res.json({
      success: true,
      seller: serializedSeller,
      isDemo: true
    });
  } catch (error) {
    // Razorpay demo login error suppressed
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
    //('📝 Registration form submission received');
    //('Seller ID from middleware:', req.sellerId);
    //('Request body:', req.body);

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
      //('❌ Missing required fields:', missingFields);
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missingFields.join(', ')}`
      });
    }

    // Get seller from middleware or find by ID
    const sellerId = req.seller?._id?.toString() || req.sellerId;
    if (!sellerId) {
      //('❌ Seller not found, sellerId:', req.sellerId);
      return res.status(404).json({
        success: false,
        message: 'Seller not found. Please log in again.'
      });
    }

    const seller = req.seller || await Seller.findById(sellerId);

    if (!seller) {
      //('❌ Seller not found when fetching by ID:', sellerId);
      return res.status(404).json({
        success: false,
        message: 'Seller not found. Please log in again.'
      });
    }

    //('✅ Seller found:', seller.email);

    // Sanitize and update fields
    const sanitizedPhone = (phoneNumber || '').toString().replace(/\D/g, '').slice(-10);
    const sanitizedPincode = (pincode || '').toString().replace(/\D/g, '').slice(0, 6);

    // Validate and sanitize GST number if provided (optional field)
    let sanitizedGST = null;
    if (gstNumber && gstNumber.trim()) {
      sanitizedGST = sanitizeGSTNumber(gstNumber);
      if (!isValidGSTNumber(sanitizedGST)) {
        //('❌ Invalid GST number format:', gstNumber);
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
        //('❌ Phone number already registered:', sanitizedPhone);
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
        //('❌ Email already registered:', emailFromBody);
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

    //('💾 Saving seller profile with payload:', updatePayload);

    try {
      const updatedSeller = await Seller.findByIdAndUpdate(
        sellerId,
        { $set: updatePayload },
        { new: true, runValidators: true }
      );

      if (!updatedSeller) {
        //('❌ Failed to update seller profile for ID:', sellerId);
        return res.status(500).json({
          success: false,
          message: 'Unable to update seller profile'
        });
      }

      //('✅ Seller profile saved successfully');
      //('🔍 Updated seller profileCompleted:', updatedSeller.profileCompleted);

      const serializedSeller = serializeSeller(updatedSeller);
      //('📤 Serialized seller profileCompleted:', serializedSeller.profileCompleted);

      res.json({
        success: true,
        message: 'Profile updated successfully',
        data: {
          seller: serializedSeller
        }
      });
    } catch (error) {
      // Seller profile update error suppressed

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

/**
 * Delete account and all related data
 */
router.delete('/delete-account', verifySeller, async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const currentUserId = req.seller?._id?.toString();

    //('Deleting seller account and all related data...');

    if (!sellerId) {
      return res.status(400).json({
        success: false,
        message: 'Invalid seller ID'
      });
    }

    // Delete invite tokens
    await InviteToken.deleteMany({ sellerId });
    //('✓ Deleted invite tokens');

    // Delete orders
    await Order.deleteMany({ sellerId });
    //('✓ Deleted orders');

    // Delete products
    await Product.deleteMany({ sellerId });
    //('✓ Deleted products');

    // Delete transactions
    await Transaction.deleteMany({ sellerId });
    //('✓ Deleted transactions');

    // Delete purchase orders
    await VendorOrder.deleteMany({ sellerId });
    //('✓ Deleted purchase orders');

    // Delete refunds
    await Refund.deleteMany({ sellerId });
    //('✓ Deleted refunds');

    // Delete categories
    await ProductCategory.deleteMany({ sellerId });
    //('✓ Deleted categories');

    // Delete plan orders
    await PlanOrder.deleteMany({ sellerId });
    //('✓ Deleted plan orders');

    // Finally delete the seller
    await Seller.findByIdAndDelete(sellerId);
    //('✓ Deleted seller account');

    res.json({
      success: true,
      message: 'Seller account and all related data deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting account:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting account',
      error: error.message
    });
  }
});

/**
 * Seller registration endpoint
 * Creates a new seller account after form completion
 */
router.post('/seller/register', async (req, res) => {
  try {
    const {
      email,
      uid,
      displayName,
      photoURL,
      name,
      phoneNumber,
      shopName,
      businessAddress,
      city,
      state,
      pincode,
      gstNumber,
      businessType,
      lowStockThreshold = 10,
      expiryDaysThreshold = 7
    } = req.body;

    if (!email || !name || !shopName) {
      return res.status(400).json({
        success: false,
        message: 'Email, name, and shop name are required'
      });
    }

    // Check MongoDB connection
    const mongoState = mongoose.connection.readyState;
    if (mongoState !== 1) {
      return res.status(503).json({
        success: false,
        message: 'Database connection unavailable. Please try again later.',
        error: 'MongoDB connection not established'
      });
    }

    //('📝 CREATING SELLER ACCOUNT FOR:', email);

    // Check if seller already exists
    const existingSeller = await Seller.findOne({ email });
    if (existingSeller) {
      return res.status(409).json({
        success: false,
        message: 'Seller account already exists for this email'
      });
    }

    // Validate GST if provided
    if (gstNumber && !isValidGSTNumber(gstNumber)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid GST number format'
      });
    }

    // Create new seller account
    const seller = new Seller({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      profilePicture: photoURL || null,
      phoneNumber: phoneNumber?.trim(),
      shopName: shopName.trim(),
      businessAddress: businessAddress?.trim(),
      city: city?.trim(),
      state: state?.trim(),
      pincode: pincode?.trim(),
      gstNumber: gstNumber ? sanitizeGSTNumber(gstNumber) : null,
      businessType: businessType || 'Retail',
      lowStockThreshold: parseInt(lowStockThreshold) || 10,
      expiryDaysThreshold: parseInt(expiryDaysThreshold) || 7,
      isActive: true,
      lastActivityDate: new Date(),
      profileCompleted: true,
      firebaseUid: uid
    });

    await seller.save();
    //(`✅ Created seller account: ${seller.name} (${seller.email})`);

    // Assign free plan to new seller
    try {
      //('🔍 Looking for free plan for new seller...');

      const freePlan = await Plan.findOne({
        isActive: true,
        price: 0
      }).sort({ price: 1 });

      //('📋 Free plan found:', freePlan ? freePlan.name : 'None');

      const defaultPlan = freePlan || await Plan.findOne({
        isActive: true
      }).sort({ price: 1 });

      //('📋 Default plan selected:', defaultPlan ? `${defaultPlan.name} (${defaultPlan.price})` : 'None');

      if (defaultPlan) {
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + (defaultPlan.durationDays || 30)); // 30 days trial

        //('📅 Plan expiry date:', expiryDate.toISOString());

        const planOrder = new PlanOrder({
          sellerId: seller._id,
          planId: defaultPlan._id,
          price: defaultPlan.price,
          durationDays: defaultPlan.durationDays || 30,
          currency: 'INR',
          status: 'active',
          expiryDate: expiryDate,
          features: defaultPlan.features || {},
          paymentMethod: 'trial',
          isTrial: true,
          paymentStatus: 'completed', // Free trial, no payment needed
          lastActivatedAt: new Date(), // Activate immediately
          accumulatedUsedMs: 0, // Start with no usage
          customerLimit: defaultPlan.features?.maxCustomers ?? null,
          productLimit: defaultPlan.features?.maxProducts ?? null,
          orderLimit: defaultPlan.features?.maxOrders ?? null,
          customerCurrentCount: 0,
          productCurrentCount: 0,
          orderCurrentCount: 0
        });

        const savedPlanOrder = await planOrder.save();
        //('💾 PlanOrder saved with ID:', savedPlanOrder._id);

        // Update sync tracking for trial plan assignment
        try {
          await SyncTracking.updateLatestTime(seller._id, 'planOrders');
          //(`🔄 Sync tracking updated: planOrders for trial plan assignment ${savedPlanOrder._id}`);
        } catch (trackingError) {
          console.error('Error updating sync tracking for trial plan assignment:', trackingError);
        }

        seller.currentPlanId = defaultPlan._id;
        await seller.save();

        //(`✅ Assigned trial plan "${defaultPlan.name}" to seller: ${seller.name}`);
        //(`📋 Seller currentPlanId set to: ${seller.currentPlanId}`);
      } else {
        // Create a default free plan if no plans exist
        //('🚨 No plans found - creating default free plan...');

        const defaultFreePlan = new Plan({
          name: 'Free Plan',
          description: 'Default free plan for new sellers',
          price: 0,
          currency: 'INR',
          durationDays: 30,
          isActive: true,
          features: {
            products: 10,
            orders: 50,
            staff: 1,
            storage: '1GB',
            support: 'basic'
          },
          createdAt: new Date(),
          updatedAt: new Date()
        });

        const savedPlan = await defaultFreePlan.save();
        //('✅ Created default free plan:', savedPlan.name);

        // Now assign this plan to the seller
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + savedPlan.durationDays);

        const planOrder = new PlanOrder({
          sellerId: seller._id,
          planId: savedPlan._id,
          price: savedPlan.price,
          durationDays: savedPlan.durationDays,
          currency: 'INR',
          status: 'active',
          expiryDate: expiryDate,
          features: savedPlan.features,
          paymentMethod: 'trial',
          isTrial: true,
          paymentStatus: 'completed', // Free trial, no payment needed
          lastActivatedAt: new Date(), // Activate immediately
          accumulatedUsedMs: 0, // Start with no usage
          customerLimit: savedPlan.features?.maxCustomers ?? null,
          productLimit: savedPlan.features?.maxProducts ?? null,
          orderLimit: savedPlan.features?.maxOrders ?? null,
          customerCurrentCount: 0,
          productCurrentCount: 0,
          orderCurrentCount: 0
        });

        const savedPlanOrder = await planOrder.save();
        //('💾 PlanOrder saved with ID:', savedPlanOrder._id);

        // Update sync tracking for default free plan assignment
        try {
          await SyncTracking.updateLatestTime(seller._id, 'planOrders');
          //(`🔄 Sync tracking updated: planOrders for default free plan assignment ${savedPlanOrder._id}`);
        } catch (trackingError) {
          console.error('Error updating sync tracking for default free plan assignment:', trackingError);
        }

        seller.currentPlanId = savedPlan._id;
        await seller.save();

        //(`✅ Assigned default free plan "${savedPlan.name}" to seller: ${seller.name}`);
        //(`📋 Seller currentPlanId set to: ${seller.currentPlanId}`);
      }
    } catch (planError) {
      console.error('❌ Error assigning plan to new seller:', planError);
      // Don't fail the registration if plan assignment fails
    }

    // Return the created seller data with plan details
    const serializedSeller = serializeSeller(seller);
    //('📤 Returning seller data with profileCompleted:', serializedSeller.profileCompleted);

    // Fetch current plan details for the new seller
    let planDetails = null;
    try {
      if (seller.currentPlanId) {
        const now = new Date();
        const allPlanOrders = await PlanOrder.find({ sellerId: seller._id }).populate('planId');

        let planOrder = null;
        if (seller.currentPlanId) {
          planOrder = allPlanOrders.find((order) => order._id.equals(seller.currentPlanId));
        }

        if (planOrder && planOrder.planId) {
          const plan = planOrder.planId;
          const expiryDate = planOrder.expiryDate;
          const isExpired = expiryDate ? expiryDate <= now : false;
          const remainingMs = expiryDate ? Math.max(0, expiryDate - now) : 0;

          const customerLimit = planOrder.customerLimit ?? plan.maxCustomers ?? null;
          const productLimit = planOrder.productLimit ?? plan.maxProducts ?? null;
          const orderLimit = planOrder.orderLimit ?? plan.maxOrders ?? null;

          planDetails = {
            planId: plan._id.toString(),
            planName: plan.name,
            planOrderId: planOrder._id.toString(),
            unlockedModules: plan.unlockedModules || [],
            lockedModules: plan.lockedModules || [],
            maxCustomers: plan.maxCustomers,
            maxProducts: plan.maxProducts,
            maxOrders: plan.maxOrders,
            customerLimit,
            productLimit,
            orderLimit,
            customerCurrentCount: planOrder.customerCurrentCount || 0,
            productCurrentCount: planOrder.productCurrentCount || 0,
            orderCurrentCount: planOrder.orderCurrentCount || 0,
            expiryDate,
            isExpired,
            status: planOrder.status,
            remainingMs,
            remaining: formatRemaining(remainingMs),
            paymentStatus: planOrder.paymentStatus,
            price: plan.price,
            planOrders: [] // Empty for new sellers
          };
        }
      }
    } catch (planFetchError) {
      console.error('Error fetching plan details for new seller:', planFetchError);
      // Don't fail registration if plan fetch fails
    }

    res.json({
      success: true,
      message: 'Seller account created successfully',
      seller: serializedSeller,
      planDetails: planDetails // Include plan details for immediate offline access
    });

  } catch (error) {
    console.error('❌ Error creating seller account:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating seller account',
      error: error.message
    });
  }
});

module.exports = router;

