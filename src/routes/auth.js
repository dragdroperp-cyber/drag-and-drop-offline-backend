const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Seller = require('../models/Seller');
const Staff = require('../models/Staff');
const Plan = require('../models/Plan');
const PlanOrder = require('../models/PlanOrder');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Transaction = require('../models/Transaction');
const VendorOrder = require('../models/VendorOrder');
const Refund = require('../models/Refund');
const ProductCategory = require('../models/ProductCategory');
const InviteToken = require('../models/InviteToken');
const { verifySeller } = require('../middleware/auth');
const { formatRemaining } = require('../utils/planTimers');

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

    console.log('🔐 SELLER AUTHENTICATION STARTED');
    console.log('📧 Email:', email);
    console.log('🆔 UID:', uid);

    // Find existing seller by email
    console.log('🔍 Looking for seller account...');
    let seller = await Seller.findOne({ email });
    let isNewSeller = false;

    if (!seller) {
      console.log('📝 No seller account found - creating new seller account for:', email);

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
        console.log(`✅ Created new seller account: ${seller.name} (${seller.email})`);
        isNewSeller = true;

        // Assign free plan to new seller
        try {
          console.log('🔍 Looking for free plan for new seller...');

          const freePlan = await Plan.findOne({
            isActive: true,
            price: 0
          }).sort({ price: 1 });

          console.log('📋 Free plan found:', freePlan ? freePlan.name : 'None');

          const defaultPlan = freePlan || await Plan.findOne({
            isActive: true
          }).sort({ price: 1 });

          console.log('📋 Default plan selected:', defaultPlan ? `${defaultPlan.name} (${defaultPlan.price})` : 'None');

          if (defaultPlan) {
            const expiryDate = new Date();
            expiryDate.setDate(expiryDate.getDate() + (defaultPlan.durationDays || 30)); // 30 days trial

            console.log('📅 Plan expiry date:', expiryDate.toISOString());

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
            console.log('💾 PlanOrder saved with ID:', savedPlanOrder._id);

            seller.currentPlanId = planOrder._id;
            await seller.save();

            console.log(`✅ Assigned ${freePlan ? 'free' : 'trial'} plan "${defaultPlan.name}" to seller: ${seller.name}`);
            console.log(`📋 Seller currentPlanId set to: ${seller.currentPlanId}`);
          } else {
            // Create a default free plan if no plans exist
            console.log('🚨 No plans found - creating default free plan...');

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
            console.log('✅ Created default free plan:', savedPlan.name);

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
            console.log('💾 PlanOrder saved with ID:', savedPlanOrder._id);

            seller.currentPlanId = savedPlan._id;
            await seller.save();

            console.log(`✅ Assigned default free plan "${savedPlan.name}" to seller: ${seller.name}`);
            console.log(`📋 Seller currentPlanId set to: ${seller.currentPlanId}`);
          }
        } catch (planError) {
          console.error('❌ Error assigning plan to new seller:', planError);
          // Don't fail the registration if plan assignment fails
        }

      } catch (createError) {
        console.error('❌ Error creating new seller account:', createError);
        return res.status(500).json({
          success: false,
          message: 'Failed to create seller account',
          error: createError.message
        });
      }
    }

    console.log('✅ SELLER ACCOUNT FOUND');
    console.log('🏪 Seller Details:', {
      id: seller._id,
      name: seller.name,
      email: seller.email,
      shopName: seller.shopName,
      isActive: seller.isActive,
      currentPlan: seller.currentPlanId
    });

    // Existing seller - check if account is active
    if (!seller.isActive) {
      console.log('❌ SELLER NOT VERIFIED - Seller account is inactive');
      console.log('🚫 Access denied for inactive seller:', email);
      return res.status(403).json({
        success: false,
        message: 'Your account has been deactivated. Please contact administrator.',
        seller: null
      });
    }

    console.log('✅ SELLER VERIFIED - Account is active and ready for login');

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
      seller: serializedSeller,
      isNewSeller: isNewSeller
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
      console.log('🔍 Updated seller profileCompleted:', updatedSeller.profileCompleted);

      const serializedSeller = serializeSeller(updatedSeller);
      console.log('📤 Serialized seller profileCompleted:', serializedSeller.profileCompleted);

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

/**
 * Delete account and all related data
 */
router.delete('/delete-account', verifySeller, async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const currentUserId = req.seller?._id?.toString();

    // Check if this is a staff member trying to delete their own account
    const staffMember = await Staff.findOne({
      _id: currentUserId,
      isActive: true
    });

    const userType = staffMember ? 'staff' : 'seller';
    const targetId = userType === 'staff' ? currentUserId : sellerId;

    console.log(`Deleting ${userType} account:`, targetId);

    if (!targetId) {
      return res.status(400).json({
        success: false,
        message: 'Invalid account ID'
      });
    }

    // For sellers, delete all related data
    if (userType === 'seller') {
      console.log('Deleting seller account and all related data...');

      // Delete staff members first
      await Staff.deleteMany({ sellerId });
      console.log('✓ Deleted staff members');

      // Delete invite tokens
      await InviteToken.deleteMany({ sellerId });
      console.log('✓ Deleted invite tokens');

      // Delete orders
      await Order.deleteMany({ sellerId });
      console.log('✓ Deleted orders');

      // Delete products
      await Product.deleteMany({ sellerId });
      console.log('✓ Deleted products');

      // Delete transactions
      await Transaction.deleteMany({ sellerId });
      console.log('✓ Deleted transactions');

      // Delete purchase orders
      await VendorOrder.deleteMany({ sellerId });
      console.log('✓ Deleted purchase orders');

      // Delete refunds
      await Refund.deleteMany({ sellerId });
      console.log('✓ Deleted refunds');

      // Delete categories
      await ProductCategory.deleteMany({ sellerId });
      console.log('✓ Deleted categories');

      // Delete plan orders
      await PlanOrder.deleteMany({ sellerId });
      console.log('✓ Deleted plan orders');

      // Finally delete the seller
      await Seller.findByIdAndDelete(targetId);
      console.log('✓ Deleted seller account');

    } else if (userType === 'staff') {
      // For staff, just delete the staff record
      console.log('Deleting staff account...');
      await Staff.findByIdAndDelete(targetId);
      console.log('✓ Deleted staff account');
    }

    res.json({
      success: true,
      message: `${userType === 'seller' ? 'Seller account' : 'Staff account'} and all related data deleted successfully`
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

    console.log('📝 CREATING SELLER ACCOUNT FOR:', email);

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
    console.log(`✅ Created seller account: ${seller.name} (${seller.email})`);

    // Assign free plan to new seller
    try {
      console.log('🔍 Looking for free plan for new seller...');

      const freePlan = await Plan.findOne({
        isActive: true,
        price: 0
      }).sort({ price: 1 });

      console.log('📋 Free plan found:', freePlan ? freePlan.name : 'None');

      const defaultPlan = freePlan || await Plan.findOne({
        isActive: true
      }).sort({ price: 1 });

      console.log('📋 Default plan selected:', defaultPlan ? `${defaultPlan.name} (${defaultPlan.price})` : 'None');

      if (defaultPlan) {
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + (defaultPlan.durationDays || 30)); // 30 days trial

        console.log('📅 Plan expiry date:', expiryDate.toISOString());

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
        console.log('💾 PlanOrder saved with ID:', savedPlanOrder._id);

        seller.currentPlanId = defaultPlan._id;
        await seller.save();

        console.log(`✅ Assigned trial plan "${defaultPlan.name}" to seller: ${seller.name}`);
        console.log(`📋 Seller currentPlanId set to: ${seller.currentPlanId}`);
      } else {
        // Create a default free plan if no plans exist
        console.log('🚨 No plans found - creating default free plan...');

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
        console.log('✅ Created default free plan:', savedPlan.name);

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
        console.log('💾 PlanOrder saved with ID:', savedPlanOrder._id);

        seller.currentPlanId = savedPlan._id;
        await seller.save();

        console.log(`✅ Assigned default free plan "${savedPlan.name}" to seller: ${seller.name}`);
        console.log(`📋 Seller currentPlanId set to: ${seller.currentPlanId}`);
      }
    } catch (planError) {
      console.error('❌ Error assigning plan to new seller:', planError);
      // Don't fail the registration if plan assignment fails
    }

    // Return the created seller data with plan details
    const serializedSeller = serializeSeller(seller);
    console.log('📤 Returning seller data with profileCompleted:', serializedSeller.profileCompleted);

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

