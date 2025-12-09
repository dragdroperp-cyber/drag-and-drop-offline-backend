const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Product = require('../models/Product');
const ProductBatch = require('../models/ProductBatch');
const Order = require('../models/Order');
const Transaction = require('../models/Transaction');
const VendorOrder = require('../models/VendorOrder');
const ProductCategory = require('../models/ProductCategory');
const Refund = require('../models/Refund');
const Plan = require('../models/Plan');
const PlanOrder = require('../models/PlanOrder');
const Seller = require('../models/Seller');
const SyncTracking = require('../models/SyncTracking');
const { createOrder, verifyPayment, convertToPaise } = require('../utils/razorpay');
const { computeRemainingMs, formatRemaining, getPlanDurationMs } = require('../utils/planTimers');
const { setActivePlanForSeller } = require('./planValidity');
const { getPlanUsageSummary } = require('../utils/planUsage');

// Cache to track which sellers have had their timestamps fixed in this session
const timestampFixedSellers = new Set();

/**
 * Check if the seller's current plan is valid (not expired)
 * @param {string} sellerId - Seller ID
 * @returns {object} - { isValid: boolean, planOrder: object, plan: object, remainingMs: number }
 */
const checkPlanValidity = async (sellerId) => {
  try {
    // Get seller and their current plan
    const seller = await Seller.findById(sellerId);
    if (!seller || !seller.currentPlanId) {
      return { isValid: false, reason: 'No current plan' };
    }

    // Get the current plan order
    const planOrder = await PlanOrder.findById(seller.currentPlanId);
    if (!planOrder) {
      return { isValid: false, reason: 'Plan order not found' };
    }

    // Get the plan details
    const plan = await Plan.findById(planOrder.planId);
    if (!plan) {
      return { isValid: false, reason: 'Plan not found' };
    }

    // Check if plan is active
    if (!plan.isActive) {
      return { isValid: false, reason: 'Plan is not active' };
    }

    // Check if plan order is completed
    if (planOrder.paymentStatus !== 'completed') {
      return { isValid: false, reason: 'Plan payment not completed' };
    }

    // Calculate remaining time
    const now = new Date();
    const remainingMs = computeRemainingMs(planOrder, plan, now);

    if (remainingMs <= 0) {
      return {
        isValid: false,
        reason: 'Plan expired',
        planOrder,
        plan,
        remainingMs
      };
    }

    return {
      isValid: true,
      planOrder,
      plan,
      remainingMs
    };
  } catch (error) {
    console.error('Error checking plan validity:', error);
    return { isValid: false, reason: 'Error checking plan' };
  }
};

/**
 * Ensure all documents for a seller have proper updatedAt timestamps
 * This fixes any legacy documents that might be missing timestamps
 * Runs only once per seller per application restart
 */
const ensureTimestamps = async (sellerId) => {
  try {
    // Skip if already fixed in this session
    if (timestampFixedSellers.has(sellerId.toString())) {
      return;
    }

    const now = new Date();
    //('🔧 Ensuring timestamps for seller:', sellerId);

    const models = [
      { name: 'Customer', model: Customer },
      { name: 'Product', model: Product },
      { name: 'Order', model: Order },
      { name: 'Transaction', model: Transaction },
      { name: 'VendorOrder', model: VendorOrder },
      { name: 'ProductCategory', model: ProductCategory },
      { name: 'PlanOrder', model: PlanOrder }
    ];

    for (const { name, model } of models) {
      try {
        // Count documents without proper timestamps first
        const countWithoutTimestamps = await model.countDocuments({
          sellerId,
          $or: [
            { updatedAt: { $exists: false } },
            { updatedAt: null },
            { updatedAt: { $type: 10 } } // BSON null type
          ]
        });

        if (countWithoutTimestamps > 0) {
          //(`📊 Found ${countWithoutTimestamps} ${name} documents missing timestamps for seller ${sellerId}`);
        }

        // Find documents without updatedAt or with null/undefined updatedAt
        const result = await model.updateMany(
          {
            sellerId,
            $or: [
              { updatedAt: { $exists: false } },
              { updatedAt: null },
              { updatedAt: { $type: 10 } } // BSON null type
            ]
          },
          {
            $set: {
              updatedAt: now,
              createdAt: now // Also set createdAt if missing
            }
          }
        );

        if (result.modifiedCount > 0) {
          //(`✅ Fixed ${result.modifiedCount} ${name} documents with missing timestamps`);
        }
      } catch (error) {
        console.warn(`⚠️ Error fixing timestamps for ${name}:`, error.message);
      }
    }

    // Handle global models (Plans don't have sellerId)
    try {
      const planResult = await Plan.updateMany(
        {
          $or: [
            { updatedAt: { $exists: false } },
            { updatedAt: null },
            { updatedAt: { $type: 10 } }
          ]
        },
        {
          $set: {
            updatedAt: now,
            createdAt: now
          }
        }
      );

      if (planResult.modifiedCount > 0) {
        //(`✅ Fixed ${planResult.modifiedCount} Plan documents with missing timestamps`);
      }
    } catch (error) {
      console.warn('⚠️ Error fixing timestamps for Plans:', error.message);
    }

    // Mark this seller as fixed for this session
    timestampFixedSellers.add(sellerId.toString());
    //('✅ Timestamp check completed for seller:', sellerId);

  } catch (error) {
    console.error('❌ Error in ensureTimestamps:', error);
  }
};

/**
 * Get all customers for a seller
 */
const getCustomers = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const customers = await Customer.find({ sellerId }).sort({ createdAt: -1 });

    // Transform to match frontend format
    const formattedCustomers = customers.map(customer => ({
      id: customer._id.toString(),
      name: customer.name,
      mobileNumber: customer.mobileNumber,
      phone: customer.mobileNumber, // Backward compatibility
      email: customer.email,
      dueAmount: customer.dueAmount || 0,
      balanceDue: customer.dueAmount || 0, // Frontend compatibility - ensure balanceDue is set
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
      isSynced: true,
      _id: customer._id.toString()
    }));

    res.json({
      success: true,
      data: formattedCustomers
    });
  } catch (error) {
    console.error('Get customers error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching customers',
      error: error.message
    });
  }
};

/**
 * Get all products for a seller
 */
const getProducts = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const products = await Product.find({ sellerId })
      .populate('categoryId', 'name')
      .sort({ createdAt: -1 });

    // Get all batches for this seller
    const batches = await ProductBatch.find({
      sellerId,
      isDeleted: false
    }).populate('productId', 'name');

    // Group batches by product and calculate totals
    const productBatchData = {};
    batches.forEach(batch => {
      // Skip batches with invalid productId references
      if (!batch.productId || !batch.productId._id) {
        console.warn('⚠️ Skipping batch with invalid productId:', batch._id, 'productId:', batch.productId);
        return;
      }
      const productId = batch.productId._id.toString();
      if (!productBatchData[productId]) {
        productBatchData[productId] = {
          totalStock: 0,
          batches: [],
          latestBatch: null
        };
      }
      productBatchData[productId].totalStock += batch.quantity;
      productBatchData[productId].batches.push(batch);

      // Track the latest batch for pricing (by expiry date, or creation date if no expiry)
      if (!productBatchData[productId].latestBatch ||
          (batch.expiry && productBatchData[productId].latestBatch.expiry &&
           batch.expiry > productBatchData[productId].latestBatch.expiry) ||
          (!batch.expiry && !productBatchData[productId].latestBatch.expiry &&
           batch.createdAt > productBatchData[productId].latestBatch.createdAt)) {
        productBatchData[productId].latestBatch = batch;
      }
    });

    // Transform to match frontend format - now using batch data
    const formattedProducts = products.map(product => {
      const productId = product._id.toString();
      const batchData = productBatchData[productId] || { totalStock: 0, batches: [], latestBatch: null };

      return {
        id: product._id.toString(),
        name: product.name,
        barcode: product.barcode || '',
        categoryId: product.categoryId && product.categoryId._id ? product.categoryId._id.toString() : (typeof product.categoryId === 'string' ? product.categoryId : null),
        category: product.categoryId ? product.categoryId.name : '',
        stock: batchData.totalStock, // Now calculated from batches
        quantity: batchData.totalStock, // Frontend compatibility
        unit: product.unit || 'pcs',
        costPrice: batchData.latestBatch ? batchData.latestBatch.costPrice : 0,
        unitPrice: batchData.latestBatch ? batchData.latestBatch.costPrice : 0, // Frontend compatibility
        sellingUnitPrice: batchData.latestBatch ? batchData.latestBatch.sellingUnitPrice : 0,
        sellingPrice: batchData.latestBatch ? batchData.latestBatch.sellingUnitPrice : 0, // Backward compatibility
        lowStockLevel: product.lowStockLevel || 10,
        mfg: batchData.latestBatch ? batchData.latestBatch.mfg : null,
        mfgDate: batchData.latestBatch ? batchData.latestBatch.mfg : null, // Backward compatibility
        expiryDate: batchData.latestBatch ? batchData.latestBatch.expiry : null,
        description: product.description || '',
        isActive: product.isActive !== undefined ? product.isActive : true,
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
        isSynced: true,
        _id: product._id.toString(),
        // Add batch information
        batches: batchData.batches.map(batch => ({
          id: batch._id.toString(),
          batchNumber: batch.batchNumber,
          mfg: batch.mfg,
          expiry: batch.expiry,
          quantity: batch.quantity,
          costPrice: batch.costPrice,
          sellingUnitPrice: batch.sellingUnitPrice,
          createdAt: batch.createdAt,
          updatedAt: batch.updatedAt
        }))
      };
    });

    res.json({
      success: true,
      data: formattedProducts
    });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching products',
      error: error.message
    });
  }
};

// Product Batch operations
const getProductBatches = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const { productId } = req.query;

    let query = { sellerId, isDeleted: false };
    if (productId) {
      query.productId = productId;
    }

    const batches = await ProductBatch.find(query)
      .populate('productId', 'name barcode unit')
      .sort({ createdAt: -1 });

    const formattedBatches = batches.map(batch => ({
      id: batch._id.toString(),
      productId: batch.productId && batch.productId._id ? batch.productId._id.toString() : null,
      productName: batch.productId.name,
      productBarcode: batch.productId.barcode,
      productUnit: batch.productId.unit,
      batchNumber: batch.batchNumber,
      mfg: batch.mfg,
      expiry: batch.expiry,
      quantity: batch.quantity,
      costPrice: batch.costPrice,
      sellingUnitPrice: batch.sellingUnitPrice,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt
    }));

    res.json({
      success: true,
      data: formattedBatches
    });
  } catch (error) {
    console.error('Get product batches error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching product batches',
      error: error.message
    });
  }
};

const createProductBatch = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const { productId, batchNumber, mfg, expiry, quantity, costPrice, sellingUnitPrice } = req.body;

    // Validate required fields (mfg and expiry are optional)
    if (!productId || !quantity || !costPrice || !sellingUnitPrice) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: productId, quantity, costPrice, sellingUnitPrice'
      });
    }

    // Verify product exists and belongs to seller
    // ProductId should be a valid MongoDB ObjectId from synced products
    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({
        success: false,
        message: `Invalid product ID format. Please ensure the product is synced first. ProductId: ${productId}`
      });
    }

    //(`🔍 Looking for product ${productId} for seller ${sellerId}`);
    const product = await Product.findOne({ _id: productId, sellerId });
    //(`🔍 Product found:`, product ? { id: product._id, name: product.name } : 'NOT FOUND');

    if (!product) {
      //(`❌ Product not found: ${productId} for seller ${sellerId}`);
      return res.status(404).json({
        success: false,
        message: `Product not found or does not belong to seller. ProductId: ${productId}`
      });
    }

    const batch = new ProductBatch({
      sellerId,
      productId,
      batchNumber: batchNumber || '',
      mfg: mfg ? new Date(mfg) : undefined,
      expiry: expiry ? new Date(expiry) : undefined,
      quantity: Number(quantity),
      costPrice: Number(costPrice),
      sellingUnitPrice: Number(sellingUnitPrice)
    });

    await batch.save();

    // Update sync tracking
    try {
      await SyncTracking.updateLatestTime(sellerId, 'productBatches');
      //(`🔄 Sync tracking updated: productBatches for seller ${sellerId}`);
    } catch (trackingError) {
      console.error('Error updating sync tracking for product batch creation:', trackingError);
    }

    // Populate product details for response
    await batch.populate('productId', 'name barcode unit');

    res.status(201).json({
      success: true,
      message: 'Product batch created successfully',
      data: {
        id: batch._id.toString(),
        productId: batch.productId && batch.productId._id ? batch.productId._id.toString() : null,
        productName: batch.productId ? batch.productId.name : 'Unknown Product',
        productBarcode: batch.productId.barcode,
        productUnit: batch.productId.unit,
        batchNumber: batch.batchNumber,
        mfg: batch.mfg,
        expiry: batch.expiry,
        quantity: batch.quantity,
        costPrice: batch.costPrice,
        sellingUnitPrice: batch.sellingUnitPrice,
        createdAt: batch.createdAt,
        updatedAt: batch.updatedAt
      }
    });
  } catch (error) {
    console.error('Create product batch error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating product batch',
      error: error.message
    });
  }
};

const updateProductBatch = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const { id } = req.params;
    const updates = req.body;

    // Validate that batch exists and belongs to seller
    const batch = await ProductBatch.findOne({ _id: id, sellerId });
    if (!batch) {
      return res.status(404).json({
        success: false,
        message: 'Product batch not found or does not belong to seller'
      });
    }

    // Update allowed fields
    const allowedUpdates = ['batchNumber', 'mfg', 'expiry', 'quantity', 'costPrice', 'sellingUnitPrice'];
    const updateData = {};

    allowedUpdates.forEach(field => {
      if (updates[field] !== undefined) {
        if (field === 'mfg' || field === 'expiry') {
          updateData[field] = new Date(updates[field]);
        } else if (field === 'quantity' || field === 'costPrice' || field === 'sellingUnitPrice') {
          updateData[field] = Number(updates[field]);
        } else {
          updateData[field] = updates[field];
        }
      }
    });

    updateData.updatedAt = new Date();

    const updatedBatch = await ProductBatch.findByIdAndUpdate(id, updateData, { new: true })
      .populate('productId', 'name barcode unit');

    // Update sync tracking
    try {
      await SyncTracking.updateLatestTime(sellerId, 'productBatches');
      //(`🔄 Sync tracking updated: productBatches for seller ${sellerId}`);
    } catch (trackingError) {
      console.error('Error updating sync tracking for product batch update:', trackingError);
    }

    res.json({
      success: true,
      message: 'Product batch updated successfully',
      data: {
        id: updatedBatch._id.toString(),
        productId: updatedBatch.productId && updatedBatch.productId._id ? updatedBatch.productId._id.toString() : null,
        productName: updatedBatch.productId ? updatedBatch.productId.name : 'Unknown Product',
        productBarcode: updatedBatch.productId.barcode,
        productUnit: updatedBatch.productId.unit,
        batchNumber: updatedBatch.batchNumber,
        mfg: updatedBatch.mfg,
        expiry: updatedBatch.expiry,
        quantity: updatedBatch.quantity,
        costPrice: updatedBatch.costPrice,
        sellingUnitPrice: updatedBatch.sellingUnitPrice,
        createdAt: updatedBatch.createdAt,
        updatedAt: updatedBatch.updatedAt
      }
    });
  } catch (error) {
    console.error('Update product batch error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating product batch',
      error: error.message
    });
  }
};

const deleteProductBatch = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const { id } = req.params;

    // Soft delete by setting isDeleted to true
    const batch = await ProductBatch.findOneAndUpdate(
      { _id: id, sellerId },
      { isDeleted: true, updatedAt: new Date() },
      { new: true }
    );

    if (!batch) {
      return res.status(404).json({
        success: false,
        message: 'Product batch not found or does not belong to seller'
      });
    }

    // Update sync tracking
    try {
      await SyncTracking.updateLatestTime(sellerId, 'productBatches');
      //(`🔄 Sync tracking updated: productBatches for seller ${sellerId}`);
    } catch (trackingError) {
      console.error('Error updating sync tracking for product batch deletion:', trackingError);
    }

    res.json({
      success: true,
      message: 'Product batch deleted successfully'
    });
  } catch (error) {
    console.error('Delete product batch error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting product batch',
      error: error.message
    });
  }
};

/**
 * Get all orders for a seller
 */
const getOrders = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    // Use lean() to get plain JavaScript objects - ensures nested objects like splitPaymentDetails are properly accessible
    const orders = await Order.find({ sellerId })
      .populate('customerId', 'name mobileNumber')
      .lean()
      .sort({ createdAt: -1 });

    // Transform to match frontend format
    const parseNumeric = (value) => {
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    };

    const formattedOrders = orders.map(order => {
      const items = order.items || [];
      const subtotalValue = parseNumeric(order.subtotal);
      const subtotal = subtotalValue !== null
        ? subtotalValue
        : items.reduce((sum, item) => {
          const price = parseNumeric(item.sellingPrice) ?? parseNumeric(item.price) ?? 0;
          const qty = parseNumeric(item.quantity) ?? 0;
          return sum + price * qty;
        }, 0);

      const rawDiscountAmount = parseNumeric(order.discount) ?? parseNumeric(order.discountAmount) ?? 0;
      const rawTaxAmount = parseNumeric(order.tax) ?? parseNumeric(order.taxAmount) ?? 0;

      const discountPercentValue = parseNumeric(order.discountPercent);
      const discountPercent = discountPercentValue !== null
        ? discountPercentValue
        : (subtotal > 0 ? (rawDiscountAmount / subtotal) * 100 : 0);

      const discountAmount = rawDiscountAmount > 0
        ? rawDiscountAmount
        : subtotal * (discountPercent / 100);

      const taxableBase = Math.max(0, subtotal - discountAmount);

      const taxPercentValue = parseNumeric(order.taxPercent);
      const taxPercent = taxPercentValue !== null
        ? taxPercentValue
        : (taxableBase > 0 ? (rawTaxAmount / taxableBase) * 100 : 0);

      const taxAmount = rawTaxAmount > 0
        ? rawTaxAmount
        : taxableBase * (taxPercent / 100);

      const totalAmountValue = parseNumeric(order.totalAmount);
      const totalAmount = totalAmountValue !== null
        ? totalAmountValue
        : Math.max(0, taxableBase + taxAmount);

      // Preserve splitPaymentDetails exactly as stored in MongoDB
      // Don't use || null as it will convert empty objects or objects with 0 values to null
      let splitPaymentDetails = null;
      if (order.splitPaymentDetails !== undefined && order.splitPaymentDetails !== null) {
        // Include splitPaymentDetails exactly as it is in MongoDB
        splitPaymentDetails = order.splitPaymentDetails;
      }

      return {
        id: order._id.toString(),
        sellerId: order.sellerId.toString(),
        customerId: order.customerId ? order.customerId._id.toString() : null,
        customerName: order.customerName || (order.customerId ? order.customerId.name : 'Walk-in Customer'),
        customerMobile: order.customerMobile || (order.customerId ? (order.customerId.mobileNumber || order.customerId.phone || '') : ''),
        paymentMethod: order.paymentMethod || 'cash',
        splitPaymentDetails: splitPaymentDetails,
        items,
        subtotal,
        discountPercent,
        discountAmount,
        taxPercent,
        taxAmount,
        totalAmount,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        isSynced: true,
        _id: order._id.toString()
      };
    });

    res.json({
      success: true,
      data: formattedOrders
    });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching orders',
      error: error.message
    });
  }
};

/**
 * Get all transactions for a seller
 */
const getTransactions = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const transactions = await Transaction.find({ sellerId }).sort({ createdAt: -1 });

    // Transform to match frontend format
    const formattedTransactions = transactions.map(transaction => ({
      id: transaction._id.toString(),
      type: transaction.type,
      customerId: transaction.customerId || null,
      customerName: transaction.customerName || '',
      amount: transaction.amount || 0,
      total: transaction.amount || 0, // Backward compatibility
      paymentMethod: transaction.paymentMethod || 'cash',
      description: transaction.description || '',
      date: transaction.date || transaction.createdAt,
      razorpayOrderId: transaction.razorpayOrderId || null,
      razorpayPaymentId: transaction.razorpayPaymentId || null,
      planOrderId: transaction.planOrderId ? transaction.planOrderId.toString() : null,
      planId: transaction.planId ? transaction.planId.toString() : null,
      status: transaction.status || 'completed',
      createdAt: transaction.createdAt,
      updatedAt: transaction.updatedAt,
      isSynced: true,
      _id: transaction._id.toString()
    }));

    res.json({
      success: true,
      data: formattedTransactions
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching transactions',
      error: error.message
    });
  }
};

/**
 * Get all vendor orders for a seller
 */
const getVendorOrders = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const vendorOrders = await VendorOrder.find({ sellerId }).sort({ createdAt: -1 });

    // Transform to match frontend format
    const formattedOrders = vendorOrders.map(order => ({
      id: order._id.toString(),
      supplierName: order.supplierName,
      items: order.items || [],
      total: order.total || 0,
      status: order.status || 'pending',
      notes: order.notes || '',
      expectedDeliveryDate: order.expectedDeliveryDate,
      actualDeliveryDate: order.actualDeliveryDate,
      cancelledAt: order.cancelledAt,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      isSynced: true,
      _id: order._id.toString()
    }));

    res.json({
      success: true,
      data: formattedOrders
    });
  } catch (error) {
    console.error('Get vendor orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching vendor orders',
      error: error.message
    });
  }
};

/**
 * Get all categories for a seller
 */
const getCategories = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const categories = await ProductCategory.find({ sellerId }).sort({ createdAt: -1 });

    // Transform to match frontend format
    const formattedCategories = categories.map(category => ({
      id: category._id.toString(),
      name: category.name,
      description: category.description || '',
      image: category.image || '',
      isActive: category.isActive !== undefined ? category.isActive : true,
      createdAt: category.createdAt,
      updatedAt: category.updatedAt,
      isSynced: true,
      _id: category._id.toString()
    }));

    res.json({
      success: true,
      data: formattedCategories
    });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching categories',
      error: error.message
    });
  }
};

/**
 * Get all data at once
 */
const getAllData = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const { lastFetchTimes } = req.body || {};
    const Refund = require('../models/Refund');

    //('🔄 GET ALL DATA: Request for seller', sellerId, 'with lastFetchTimes:', lastFetchTimes);

    // Check if user's plan is valid
    const planCheck = await checkPlanValidity(sellerId);
    if (!planCheck.isValid) {
      //('🚫 GET ALL DATA: Plan invalid -', planCheck.reason);

      // For incomplete profiles, try to assign a free plan automatically
      const seller = await Seller.findById(sellerId);
      if (seller && !seller.profileCompleted) {
        //('🔄 GET ALL DATA: Profile incomplete, attempting automatic free plan assignment');

        try {
          const Plan = require('../models/Plan');
          const PlanOrder = require('../models/PlanOrder');
          const { setActivePlanForSeller } = require('../controllers/planValidity');

          // Check if seller already has any active plans
          const existingPlanOrders = await PlanOrder.find({
            sellerId: seller._id,
            paymentStatus: 'completed',
            status: { $in: ['active', 'paused'] }
          });

          const hasActivePlan = existingPlanOrders.some(order =>
            order.expiryDate > new Date() && order.status !== 'expired'
          );

          if (!hasActivePlan) {
            //('📋 GET ALL DATA: Assigning free plan to seller with incomplete profile');

            // Find free plan
            const freePlan = await Plan.findOne({
              isActive: true,
              price: 0
            }).sort({ price: 1 });

            if (freePlan) {
              //('✅ GET ALL DATA: Found free plan, assigning:', freePlan.name);

              // Assign free plan using the existing logic
              const planResult = await setActivePlanForSeller({
                sellerId: seller._id.toString(),
                planId: freePlan._id.toString(),
                allowCreateOnMissing: true
              });

              if (planResult.success) {
                //('✅ GET ALL DATA: Successfully assigned free plan, proceeding with data fetch');
                // Plan is now valid, continue with data fetching
              } else {
                console.warn('⚠️ GET ALL DATA: Failed to assign free plan:', planResult.message);
                return res.status(403).json({
                  success: false,
                  planInvalid: true,
                  message: 'Your plan has expired. Please renew your plan to continue accessing the application.',
                  planStatus: {
                    isValid: false,
                    reason: planCheck.reason,
                    remainingMs: planCheck.remainingMs || 0
                  }
                });
              }
            } else {
              console.warn('⚠️ GET ALL DATA: No free plan available');
              return res.status(403).json({
                success: false,
                planInvalid: true,
                message: 'Your plan has expired. Please renew your plan to continue accessing the application.',
                planStatus: {
                  isValid: false,
                  reason: planCheck.reason,
                  remainingMs: planCheck.remainingMs || 0
                }
              });
            }
          } else {
            //('✅ GET ALL DATA: Seller already has an active plan');
            // Plan is already valid, continue with data fetching
          }
        } catch (planError) {
          console.error('❌ GET ALL DATA: Error assigning free plan:', planError);
          return res.status(403).json({
            success: false,
            planInvalid: true,
            message: 'Your plan has expired. Please renew your plan to continue accessing the application.',
            planStatus: {
              isValid: false,
              reason: planCheck.reason,
              remainingMs: planCheck.remainingMs || 0
            }
          });
        }
      } else {
        // Profile is completed but plan is still invalid - redirect to upgrade
        return res.status(403).json({
          success: false,
          planInvalid: true,
          message: 'Your plan has expired. Please renew your plan to continue accessing the application.',
          planStatus: {
            isValid: false,
            reason: planCheck.reason,
            remainingMs: planCheck.remainingMs || 0
          }
        });
      }
    }

    //('✅ GET ALL DATA: Plan valid - proceeding with data fetch');

    // Ensure all documents have proper updatedAt timestamps
    await ensureTimestamps(sellerId);

    // Initialize variables for tracking changes
    const dataTypesToCheck = ['customers', 'products', 'productBatches', 'orders', 'transactions', 'purchaseOrders', 'categories', 'refunds', 'plans', 'planOrders'];
    const changedDataTypes = [];
    let hasAnyChanges = false;

    // If lastFetchTimes provided, check if any data changed
    if (lastFetchTimes && typeof lastFetchTimes === 'object') {
      //('🔄 GET ALL DATA: Checking for data changes since last fetch times');
      //('🔄 GET ALL DATA: Current server time:', new Date().toISOString());

      // Get sync tracking to check for latest update times
      let syncTracking = null;
      try {
        syncTracking = await SyncTracking.findOne({ sellerId });
        //('🔄 GET ALL DATA: Retrieved sync tracking:', syncTracking ? 'found' : 'not found');
      } catch (trackingError) {
        console.warn('🔄 GET ALL DATA: Error retrieving sync tracking:', trackingError.message);
      }

      // Check each data type for changes individually
      for (const dataType of dataTypesToCheck) {
        const lastFetchTime = lastFetchTimes[dataType];
        let hasChanges = false;

        //(`🔄 GET ALL DATA: Checking ${dataType} for changes since ${lastFetchTime || 'never'}`);

        try {
          if (lastFetchTime) {
            // Check sync tracking first (catches deletions and updates)
            const latestUpdateTime = syncTracking ? syncTracking[`${dataType}LatestUpdateTime`] : null;
            //(`🔄 GET ALL DATA: ${dataType} - sync tracking latest: ${latestUpdateTime}, device lastFetch: ${lastFetchTime}`);

            if (latestUpdateTime && new Date(latestUpdateTime) > new Date(lastFetchTime)) {
              //(`🔄 GET ALL DATA: ✅ ${dataType} sync tracking shows changes (latest: ${latestUpdateTime} > lastFetch: ${lastFetchTime})`);
              hasChanges = true;
            } else {
              //(`🔄 GET ALL DATA: Sync tracking shows no changes, checking database...`);
              // Fallback to database check for updates/creations
              switch (dataType) {
                case 'customers':
                  hasChanges = await Customer.findOne({
                    sellerId,
                    updatedAt: { $gt: new Date(lastFetchTime) }
                  }).countDocuments() > 0;
                  break;
                case 'products':
                  hasChanges = await Product.findOne({
                    sellerId,
                    updatedAt: { $gt: new Date(lastFetchTime) }
                  }).countDocuments() > 0;
                  break;
                case 'productBatches':
                  const ProductBatch = require('../models/ProductBatch');
                  hasChanges = await ProductBatch.findOne({
                    sellerId,
                    updatedAt: { $gt: new Date(lastFetchTime) }
                  }).countDocuments() > 0;
                  break;
                case 'orders':
                  hasChanges = await Order.findOne({
                    sellerId,
                    updatedAt: { $gt: new Date(lastFetchTime) }
                  }).countDocuments() > 0;
                  break;
                case 'transactions':
                  hasChanges = await Transaction.findOne({
                    sellerId,
                    updatedAt: { $gt: new Date(lastFetchTime) }
                  }).countDocuments() > 0;
                  break;
                case 'purchaseOrders':
                  hasChanges = await VendorOrder.findOne({
                    sellerId,
                    updatedAt: { $gt: new Date(lastFetchTime) }
                  }).countDocuments() > 0;
                  break;
                case 'categories':
                  hasChanges = await ProductCategory.findOne({
                    sellerId,
                    updatedAt: { $gt: new Date(lastFetchTime) }
                  }).countDocuments() > 0;
                  break;
                case 'refunds':
                  hasChanges = await Refund.findOne({
                    sellerId,
                    updatedAt: { $gt: new Date(lastFetchTime) }
                  }).countDocuments() > 0;
                  break;
                case 'plans':
                  // Plans are global, check if any plan was updated after last fetch
                  hasChanges = await require('../models/Plan').findOne({
                    updatedAt: { $gt: new Date(lastFetchTime) }
                  }).countDocuments() > 0;
                  break;
                case 'planOrders':
                  hasChanges = await require('../models/PlanOrder').findOne({
                    sellerId,
                    updatedAt: { $gt: new Date(lastFetchTime) }
                  }).countDocuments() > 0;
                  break;
              }
            }
          } else {
            // No lastFetchTime means this is first fetch, so we need data
            hasChanges = true;
          }

          if (hasChanges) {
            //(`🔄 GET ALL DATA: ✅ ${dataType} HAS changes - will fetch data`);
            changedDataTypes.push(dataType);
            hasAnyChanges = true;
          } else {
            //(`🔄 GET ALL DATA: ⏭️ ${dataType} NO changes - skipping`);
          }
        } catch (checkError) {
          console.error(`Error checking ${dataType} changes:`, checkError);
          // If we can't check, assume there are changes to be safe
          changedDataTypes.push(dataType);
          hasAnyChanges = true;
        }
      }

      // If no changes detected, return early with needUpdate: false
      if (!hasAnyChanges) {
        //('🔄 GET ALL DATA: ✅ No data changes detected - returning needUpdate: false');
        return res.json({
          success: true,
          needUpdate: false,
          message: 'Data is up to date'
        });
      }

      //(`🔄 GET ALL DATA: 📥 Fetching data only for changed collections: ${changedDataTypes.join(', ')}`);

      // Log summary of what we're doing
      //(`🔄 GET ALL DATA: Efficiency improvement - fetching ${changedDataTypes.length}/${dataTypesToCheck.length} collections instead of all data`);
    } else {
      // No lastFetchTimes provided - fetch all data
      //('🔄 GET ALL DATA: No lastFetchTimes provided - fetching all data');
      changedDataTypes.push(...dataTypesToCheck);
    }

    // Fetch data for collections that need to be updated
    //(`🔄 GET ALL DATA: Fetching data for ${changedDataTypes.length} collections`);

    const fetchPromises = [];
    const fetchMap = {};

    // Only fetch data for changed collections
    changedDataTypes.forEach(dataType => {
      switch (dataType) {
        case 'customers':
          fetchPromises.push(Customer.find({ sellerId }).sort({ createdAt: -1 }));
          fetchMap.customers = fetchPromises.length - 1;
          break;
        case 'products':
          // Use the enhanced getProducts logic that includes batch data and total stock calculation
          fetchPromises.push((async () => {
            try {
              const products = await Product.find({ sellerId }).populate('categoryId', 'name').sort({ createdAt: -1 });
              //(`🔄 GET ALL DATA: Found ${products.length} products for seller ${sellerId}`);

              // Get all batches for this seller
              const ProductBatch = require('../models/ProductBatch');

              // First check total batches without seller filter
              const allBatches = await ProductBatch.find({ isDeleted: false });
              //(`🔄 GET ALL DATA: Total batches in DB: ${allBatches.length}`);

              // Check batches with different seller IDs
              const allBatchesWithSeller = await ProductBatch.find({ isDeleted: false }).select('sellerId productId quantity');
              //(`🔄 GET ALL DATA: All batches with seller IDs:`, allBatchesWithSeller.map(b => ({
                sellerId: b.sellerId?.toString(),
                productId: b.productId?.toString(),
                quantity: b.quantity
              })));

              const batches = await ProductBatch.find({
                sellerId,
                isDeleted: false
              }).populate('productId', 'name');
              //(`🔄 GET ALL DATA: Found ${batches.length} batches for seller ${sellerId}`);
              //(`🔄 GET ALL DATA: Seller ID being used: ${sellerId}`);

            // Group batches by product and calculate totals
            const productBatchData = {};
            //(`🔄 GET ALL DATA: Starting batch processing for ${batches.length} batches`);

            batches.forEach(batch => {
              // Skip batches with invalid productId references
              if (!batch.productId || !batch.productId._id) {
                console.warn('⚠️ GET ALL DATA: Skipping batch with invalid productId:', batch._id, 'productId:', batch.productId);
                return;
              }
              const productId = batch.productId._id.toString();
              //(`🔄 GET ALL DATA: Processing batch ${batch._id} for product ${productId} (${batch.productId?.name || 'NO NAME'}) - quantity: ${batch.quantity}, sellerId: ${batch.sellerId}`);

              if (!productBatchData[productId]) {
                productBatchData[productId] = {
                  totalStock: 0,
                  batches: [],
                  latestBatch: null
                };
              }
              productBatchData[productId].totalStock += batch.quantity;
              productBatchData[productId].batches.push(batch);

              // Track the latest batch for pricing (by expiry date, or creation date if no expiry)
              if (!productBatchData[productId].latestBatch ||
                  (batch.expiry && productBatchData[productId].latestBatch.expiry &&
                   batch.expiry > productBatchData[productId].latestBatch.expiry) ||
                  (!batch.expiry && !productBatchData[productId].latestBatch.expiry &&
                   batch.createdAt > productBatchData[productId].latestBatch.createdAt)) {
                productBatchData[productId].latestBatch = batch;
              }
            });

              //(`🔄 GET ALL DATA: Product batch data summary:`, Object.keys(productBatchData).map(productId => ({
                productId,
                totalStock: productBatchData[productId].totalStock,
                batchCount: productBatchData[productId].batches.length
              })));

              // Transform to match frontend format - now using batch data
              const formattedProducts = products.map(product => {
                const productId = product._id.toString();
                const batchData = productBatchData[productId] || { totalStock: 0, batches: [], latestBatch: null };

                //(`🔄 GET ALL DATA: Product ${product.name} (${productId}) - totalStock: ${batchData.totalStock}, batches: ${batchData.batches.length}`);

                return {
                  id: product._id.toString(),
                  name: product.name,
                  barcode: product.barcode || '',
                  categoryId: product.categoryId && product.categoryId._id ? product.categoryId._id.toString() : (typeof product.categoryId === 'string' ? product.categoryId : null),
                  category: product.categoryId ? product.categoryId.name : '',
                  stock: batchData.totalStock, // Now calculated from batches
                  quantity: batchData.totalStock, // Frontend compatibility
                  unit: product.unit || 'pcs',
                  costPrice: batchData.latestBatch ? batchData.latestBatch.costPrice : 0,
                  unitPrice: batchData.latestBatch ? batchData.latestBatch.costPrice : 0, // Frontend compatibility
                  sellingUnitPrice: batchData.latestBatch ? batchData.latestBatch.sellingUnitPrice : 0,
                  sellingPrice: batchData.latestBatch ? batchData.latestBatch.sellingUnitPrice : 0, // Backward compatibility
                  lowStockLevel: product.lowStockLevel || 10,
                  mfg: batchData.latestBatch ? batchData.latestBatch.mfg : null,
                  mfgDate: batchData.latestBatch ? batchData.latestBatch.mfg : null, // Backward compatibility
                  expiryDate: batchData.latestBatch ? batchData.latestBatch.expiry : null,
                  description: product.description || '',
                  isActive: product.isActive !== undefined ? product.isActive : true,
                  createdAt: product.createdAt,
                  updatedAt: product.updatedAt,
                  isSynced: true,
                  _id: product._id.toString(),
                  // Add batch information
                  batches: batchData.batches.map(batch => ({
                    id: batch._id.toString(),
                    batchNumber: batch.batchNumber,
                    mfg: batch.mfg,
                    expiry: batch.expiry,
                    quantity: batch.quantity,
                    costPrice: batch.costPrice,
                    sellingUnitPrice: batch.sellingUnitPrice,
                    createdAt: batch.createdAt,
                    updatedAt: batch.updatedAt
                  }))
                };
              });

              //(`🔄 GET ALL DATA: Returning ${formattedProducts.length} formatted products`);
              return formattedProducts;

            } catch (error) {
              console.error(`❌ GET ALL DATA: Error in products batch calculation:`, error);
              // Return products without batch data if there's an error
              const fallbackProducts = products.map(product => ({
                id: product._id.toString(),
                name: product.name,
                barcode: product.barcode || '',
                categoryId: product.categoryId && product.categoryId._id ? product.categoryId._id.toString() : (typeof product.categoryId === 'string' ? product.categoryId : null),
                category: product.categoryId ? product.categoryId.name : '',
                stock: 0, // Fallback to 0
                quantity: 0, // Fallback to 0
                unit: product.unit || 'pcs',
                costPrice: 0,
                unitPrice: 0,
                sellingUnitPrice: 0,
                sellingPrice: 0,
                lowStockLevel: product.lowStockLevel || 10,
                mfg: null,
                mfgDate: null,
                expiryDate: null,
                description: product.description || '',
                isActive: product.isActive !== undefined ? product.isActive : true,
                createdAt: product.createdAt,
                updatedAt: product.updatedAt,
                isSynced: true,
                _id: product._id.toString(),
                batches: [] // Empty batches array
              }));
              //(`🔄 GET ALL DATA: Returning ${fallbackProducts.length} fallback products due to error`);
              return fallbackProducts;
            }

            // Transform to match frontend format - now using batch data
            const formattedProducts = products.map(product => {
              const productId = product._id.toString();
              const batchData = productBatchData[productId] || { totalStock: 0, batches: [], latestBatch: null };

              //(`🔄 GET ALL DATA: Product ${product.name} (${productId}) - totalStock: ${batchData.totalStock}, batches: ${batchData.batches.length}`);

              return {
                id: product._id.toString(),
                name: product.name,
                barcode: product.barcode || '',
                categoryId: product.categoryId && product.categoryId._id ? product.categoryId._id.toString() : (typeof product.categoryId === 'string' ? product.categoryId : null),
                category: product.categoryId ? product.categoryId.name : '',
                stock: batchData.totalStock, // Now calculated from batches
                quantity: batchData.totalStock, // Frontend compatibility
                unit: product.unit || 'pcs',
                costPrice: batchData.latestBatch ? batchData.latestBatch.costPrice : 0,
                unitPrice: batchData.latestBatch ? batchData.latestBatch.costPrice : 0, // Frontend compatibility
                sellingUnitPrice: batchData.latestBatch ? batchData.latestBatch.sellingUnitPrice : 0,
                sellingPrice: batchData.latestBatch ? batchData.latestBatch.sellingUnitPrice : 0, // Backward compatibility
                lowStockLevel: product.lowStockLevel || 10,
                mfg: batchData.latestBatch ? batchData.latestBatch.mfg : null,
                mfgDate: batchData.latestBatch ? batchData.latestBatch.mfg : null, // Backward compatibility
                expiryDate: batchData.latestBatch ? batchData.latestBatch.expiry : null,
                description: product.description || '',
                isActive: product.isActive !== undefined ? product.isActive : true,
                createdAt: product.createdAt,
                updatedAt: product.updatedAt,
                isSynced: true,
                _id: product._id.toString(),
                // Add batch information
                batches: batchData.batches.map(batch => ({
                  id: batch._id.toString(),
                  batchNumber: batch.batchNumber,
                  mfg: batch.mfg,
                  expiry: batch.expiry,
                  quantity: batch.quantity,
                  costPrice: batch.costPrice,
                  sellingUnitPrice: batch.sellingUnitPrice,
                  createdAt: batch.createdAt,
                  updatedAt: batch.updatedAt
                }))
              };
            });

            //(`🔄 GET ALL DATA: Returning ${formattedProducts.length} formatted products`);
            return formattedProducts;
          })());
          fetchMap.products = fetchPromises.length - 1;
          break;
        case 'productBatches':
          const ProductBatchModel = require('../models/ProductBatch');
          fetchPromises.push(ProductBatchModel.find({ sellerId, isDeleted: false }).populate('productId', 'name').sort({ createdAt: -1 }));
          fetchMap.productBatches = fetchPromises.length - 1;
          break;
        case 'orders':
          fetchPromises.push(Order.find({ sellerId }).populate('customerId', 'name mobileNumber').lean().sort({ createdAt: -1 }));
          fetchMap.orders = fetchPromises.length - 1;
          break;
        case 'transactions':
          fetchPromises.push(Transaction.find({ sellerId }).sort({ createdAt: -1 }));
          fetchMap.transactions = fetchPromises.length - 1;
          break;
        case 'purchaseOrders':
          fetchPromises.push(VendorOrder.find({ sellerId }).sort({ createdAt: -1 }));
          fetchMap.purchaseOrders = fetchPromises.length - 1;
          break;
        case 'categories':
          fetchPromises.push(ProductCategory.find({ sellerId }).sort({ createdAt: -1 }));
          fetchMap.categories = fetchPromises.length - 1;
          break;
        case 'refunds':
          fetchPromises.push(Refund.find({ sellerId }).sort({ createdAt: -1 }));
          fetchMap.refunds = fetchPromises.length - 1;
          break;
        case 'plans':
          fetchPromises.push(require('../models/Plan').find({}).sort({ createdAt: -1 })); // Plans are global
          fetchMap.plans = fetchPromises.length - 1;
          break;
        case 'planOrders':
          fetchPromises.push(require('../models/PlanOrder').find({ sellerId }).sort({ createdAt: -1 }));
          fetchMap.planOrders = fetchPromises.length - 1;
          break;
      }
    });

    // Execute only the necessary queries
    const results = await Promise.all(fetchPromises);

    // Extract results into variables
    const customers = fetchMap.customers !== undefined ? results[fetchMap.customers] : [];
    const products = fetchMap.products !== undefined ? results[fetchMap.products] : [];
    const productBatches = fetchMap.productBatches !== undefined ? results[fetchMap.productBatches] : [];
    const orders = fetchMap.orders !== undefined ? results[fetchMap.orders] : [];
    const transactions = fetchMap.transactions !== undefined ? results[fetchMap.transactions] : [];
    const vendorOrders = fetchMap.purchaseOrders !== undefined ? results[fetchMap.purchaseOrders] : [];
    const categories = fetchMap.categories !== undefined ? results[fetchMap.categories] : [];
    const refunds = fetchMap.refunds !== undefined ? results[fetchMap.refunds] : [];
    const plans = fetchMap.plans !== undefined ? results[fetchMap.plans] : [];
    const planOrders = fetchMap.planOrders !== undefined ? results[fetchMap.planOrders] : [];

    // Format customers
    const formattedCustomers = customers.map(customer => ({
      id: customer._id.toString(),
      name: customer.name,
      mobileNumber: customer.mobileNumber,
      phone: customer.mobileNumber,
      email: customer.email,
      dueAmount: customer.dueAmount || 0,
      balanceDue: customer.dueAmount || 0, // Frontend compatibility - ensure balanceDue is set
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
      isSynced: true,
      _id: customer._id.toString()
    }));

    // Format plans (global data)
    const formattedPlans = plans.map(plan => ({
      id: plan._id.toString(),
      name: plan.name,
      price: plan.price || 0,
      durationDays: plan.durationDays || 30,
      planType: plan.planType || 'standard',
      maxCustomers: plan.maxCustomers,
      maxProducts: plan.maxProducts,
      maxOrders: plan.maxOrders,
      description: plan.description || '',
      features: plan.features || [],
      popular: plan.popular || false,
      unlockedModules: plan.unlockedModules || [],
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      isSynced: true,
      _id: plan._id.toString()
    }));

    // Format plan orders
    const formattedPlanOrders = planOrders.map(planOrder => ({
      id: planOrder._id.toString(),
      planId: planOrder.planId?.toString() || planOrder.planId,
      sellerId: planOrder.sellerId?.toString() || planOrder.sellerId,
      status: planOrder.status || 'active',
      paymentStatus: planOrder.paymentStatus || 'pending',
      paymentMethod: planOrder.paymentMethod || '',
      amount: planOrder.amount || 0,
      expiryDate: planOrder.expiryDate,
      razorpayOrderId: planOrder.razorpayOrderId || '',
      razorpayPaymentId: planOrder.razorpayPaymentId || '',
      createdAt: planOrder.createdAt,
      updatedAt: planOrder.updatedAt,
      isSynced: true,
      _id: planOrder._id.toString()
    }));


    // Format products - MongoDB uses 'stock' and 'costPrice'
    const formattedProducts = products.map(product => {
      return {
        id: product._id.toString(),
        name: product.name,
        barcode: product.barcode || '',
        categoryId: product.categoryId && product.categoryId._id ? product.categoryId._id.toString() : (typeof product.categoryId === 'string' ? product.categoryId : null),
        category: product.categoryId ? product.categoryId.name : '',
        stock: product.stock || 0, // MongoDB uses 'stock'
        quantity: product.stock || 0, // Frontend compatibility
        unit: product.unit || 'pcs',
        costPrice: product.costPrice || 0, // MongoDB uses 'costPrice'
        unitPrice: product.costPrice || 0, // Frontend compatibility
        sellingUnitPrice: product.sellingUnitPrice || 0,
        sellingPrice: product.sellingUnitPrice || 0, // Backward compatibility
        lowStockLevel: product.lowStockLevel || 10,
        trackExpiry: product.trackExpiry || false,
        mfg: product.mfg,
        mfgDate: product.mfg, // Backward compatibility
        expiryDate: product.expiryDate,
        description: product.description || '',
        isActive: product.isActive !== undefined ? product.isActive : true,
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
        isSynced: true,
        _id: product._id.toString()
      };
    });

    // Format product batches
    const formattedProductBatches = productBatches.map(batch => ({
      id: batch._id.toString(),
      sellerId: batch.sellerId?.toString(),
      productId: batch.productId?.toString(),
      batchNumber: batch.batchNumber || '',
      mfg: batch.mfg,
      expiry: batch.expiry,
      quantity: batch.quantity || 0,
      costPrice: batch.costPrice || 0,
      sellingUnitPrice: batch.sellingUnitPrice || 0,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      isSynced: true,
      _id: batch._id.toString()
    }));

    // Format orders
    const parseNumeric = (value) => {
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    };

    const formattedOrders = orders.map(order => {
      const items = order.items || [];
      const subtotalValue = parseNumeric(order.subtotal);
      const subtotal = subtotalValue !== null
        ? subtotalValue
        : items.reduce((sum, item) => {
          const price = parseNumeric(item.sellingPrice) ?? parseNumeric(item.price) ?? 0;
          const qty = parseNumeric(item.quantity) ?? 0;
          return sum + price * qty;
        }, 0);

      const rawDiscountAmount = parseNumeric(order.discount) ?? parseNumeric(order.discountAmount) ?? 0;
      const rawTaxAmount = parseNumeric(order.tax) ?? parseNumeric(order.taxAmount) ?? 0;

      const discountPercentValue = parseNumeric(order.discountPercent);
      const discountPercent = discountPercentValue !== null
        ? discountPercentValue
        : (subtotal > 0 ? (rawDiscountAmount / subtotal) * 100 : 0);

      const discountAmount = rawDiscountAmount > 0
        ? rawDiscountAmount
        : subtotal * (discountPercent / 100);

      const taxableBase = Math.max(0, subtotal - discountAmount);

      const taxPercentValue = parseNumeric(order.taxPercent);
      const taxPercent = taxPercentValue !== null
        ? taxPercentValue
        : (taxableBase > 0 ? (rawTaxAmount / taxableBase) * 100 : 0);

      const taxAmount = rawTaxAmount > 0
        ? rawTaxAmount
        : taxableBase * (taxPercent / 100);

      const totalAmountValue = parseNumeric(order.totalAmount);
      const totalAmount = totalAmountValue !== null
        ? totalAmountValue
        : Math.max(0, taxableBase + taxAmount);

      // Preserve splitPaymentDetails exactly as stored in MongoDB
      // Don't use || null as it will convert empty objects or objects with 0 values to null
      let splitPaymentDetails = null;
      if (order.splitPaymentDetails !== undefined && order.splitPaymentDetails !== null) {
        // Include splitPaymentDetails exactly as it is in MongoDB
        splitPaymentDetails = order.splitPaymentDetails;
      }

      return {
        id: order._id.toString(),
        sellerId: order.sellerId.toString(),
        customerId: order.customerId ? order.customerId._id.toString() : null,
        customerName: order.customerName || (order.customerId ? order.customerId.name : 'Walk-in Customer'),
        customerMobile: order.customerMobile || (order.customerId ? (order.customerId.mobileNumber || order.customerId.phone || '') : ''),
        paymentMethod: order.paymentMethod || 'cash',
        splitPaymentDetails: splitPaymentDetails,
        items,
        subtotal,
        discountPercent,
        discountAmount,
        taxPercent,
        taxAmount,
        totalAmount,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        isSynced: true,
        _id: order._id.toString()
      };
    });

    // Format transactions
    const formattedTransactions = transactions.map(transaction => ({
      id: transaction._id.toString(),
      type: transaction.type,
      customerId: transaction.customerId || null,
      customerName: transaction.customerName || '',
      amount: transaction.amount || 0,
      total: transaction.amount || 0,
      paymentMethod: transaction.paymentMethod || 'cash',
      description: transaction.description || '',
      date: transaction.date || transaction.createdAt,
      razorpayOrderId: transaction.razorpayOrderId || null,
      razorpayPaymentId: transaction.razorpayPaymentId || null,
      planOrderId: transaction.planOrderId ? transaction.planOrderId.toString() : null,
      planId: transaction.planId ? transaction.planId.toString() : null,
      status: transaction.status || 'completed',
      createdAt: transaction.createdAt,
      updatedAt: transaction.updatedAt,
      isSynced: true,
      _id: transaction._id.toString()
    }));

    // Format vendor orders
    const formattedVendorOrders = vendorOrders.map(order => ({
      id: order._id.toString(),
      supplierName: order.supplierName,
      items: order.items || [],
      total: order.total || 0,
      status: order.status || 'pending',
      notes: order.notes || '',
      expectedDeliveryDate: order.expectedDeliveryDate,
      actualDeliveryDate: order.actualDeliveryDate,
      cancelledAt: order.cancelledAt,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      isSynced: true,
      _id: order._id.toString()
    }));

    // Format categories
    const formattedCategories = categories.map(category => ({
      id: category._id.toString(),
      name: category.name,
      description: category.description || '',
      image: category.image || '',
      isActive: category.isActive !== undefined ? category.isActive : true,
      createdAt: category.createdAt,
      updatedAt: category.updatedAt,
      isSynced: true,
      _id: category._id.toString()
    }));

    // Format refunds
    const formattedRefunds = refunds.map(refund => ({
      id: refund._id.toString(),
      orderId: refund.orderId?.toString() || refund.orderId,
      customerId: refund.customerId?.toString() || refund.customerId || null,
      sellerId: refund.sellerId?.toString() || refund.sellerId,
      items: refund.items || [],
      totalRefundAmount: refund.totalRefundAmount || 0,
      reason: refund.reason || '',
      refundedByUser: refund.refundedByUser || '',
      createdAt: refund.createdAt,
      updatedAt: refund.updatedAt,
      isSynced: true,
      _id: refund._id.toString()
    }));

    // Build response data object with only changed collections
    const responseData = {};
    changedDataTypes.forEach(dataType => {
      switch (dataType) {
        case 'customers':
          responseData.customers = formattedCustomers;
          break;
        case 'products':
          responseData.products = formattedProducts;
          break;
        case 'productBatches':
          responseData.productBatches = formattedProductBatches;
          break;
        case 'orders':
          responseData.orders = formattedOrders;
          break;
        case 'transactions':
          responseData.transactions = formattedTransactions;
          break;
        case 'purchaseOrders':
          responseData.purchaseOrders = formattedVendorOrders;
          break;
        case 'categories':
          responseData.categories = formattedCategories;
          break;
        case 'refunds':
          responseData.refunds = formattedRefunds;
          break;
        case 'plans':
          responseData.plans = formattedPlans;
          break;
        case 'planOrders':
          responseData.planOrders = formattedPlanOrders;
          break;
      }
    });

    // Validate that all returned documents have proper timestamps
    let totalRecords = 0;
    let recordsWithTimestamps = 0;
    let recordsWithoutTimestamps = 0;

    for (const [collectionName, documents] of Object.entries(responseData)) {
      if (Array.isArray(documents)) {
        totalRecords += documents.length;
        for (const doc of documents) {
          if (doc.updatedAt) {
            recordsWithTimestamps++;
          } else {
            recordsWithoutTimestamps++;
            console.warn(`⚠️ Document in ${collectionName} missing updatedAt:`, doc.id || doc._id);
          }
        }
      }
    }

    //(`🔄 GET ALL DATA: Returning data for ${Object.keys(responseData).length} collections: ${Object.keys(responseData).join(', ')}`);
    //(`🔄 GET ALL DATA: Response includes ${totalRecords} total records (${recordsWithTimestamps} with timestamps, ${recordsWithoutTimestamps} without)`);

    if (recordsWithoutTimestamps > 0) {
      console.error(`❌ CRITICAL: ${recordsWithoutTimestamps} documents are missing timestamps! This will break delta sync.`);
    }

    res.json({
      success: true,
      needUpdate: true,
      data: responseData,
      serverTime: new Date().toISOString(),
      changedCollections: changedDataTypes,
      timestampValidation: {
        totalRecords,
        recordsWithTimestamps,
        recordsWithoutTimestamps
      }
    });
  } catch (error) {
    console.error('Get all data error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching all data',
      error: error.message
    });
  }
};

/**
 * Get all active plans
 * Optionally includes seller's current plan and active plan orders if sellerId is provided
 */
const getPlans = async (req, res) => {
  try {
    const plans = await Plan.find({ isActive: true }).sort({ price: 1 });

    // Get sellerId from request (from auth middleware, query, or header)
    const sellerId = req.sellerId || req.query.sellerId || req.headers['x-seller-id'];

    let currentPlanOrderId = null;
    let activePlanOrderIds = [];
    let sellerPlanInfo = null;

    // If sellerId is provided, fetch seller's plan information
    let activePlanIds = []; // Array of plan IDs that user has (from active plan orders)
    if (sellerId) {
      try {
        const seller = await Seller.findById(sellerId);
        if (seller && seller.currentPlanId) {
          currentPlanOrderId = seller.currentPlanId.toString();
        }

        const now = new Date();
        const planOrders = await PlanOrder.find({
          sellerId: sellerId,
          paymentStatus: 'completed'
        }).populate('planId', '_id name price durationDays unlockedModules lockedModules maxCustomers maxProducts maxOrders');

        const savePromises = [];
        const activePlanOrders = [];

        const buildPlanInfoPayload = (planOrder, remainingMs) => {
          if (!planOrder?.planId) {
            return null;
          }

          const safeRemainingMs = typeof remainingMs === 'number'
            ? remainingMs
            : computeRemainingMs(planOrder, planOrder.planId, now);

          const isExpired = safeRemainingMs <= 0;
          const expiryDate = planOrder.expiryDate
            || (safeRemainingMs > 0 ? new Date(now.getTime() + safeRemainingMs) : now);

          return {
            currentPlanOrderId: planOrder._id.toString(),
            currentPlanId: planOrder.planId && planOrder.planId._id ? planOrder.planId._id.toString() : planOrder.planId?.toString() || null,
            expiryDate,
            durationDays: planOrder.durationDays,
            isExpired,
            status: planOrder.status,
            remainingMs: safeRemainingMs,
            remaining: formatRemaining(Math.max(0, safeRemainingMs)),
            paymentStatus: planOrder.paymentStatus
          };
        };

        for (const planOrder of planOrders) {
          if (!planOrder.planId) continue;

          const remainingMs = computeRemainingMs(planOrder, planOrder.planId, now);

          planOrder._computedRemainingMs = remainingMs;

          if (remainingMs > 0) {
            const computedExpiry = new Date(now.getTime() + remainingMs);
            if (!planOrder.expiryDate || planOrder.expiryDate.getTime() !== computedExpiry.getTime()) {
              planOrder.expiryDate = computedExpiry;
              savePromises.push(planOrder.save());
            } else if (planOrder.status === 'expired') {
              planOrder.status = 'paused';
              savePromises.push(planOrder.save());
            }
            activePlanOrders.push(planOrder);
          } else if (planOrder.status !== 'expired') {
            planOrder.status = 'expired';
            planOrder.lastActivatedAt = null;
            planOrder.accumulatedUsedMs = getPlanDurationMs(planOrder.planId);
            planOrder.expiryDate = now;
            savePromises.push(planOrder.save());
          }
        }

        if (savePromises.length > 0) {
          await Promise.all(savePromises);
        }

        activePlanOrderIds = activePlanOrders.map(po => po._id.toString());
        activePlanIds = activePlanOrders
          .map(po => po.planId?._id?.toString())
          .filter(id => id);

        if (currentPlanOrderId) {
          const currentPlanOrder = planOrders.find(po => po._id.toString() === currentPlanOrderId) ||
            await PlanOrder.findById(currentPlanOrderId)
              .populate('planId', '_id name price durationDays unlockedModules lockedModules maxCustomers maxProducts maxOrders');

          if (currentPlanOrder && currentPlanOrder.planId) {
            const remainingMs = currentPlanOrder._computedRemainingMs ?? computeRemainingMs(currentPlanOrder, currentPlanOrder.planId, now);
            sellerPlanInfo = buildPlanInfoPayload(currentPlanOrder, remainingMs);
          }
        }

        if (!sellerPlanInfo || sellerPlanInfo.isExpired) {
          const activePlanForInfo = activePlanOrders
            .sort((a, b) => {
              const aExpiry = a.expiryDate ? a.expiryDate.getTime() : 0;
              const bExpiry = b.expiryDate ? b.expiryDate.getTime() : 0;
              return bExpiry - aExpiry;
            })
            .find(Boolean);

          if (activePlanForInfo) {
            sellerPlanInfo = buildPlanInfoPayload(
              activePlanForInfo,
              activePlanForInfo._computedRemainingMs
            );
          }
        }
      } catch (sellerError) {
        console.error('Error fetching seller plan info:', sellerError);
        // Continue without seller info if there's an error
      }
    }

    let usageSummary = null;
    let usagePlans = null;

    if (sellerId) {
      try {
        const usageData = await getPlanUsageSummary(sellerId);
        usageSummary = usageData.summary;
        usagePlans = usageData.planDetails;
        if (usagePlans && usagePlans.length > 0) {
          activePlanOrderIds = usagePlans.map(plan => plan.planOrderId);
          activePlanIds = usagePlans.map(plan => plan.planId);
        }
      } catch (usageError) {
        console.error('Error computing plan usage summary:', usageError);
      }
    }

    // Transform to match frontend format
    const formattedPlans = plans.map(plan => {
      const planId = plan._id.toString();

      // Convert durationDays to period string
      let period = 'per month';
      if (plan.durationDays === 30) {
        period = 'per month';
      } else if (plan.durationDays === 90) {
        period = 'per 3 months';
      } else if (plan.durationDays === 365) {
        period = 'per year';
      } else {
        period = `per ${plan.durationDays} days`;
      }

      // Format price with currency symbol
      const formattedPrice = `₹${plan.price}`;

      // Handle unlimited limits - only null/undefined means unlimited, 0 is a valid limit
      const maxCustomers = plan.maxCustomers === null || plan.maxCustomers === undefined
        ? 'Unlimited'
        : plan.maxCustomers;
      const maxProducts = plan.maxProducts === null || plan.maxProducts === undefined
        ? 'Unlimited'
        : plan.maxProducts;
      const maxOrders = plan.maxOrders === null || plan.maxOrders === undefined
        ? 'Unlimited'
        : plan.maxOrders;

      // Determine color and icon based on price (you can customize this logic)
      let color = 'green';
      let icon = '🥉';
      if (plan.price >= 1000) {
        color = 'purple';
        icon = '🥇';
      } else if (plan.price >= 500) {
        color = 'blue';
        icon = '🥈';
      }

      // Determine if popular (middle tier or highest)
      const sortedPlans = [...plans].sort((a, b) => a.price - b.price);
      const popular = sortedPlans.length > 1 && plan._id.toString() === sortedPlans[Math.floor(sortedPlans.length / 2)]._id.toString();

      // Check if this is the current plan
      const isCurrentPlan = sellerPlanInfo && sellerPlanInfo.currentPlanId === planId;

      // Check if user has this plan (from active plan orders)
      const userHasThisPlan = activePlanIds.includes(planId);

      return {
        id: planId,
        name: plan.name,
        price: formattedPrice,
        period: period,
        maxCustomers: maxCustomers,
        maxProducts: maxProducts,
        maxOrders: maxOrders,
        unlockedModules: plan.unlockedModules || [],
        lockedModules: plan.lockedModules || [],
        description: plan.description || '',
        color: color,
        icon: icon,
        popular: popular,
        _id: planId,
        durationDays: plan.durationDays,
        rawPrice: plan.price,
        planType: plan.planType || 'standard', // Include planType from database
        // Seller-specific information
        isCurrentPlan: isCurrentPlan,
        userHasThisPlan: userHasThisPlan
      };
    });

    res.json({
      success: true,
      data: formattedPlans,
      sellerPlanInfo: sellerPlanInfo || null,
      activePlanOrdersCount: activePlanOrderIds.length,
      usageSummary,
      usagePlans
    });
  } catch (error) {
    console.error('Get plans error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching plans',
      error: error.message
    });
  }
};

/**
 * Upgrade/Purchase a plan
 * Creates a PlanOrder and sets it as the seller's current plan
 */
const upgradePlan = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const { planId } = req.body;

    if (!sellerId) {
      return res.status(401).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    if (!planId) {
      return res.status(400).json({
        success: false,
        message: 'Plan ID is required'
      });
    }

    // Verify seller exists
    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({
        success: false,
        message: 'Seller not found'
      });
    }

    // Verify plan exists and is active
    const plan = await Plan.findById(planId);
    if (!plan) {
      return res.status(404).json({
        success: false,
        message: 'Plan not found'
      });
    }

    if (!plan.isActive) {
      return res.status(400).json({
        success: false,
        message: 'Plan is not active'
      });
    }

    // Check if user's current plan is valid before allowing free plan purchases
    if (plan.price === 0 && plan.planType !== 'mini') {
      // If user doesn't have a current plan set, they can't get free plans
      if (!seller.currentPlanId) {
        return res.status(400).json({
          success: false,
          message: 'Free plans require an active current plan. Please upgrade to a paid plan first.'
        });
      }

      // Check if the current plan is valid (not expired)
      const currentPlanOrder = await PlanOrder.findById(seller.currentPlanId).populate('planId');
      if (!currentPlanOrder) {
        return res.status(400).json({
          success: false,
          message: 'Current plan not found. Please upgrade to a paid plan first.'
        });
      }

      // Check if current plan is valid (not expired and has remaining time)
      const now = new Date();
      const remainingMs = computeRemainingMs(currentPlanOrder, currentPlanOrder.planId, now);

      if (remainingMs <= 0 || currentPlanOrder.status === 'expired') {
        return res.status(400).json({
          success: false,
          message: 'Your current plan has expired. Free plans require an active current plan. Please renew your subscription first.'
        });
      }
    }

    // For mini plans: Check if user has at least one non-mini plan
    if (plan.planType === 'mini') {
      // Get all user's plan orders
      const allPlanOrders = await PlanOrder.find({
        sellerId: seller._id,
        status: { $in: ['active', 'paused'] }
      }).populate('planId');

      // Check if user has any non-mini plans
      const hasNonMiniPlan = allPlanOrders.some(order =>
        order.planId && order.planId.planType !== 'mini'
      );

      if (!hasNonMiniPlan) {
        return res.status(400).json({
          success: false,
          message: 'Mini plans require at least one non-mini plan. Please purchase a Standard or Premium plan first.'
        });
      }
    }

    // For mini plans, skip checking existing orders - always create new order for top-ups
    // For other plans, check if user already has this plan
    let existingPlanOrder = null;
    if (plan.planType !== 'mini') {
      existingPlanOrder = await PlanOrder.findOne({
        sellerId: seller._id,
        planId: plan._id,
      }).sort({ createdAt: -1 }).populate('planId');

      if (plan.price === 0 && existingPlanOrder && existingPlanOrder.paymentStatus === 'completed') {
        const planDocument = existingPlanOrder.planId && existingPlanOrder.planId.durationDays !== undefined
          ? existingPlanOrder.planId
          : plan;
        const remainingMs = computeRemainingMs(existingPlanOrder, planDocument, new Date());
        if (remainingMs <= 0) {
          return res.status(400).json({
            success: false,
            message: 'You have already claimed the free plan. Please choose a paid plan to continue.'
          });
        }
      }
    }

    //(`🔄 Plan upgrade: Activating plan "${plan.name}" for seller ${seller.name} (free plan or existing plan switch)`);

    const activationResult = await setActivePlanForSeller({
      sellerId: seller._id,
      planId: plan._id,
      allowCreateOnMissing: false, // Only switch to existing planOrders, don't create new ones
    });

    if (activationResult.success) {
      //(`✅ Plan activation successful: ${plan.name} is now active, previous plans paused`);
    } else {
      //(`❌ Plan activation failed: ${activationResult.message}`);
    }

    if (!activationResult.success) {
      return res.status(activationResult.statusCode || 500).json({
        success: false,
        message: activationResult.message,
        error: activationResult.error,
      });
    }

    const planOrder = await PlanOrder.findById(activationResult.data.planOrderId);
    const createdRecently = planOrder && planOrder.createdAt
      ? (Date.now() - planOrder.createdAt.getTime()) < 5000
      : false;

    // For mini plans, always treat as new order (top-up)
    // For other plans, check if it's a new order or existing one being activated
    const isNewOrder = plan.planType === 'mini' || !existingPlanOrder || createdRecently;

    if (plan.planType === 'mini') {
      //(`✅ Mini plan top-up: Seller ${seller.name} (${seller.email}) topped up with plan "${plan.name}"`);
    } else if (isNewOrder) {
      //(`✅ Plan upgraded: Seller ${seller.name} (${seller.email}) upgraded to plan "${plan.name}"`);
    } else {
      //(`✅ Plan activated: Seller ${seller.name} (${seller.email}) activated plan "${plan.name}"`);
    }

    // Update sync tracking for plan orders and plans
    try {
      await Promise.all([
        SyncTracking.updateLatestTime(seller._id, 'planOrders'),
        SyncTracking.updateLatestTime(seller._id, 'plans')
      ]);
      //(`🔄 Sync tracking updated: planOrders and plans for seller ${seller.name}`);
    } catch (trackingError) {
      console.error('Error updating sync tracking for plan upgrade:', trackingError);
    }

    res.json({
      success: true,
      message: plan.planType === 'mini'
        ? `Successfully topped up with ${plan.name}`
        : isNewOrder
          ? `Successfully upgraded to ${plan.name}`
          : activationResult.message || `Successfully activated ${plan.name}`,
      data: {
        planOrderId: activationResult.data.planOrderId,
        planId: plan._id.toString(),
        planName: plan.name,
        expiryDate: planOrder ? planOrder.expiryDate : null,
        paymentStatus: planOrder ? planOrder.paymentStatus : 'pending',
        price: plan.price,
        isNewOrder,
        status: activationResult.data.status,
        remainingMs: activationResult.data.remainingMs,
        remaining: activationResult.data.remaining,
      }
    });
  } catch (error) {
    console.error('Upgrade plan error:', error);
    res.status(500).json({
      success: false,
      message: 'Error upgrading plan',
      error: error.message
    });
  }
};

/**
 * Get seller's current plan details including unlocked modules
 */
const getCurrentPlan = async (req, res) => {
  try {
    const sellerId = req.sellerId;

    if (!sellerId) {
      return res.status(401).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    // Verify seller exists
    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({
        success: false,
        message: 'Seller not found'
      });
    }

    if (!seller.currentPlanId) {
      return res.json({
        success: true,
        data: null,
        message: 'No plan assigned to seller'
      });
    }

    const now = new Date();
    const allPlanOrders = await PlanOrder.find({ sellerId }).populate('planId');

    let planOrder = null;
    if (seller.currentPlanId) {
      planOrder = allPlanOrders.find((order) => order._id.equals(seller.currentPlanId));
    }

    if (!planOrder && seller.currentPlanId) {
      planOrder = await PlanOrder.findById(seller.currentPlanId).populate('planId');
      if (planOrder) {
        allPlanOrders.push(planOrder);
      }
    }

    if (!planOrder || !planOrder.planId) {
      return res.json({
        success: true,
        data: null,
        message: 'Plan order or plan not found'
      });
    }

    const plan = planOrder.planId;
    const remainingMs = computeRemainingMs(planOrder, plan, now);
    let status = planOrder.status;
    let expiryDate = planOrder.expiryDate;
    let shouldSave = false;

    if (remainingMs <= 0) {
      status = 'expired';
      expiryDate = now;
      if (planOrder.status !== 'expired' || planOrder.expiryDate.getTime() !== expiryDate.getTime()) {
        planOrder.status = 'expired';
        planOrder.lastActivatedAt = null;
        planOrder.accumulatedUsedMs = getPlanDurationMs(plan);
        planOrder.expiryDate = expiryDate;
        shouldSave = true;
      }
    } else {
      const computedExpiry = new Date(now.getTime() + remainingMs);
      expiryDate = computedExpiry;
      if (!planOrder.expiryDate || planOrder.expiryDate.getTime() !== computedExpiry.getTime()) {
        planOrder.expiryDate = computedExpiry;
        shouldSave = true;
      }
      if (planOrder.status === 'expired') {
        planOrder.status = 'paused';
        shouldSave = true;
      }
      status = planOrder.status;
    }

    if (shouldSave) {
      await planOrder.save();
    }

    const COMPLETED_PAYMENT_STATUSES = new Set(['completed', 'paid', 'success', 'successful', 'captured', 'active']);
    const normalizedPlanOrders = allPlanOrders.map((order) => {
      const planDoc = order.planId;
      const remaining = planDoc ? computeRemainingMs(order, planDoc, now) : 0;
      const expiresAt = order.expiryDate || (remaining > 0 ? new Date(now.getTime() + remaining) : null);
      const paymentStatus = (order.paymentStatus || '').toLowerCase();
      return {
        id: order._id.toString(),
        planId: planDoc ? planDoc._id.toString() : null,
        planName: planDoc ? planDoc.name : null,
        paymentStatus: order.paymentStatus || null,
        isPaymentCompleted: COMPLETED_PAYMENT_STATUSES.has(paymentStatus),
        remainingMs: remaining,
        remaining: formatRemaining(Math.max(0, remaining)),
        expiresAt,
        status: remaining > 0 ? (order.status || 'active') : 'expired',
        rawStatus: order.status || null,
        durationDays: order.durationDays,
        price: order.price,
        lastActivatedAt: order.lastActivatedAt
      };
    });

    const isExpired = status === 'expired';
    const planPaymentCompleted = COMPLETED_PAYMENT_STATUSES.has((planOrder.paymentStatus || '').toLowerCase());

    if (isExpired || !planPaymentCompleted) {
      const validOrders = normalizedPlanOrders
        .filter((order) => order.planId && order.id !== planOrder._id.toString())
        .filter((order) => order.isPaymentCompleted && order.remainingMs > 0)
        .sort((a, b) => {
          if (a.remainingMs !== b.remainingMs) {
            return a.remainingMs - b.remainingMs;
          }
          const expiryA = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.POSITIVE_INFINITY;
          const expiryB = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.POSITIVE_INFINITY;
          return expiryA - expiryB;
        });

      if (validOrders.length > 0) {
        const fallbackOrder = validOrders[0];
        try {
          const activationResult = await setActivePlanForSeller({
            sellerId,
            planOrderId: fallbackOrder.id,
            allowCreateOnMissing: false
          });

          if (activationResult.success) {
            return getCurrentPlan(req, res);
          }
        } catch (switchError) {
          console.error('Error auto-switching to fallback plan:', switchError);
        }
      }
    }

    const customerLimit = planOrder.customerLimit ?? plan.maxCustomers ?? null;
    const productLimit = planOrder.productLimit ?? plan.maxProducts ?? null;
    const orderLimit = planOrder.orderLimit ?? plan.maxOrders ?? null;

    let usageSummary = null;
    try {
      const usageData = await getPlanUsageSummary(sellerId);
      usageSummary = usageData.summary;
    } catch (usageError) {
      console.error('Error getting usage summary in getCurrentPlan:', usageError);
    }

    res.json({
      success: true,
      data: {
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
        status,
        remainingMs,
        remaining: formatRemaining(remainingMs),
        paymentStatus: planOrder.paymentStatus,
        price: plan.price,
        usageSummary,
        planOrders: normalizedPlanOrders
      }
    });
  } catch (error) {
    console.error('Get current plan error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching current plan',
      error: error.message
    });
  }
};

/**
 * Create Razorpay order for plan purchase
 */
const createRazorpayOrder = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const { planId } = req.body;

    if (!sellerId) {
      return res.status(401).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    if (!planId) {
      return res.status(400).json({
        success: false,
        message: 'Plan ID is required'
      });
    }

    // Verify seller exists
    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({
        success: false,
        message: 'Seller not found'
      });
    }

    // Verify plan exists and is active
    const plan = await Plan.findById(planId);
    if (!plan) {
      return res.status(404).json({
        success: false,
        message: 'Plan not found'
      });
    }

    if (!plan.isActive) {
      return res.status(400).json({
        success: false,
        message: 'Plan is not active'
      });
    }

    // Check if user's current plan is valid before allowing free plan purchases
    if (plan.price === 0 && plan.planType !== 'mini') {
      // If user doesn't have a current plan set, they can't get free plans
      if (!seller.currentPlanId) {
        return res.status(400).json({
          success: false,
          message: 'Free plans require an active current plan. Please upgrade to a paid plan first.'
        });
      }

      // Check if the current plan is valid (not expired)
      const currentPlanOrder = await PlanOrder.findById(seller.currentPlanId).populate('planId');
      if (!currentPlanOrder) {
        return res.status(400).json({
          success: false,
          message: 'Current plan not found. Please upgrade to a paid plan first.'
        });
      }

      // Check if current plan is valid (not expired and has remaining time)
      const now = new Date();
      const remainingMs = computeRemainingMs(currentPlanOrder, currentPlanOrder.planId, now);

      if (remainingMs <= 0 || currentPlanOrder.status === 'expired') {
        return res.status(400).json({
          success: false,
          message: 'Your current plan has expired. Free plans require an active current plan. Please renew your subscription first.'
        });
      }
    }

    // If plan is free, return success without creating Razorpay order
    if (plan.price === 0) {
      return res.json({
        success: true,
        data: {
          isFree: true,
          message: 'Plan is free, no payment required'
        }
      });
    }

    // Check if Razorpay is configured
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({
        success: false,
        message: 'Razorpay is not configured. Please contact administrator.'
      });
    }

    // Convert price to paise (Razorpay uses smallest currency unit)
    const amountInPaise = convertToPaise(plan.price);

    // Create Razorpay order
    const razorpayOrder = await createOrder(amountInPaise, 'INR', {
      sellerId: sellerId.toString(),
      planId: planId.toString(),
      planName: plan.name
    });

    res.json({
      success: true,
      data: {
        orderId: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        key: process.env.RAZORPAY_KEY_ID,
        planId: plan._id.toString(),
        planName: plan.name,
        amountInRupees: plan.price
      }
    });
  } catch (error) {
    console.error('Create Razorpay order error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating Razorpay order',
      error: error.message
    });
  }
};

/**
 * Verify Razorpay payment and complete plan upgrade
 */
const verifyRazorpayPayment = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const {
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      planId,
      planOrderId
    } = req.body;

    if (!sellerId) {
      return res.status(401).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({
        success: false,
        message: 'Payment details are required'
      });
    }

    // Verify seller exists
    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({
        success: false,
        message: 'Seller not found'
      });
    }

    // Verify payment signature
    const isSignatureValid = verifyPayment(razorpayOrderId, razorpayPaymentId, razorpaySignature);

    if (!isSignatureValid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment signature'
      });
    }

    let planOrder = null;
    let planDoc = null;

    if (planOrderId) {
      planOrder = await PlanOrder.findById(planOrderId).populate('planId');
      planDoc = planOrder?.planId || null;
    }

    if (!planOrder) {
      planOrder = await PlanOrder.findOne({
        razorpayOrderId: razorpayOrderId,
        sellerId: seller._id
      }).populate('planId');
      planDoc = planOrder?.planId || null;
    }

    if (!planOrder && planOrderId) {
      return res.status(404).json({
        success: false,
        message: 'Plan order not found'
      });
    }

    if (!planDoc) {
      if (!planId) {
        return res.status(400).json({
          success: false,
          message: 'Plan ID is required to finalize purchase'
        });
      }
      planDoc = await Plan.findById(planId);
      if (!planDoc) {
        return res.status(404).json({
          success: false,
          message: 'Plan not found'
        });
      }
    }

    if (planOrder) {
      if (planOrder.sellerId.toString() !== sellerId) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized access to plan order'
        });
      }

      if (planOrder.razorpayOrderId !== razorpayOrderId) {
        return res.status(400).json({
          success: false,
          message: 'Order ID mismatch'
        });
      }

      if (planOrder.paymentStatus === 'completed') {
        return res.json({
          success: true,
          message: 'Payment already completed',
          data: {
            planOrderId: planOrder._id.toString(),
            planId: planOrder.planId && planOrder.planId._id ? planOrder.planId._id.toString() : planOrder.planId?.toString() || null,
            planName: planOrder.planId && planOrder.planId.name ? planOrder.planId.name : 'Unknown Plan',
            status: planOrder.status,
            expiryDate: planOrder.expiryDate,
            paymentStatus: planOrder.paymentStatus
          }
        });
      }

      planOrder.razorpayPaymentId = razorpayPaymentId;
      planOrder.razorpaySignature = razorpaySignature;
      planOrder.paymentStatus = 'completed';

      // For mini plans, set status as 'active' - they are now fully activated
      // For other plans, activate immediately
      const isMiniPlan = planDoc?.planType === 'mini';
      if (isMiniPlan) {
        planOrder.status = 'active';
        planOrder.lastActivatedAt = new Date(); // Set activation time for mini plans
      } else {
        planOrder.status = 'active';
        planOrder.lastActivatedAt = new Date();
      }

      planOrder.accumulatedUsedMs = 0;
      const expiryDate = isMiniPlan
        ? new Date(new Date().getTime() + getPlanDurationMs(planDoc))
        : new Date(planOrder.lastActivatedAt.getTime() + getPlanDurationMs(planDoc));
      planOrder.expiryDate = expiryDate;
      await planOrder.save();
    } else {
      // For mini plans, create order with 'active' status (they are now fully activated)
      // For other plans, create with 'active' status
      const isMiniPlan = planDoc?.planType === 'mini';
      const now = new Date();
      const expiryDate = new Date(now.getTime() + getPlanDurationMs(planDoc));

      planOrder = new PlanOrder({
        sellerId: seller._id,
        planId: planDoc._id,
        expiryDate,
        durationDays: planDoc.durationDays || 30,
        price: planDoc.price,
        razorpayOrderId,
        razorpayPaymentId,
        razorpaySignature,
        paymentStatus: 'completed',
        status: isMiniPlan ? 'active' : 'active',
        lastActivatedAt: isMiniPlan ? now : now,
        accumulatedUsedMs: 0,
        customerLimit: planDoc.maxCustomers ?? null,
        productLimit: planDoc.maxProducts ?? null,
        orderLimit: planDoc.maxOrders ?? null,
        customerCurrentCount: 0,
        productCurrentCount: 0,
        orderCurrentCount: 0
      });
      await planOrder.save();
    }

    // Ensure planDoc is populated with planType (needed to check if it's a mini plan)
    if (!planDoc || !planDoc.planType) {
      // If planOrder.planId is populated, use it; otherwise fetch from database
      if (planOrder.planId && typeof planOrder.planId === 'object' && planOrder.planId.planType) {
        planDoc = planOrder.planId;
      } else {
        planDoc = await Plan.findById(planOrder.planId).select('planType name');
        if (!planDoc) {
          planDoc = await Plan.findById(planOrder.planId);
        }
      }
    }

    // For non-mini plans, activate the plan and pause previous plans
    // Mini plans are top-ups and don't switch the current plan
    const planType = planDoc?.planType;
    if (planType && planType !== 'mini') {
      //(`🔄 Switching plan: Activating plan "${planDoc?.name}" and pausing previous plans for seller ${seller.name}`);

      // Use setActivePlanForSeller to properly switch plans and pause previous ones
      const activationResult = await setActivePlanForSeller({
        sellerId: seller._id,
        planOrderId: planOrder._id.toString(),
        allowCreateOnMissing: false,
      });

      if (!activationResult.success) {
        console.error('❌ Failed to activate plan after payment:', activationResult.message);
        // Still return success since payment was completed, but log the error
      } else {
        //(`✅ Plan switched successfully: ${planDoc?.name} is now active`);
      }
    } else if (planType === 'mini') {
      // Mini plan top-up: create the planOrder but don't update currentPlanId
      //(`✅ Mini plan top-up: Seller ${seller.name} (${seller.email}) topped up with plan "${planDoc?.name || 'Mini Plan'}" - PlanOrder created but currentPlanId not updated`);
    }

    // Update sync tracking for plan orders and plans
    try {
      await Promise.all([
        SyncTracking.updateLatestTime(sellerId, 'planOrders'),
        SyncTracking.updateLatestTime(sellerId, 'plans')
      ]);
    } catch (trackingError) {
      console.error('Error updating sync tracking for plan upgrade:', trackingError);
    }

    // Create Transaction record
    const transaction = new Transaction({
      sellerId: seller._id,
      type: 'plan_purchase',
      amount: planOrder.price,
      paymentMethod: 'razorpay',
      description: `Plan purchase: ${planDoc?.name || 'Plan'}`,
      razorpayOrderId: razorpayOrderId,
      razorpayPaymentId: razorpayPaymentId,
      planOrderId: planOrder._id,
      planId: planDoc?._id || planOrder.planId
    });
    await transaction.save();

    //(`✅ Payment verified: Seller ${seller.name} (${seller.email}) purchased plan "${planDoc?.name || 'Plan'}"`);

    const planIdString = planDoc?._id?.toString() ||
      (planOrder.planId && typeof planOrder.planId === 'object' && planOrder.planId._id
        ? planOrder.planId._id.toString()
        : (planOrder.planId ? planOrder.planId.toString() : null));

    res.json({
      success: true,
      message: `Successfully upgraded to ${planDoc?.name || 'selected plan'}`,
      data: {
        planOrderId: planOrder._id.toString(),
        planId: planIdString,
        planName: planDoc?.name || planOrder.planId.name,
        expiryDate: planOrder.expiryDate,
        paymentStatus: planOrder.paymentStatus,
        price: planOrder.price,
        transactionId: transaction._id.toString()
      }
    });
  } catch (error) {
    console.error('Verify Razorpay payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Error verifying payment',
      error: error.message
    });
  }
};

/**
 * Update seller settings (e.g., UPI ID)
 */
const getSellerProfile = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    //('[Backend] GET /seller/profile - sellerId:', sellerId);

    if (!sellerId) {
      console.warn('[Backend] GET /seller/profile - No sellerId provided');
      return res.status(401).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    const seller = await Seller.findById(sellerId);
    if (!seller) {
      console.warn('[Backend] GET /seller/profile - Seller not found for ID:', sellerId);
      return res.status(404).json({
        success: false,
        message: 'Seller not found'
      });
    }

    //('[Backend] GET /seller/profile - Seller found:', {
      _id: seller._id,
      name: seller.name,
      email: seller.email,
      shopName: seller.shopName,
      phoneNumber: seller.phoneNumber,
      city: seller.city,
      pincode: seller.pincode,
      shopAddress: seller.shopAddress,
      businessCategory: seller.businessCategory,
      upiId: seller.upiId
    });

    const sellerData = {
      _id: seller._id.toString(),
      sellerId: seller._id.toString(), // Also include as sellerId for compatibility
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
    };

    res.json({
      success: true,
      data: {
        seller: sellerData
      }
    });
  } catch (error) {
    console.error('[Backend] Get seller profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching seller profile',
      error: error.message
    });
  }
};

const updateSellerSettings = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    if (!sellerId) {
      return res.status(401).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return res.status(404).json({
        success: false,
        message: 'Seller not found'
      });
    }

    const {
      upiId,
      username,
      phone,
      address,
      city,
      state,
      pincode,
      businessType,
      businessCategory, // For backward compatibility
      storeName,
      gstNumber,
      lowStockThreshold,
      expiryDaysThreshold
    } = req.body || {};

    // Update UPI ID
    if (upiId !== undefined) {
      const trimmedUpi = typeof upiId === 'string' ? upiId.trim() : '';
      seller.upiId = trimmedUpi.length > 0 ? trimmedUpi : null;
    }

    // Update seller name/username
    if (username !== undefined && username.trim().length > 0) {
      seller.name = username.trim();
    }

    // Update phone number
    if (phone !== undefined) {
      seller.phoneNumber = phone.trim() || null;
    }

    // Update business address
    if (address !== undefined) {
      seller.shopAddress = address.trim() || null;
    }

    // Update city
    if (city !== undefined) {
      seller.city = city.trim() || null;
    }

    // Update state
    if (state !== undefined) {
      seller.state = state.trim() || null;
    }

    // Update pincode
    if (pincode !== undefined) {
      seller.pincode = pincode.trim() || null;
    }

    // Update business type (prefer businessType over businessCategory for backward compatibility)
    const businessTypeValue = businessType !== undefined ? businessType : businessCategory;
    if (businessTypeValue !== undefined) {
      seller.businessType = businessTypeValue.trim() || null;
      // Also update businessCategory for backward compatibility if it exists
      if (businessCategory !== undefined) {
        seller.businessCategory = businessCategory.trim() || null;
      }
    }

    // Update store name
    if (storeName !== undefined && storeName.trim().length > 0) {
      seller.shopName = storeName.trim();
    }

    // Update GST number
    if (gstNumber !== undefined) {
      seller.gstNumber = gstNumber.trim() || null;
    }

    // Update low stock threshold
    if (lowStockThreshold !== undefined) {
      const threshold = parseInt(lowStockThreshold);
      if (!isNaN(threshold) && threshold >= 0) {
        seller.lowStockThreshold = threshold;
      }
    }

    // Update expiry days threshold
    if (expiryDaysThreshold !== undefined) {
      const threshold = parseInt(expiryDaysThreshold);
      if (!isNaN(threshold) && threshold >= 0) {
        seller.expiryDaysThreshold = threshold;
      }
    }

    // Update last activity date
    seller.lastActivityDate = new Date();

    await seller.save();

    res.json({
      success: true,
      message: 'Seller settings updated successfully',
      data: {
        seller: {
          _id: seller._id,
          name: seller.name,
          email: seller.email,
          upiId: seller.upiId,
          phoneNumber: seller.phoneNumber,
          shopName: seller.shopName,
          shopAddress: seller.shopAddress,
          city: seller.city,
          state: seller.state,
          pincode: seller.pincode,
          gstNumber: seller.gstNumber,
          businessType: seller.businessType,
          businessCategory: seller.businessCategory, // For backward compatibility
          lowStockThreshold: seller.lowStockThreshold,
          expiryDaysThreshold: seller.expiryDaysThreshold,
          profilePicture: seller.profilePicture,
          lastActivityDate: seller.lastActivityDate
        }
      }
    });
  } catch (error) {
    console.error('Update seller settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating seller settings',
      error: error.message
    });
  }
};

/**
 * Get sync tracking information - returns latest update times for all data types
 */
const getSyncTracking = async (req, res) => {
  try {
    const sellerId = req.sellerId;

    if (!sellerId) {
      return res.status(401).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    const trackingData = await SyncTracking.getLatestUpdateTimes(sellerId);

    res.json({
      success: true,
      data: trackingData,
      serverTime: new Date()
    });
  } catch (error) {
    console.error('Get sync tracking error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching sync tracking data',
      error: error.message
    });
  }
};

/**
 * Get delta sync data - returns only updated data based on client's last sync times
 */
const getDeltaSync = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const lastFetchTimes = req.query.lastFetchTimes || req.body.lastFetchTimes;

    if (!sellerId) {
      return res.status(401).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    if (!lastFetchTimes || typeof lastFetchTimes !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'lastFetchTimes object is required'
      });
    }

    // Get delta information
    const { deltaData, needsFullSync } = await SyncTracking.getDeltaData(sellerId, lastFetchTimes);

    const result = {
      needsFullSync,
      deltaInfo: deltaData,
      data: {}
    };

    // Fetch updated data for data types that need updates
    const dataTypesToFetch = Object.keys(deltaData).filter(dataType => deltaData[dataType].needsUpdate);

    if (dataTypesToFetch.length > 0) {
      // Use Promise.allSettled to handle partial failures
      const fetchPromises = dataTypesToFetch.map(async (dataType) => {
        try {
          const lastFetchTime = lastFetchTimes[dataType];
          let query = { sellerId };

          // Only fetch records updated after lastFetchTime if provided
          if (lastFetchTime) {
            query.updatedAt = { $gt: new Date(lastFetchTime) };
          }

          let data = [];
          let model;

          switch (dataType) {
            case 'customers':
              model = Customer;
              data = await Customer.find(query).sort({ updatedAt: -1 });
              break;
            case 'products':
              model = Product;
              data = await Product.find(query).populate('categoryId', 'name').sort({ updatedAt: -1 });
              break;
            case 'categories':
              model = ProductCategory;
              data = await ProductCategory.find(query).sort({ updatedAt: -1 });
              break;
            case 'orders':
              model = Order;
              data = await Order.find(query).populate('customerId', 'name mobileNumber').lean().sort({ updatedAt: -1 });
              break;
            case 'transactions':
              model = Transaction;
              data = await Transaction.find(query).sort({ updatedAt: -1 });
              break;
            case 'purchaseOrders':
            case 'vendorOrders': // Backward compatibility
              model = VendorOrder;
              data = await VendorOrder.find(query).sort({ updatedAt: -1 });
              break;

            case 'staff':
              // For now, staff data might not exist in MongoDB
              // This is for future staff management functionality
              data = [];
              break;
            case 'refunds':
              model = Refund;
              data = await Refund.find(query).sort({ updatedAt: -1 });
              break;
            default:
              console.warn(`Unknown data type for delta sync: ${dataType}`);
              return { dataType, data: [], error: 'Unknown data type' };
          }

          // Format data like the regular endpoints
          let formattedData;
          switch (dataType) {
            case 'customers':
              formattedData = data.map(customer => ({
                id: customer._id.toString(),
                name: customer.name,
                mobileNumber: customer.mobileNumber,
                phone: customer.mobileNumber,
                email: customer.email,
                dueAmount: customer.dueAmount || 0,
                balanceDue: customer.dueAmount || 0,
                createdAt: customer.createdAt,
                updatedAt: customer.updatedAt,
                isSynced: true,
                _id: customer._id.toString()
              }));
              break;
            case 'products':
              formattedData = data.map(product => ({
                id: product._id.toString(),
                name: product.name,
                barcode: product.barcode || '',
                categoryId: product.categoryId && product.categoryId._id ? product.categoryId._id.toString() : (typeof product.categoryId === 'string' ? product.categoryId : null),
                category: product.categoryId ? product.categoryId.name : '',
                stock: product.stock || 0,
                quantity: product.stock || 0,
                unit: product.unit || 'pcs',
                costPrice: product.costPrice || 0,
                unitPrice: product.costPrice || 0,
                sellingUnitPrice: product.sellingUnitPrice || 0,
                sellingPrice: product.sellingUnitPrice || 0,
                lowStockLevel: product.lowStockLevel || 10,
                mfg: product.mfg,
                mfgDate: product.mfg,
                expiryDate: product.expiryDate,
                description: product.description || '',
                isActive: product.isActive !== undefined ? product.isActive : true,
                createdAt: product.createdAt,
                updatedAt: product.updatedAt,
                isSynced: true,
                _id: product._id.toString()
              }));
              break;
            case 'categories':
              formattedData = data.map(category => ({
                id: category._id.toString(),
                name: category.name,
                description: category.description || '',
                image: category.image || '',
                isActive: category.isActive !== undefined ? category.isActive : true,
                createdAt: category.createdAt,
                updatedAt: category.updatedAt,
                isSynced: true,
                _id: category._id.toString()
              }));
              break;
            case 'orders':
              const parseNumeric = (value) => {
                const num = Number(value);
                return Number.isFinite(num) ? num : null;
              };

              formattedData = data.map(order => {
                const items = order.items || [];
                const subtotalValue = parseNumeric(order.subtotal);
                const subtotal = subtotalValue !== null
                  ? subtotalValue
                  : items.reduce((sum, item) => {
                    const price = parseNumeric(item.sellingPrice) ?? parseNumeric(item.price) ?? 0;
                    const qty = parseNumeric(item.quantity) ?? 0;
                    return sum + price * qty;
                  }, 0);

                const rawDiscountAmount = parseNumeric(order.discount) ?? parseNumeric(order.discountAmount) ?? 0;
                const rawTaxAmount = parseNumeric(order.tax) ?? parseNumeric(order.taxAmount) ?? 0;

                const discountPercentValue = parseNumeric(order.discountPercent);
                const discountPercent = discountPercentValue !== null
                  ? discountPercentValue
                  : (subtotal > 0 ? (rawDiscountAmount / subtotal) * 100 : 0);

                const discountAmount = rawDiscountAmount > 0
                  ? rawDiscountAmount
                  : subtotal * (discountPercent / 100);

                const taxableBase = Math.max(0, subtotal - discountAmount);

                const taxPercentValue = parseNumeric(order.taxPercent);
                const taxPercent = taxPercentValue !== null
                  ? taxPercentValue
                  : (taxableBase > 0 ? (rawTaxAmount / taxableBase) * 100 : 0);

                const taxAmount = rawTaxAmount > 0
                  ? rawTaxAmount
                  : taxableBase * (taxPercent / 100);

                const totalAmountValue = parseNumeric(order.totalAmount);
                const totalAmount = totalAmountValue !== null
                  ? totalAmountValue
                  : Math.max(0, taxableBase + taxAmount);

                let splitPaymentDetails = null;
                if (order.splitPaymentDetails !== undefined && order.splitPaymentDetails !== null) {
                  splitPaymentDetails = order.splitPaymentDetails;
                }

                return {
                  id: order._id.toString(),
                  sellerId: order.sellerId.toString(),
                  customerId: order.customerId ? order.customerId._id.toString() : null,
                  customerName: order.customerName || (order.customerId ? order.customerId.name : 'Walk-in Customer'),
                  customerMobile: order.customerMobile || (order.customerId ? (order.customerId.mobileNumber || order.customerId.phone || '') : ''),
                  paymentMethod: order.paymentMethod || 'cash',
                  splitPaymentDetails: splitPaymentDetails,
                  items,
                  subtotal,
                  discountPercent,
                  discountAmount,
                  taxPercent,
                  taxAmount,
                  totalAmount,
                  createdAt: order.createdAt,
                  updatedAt: order.updatedAt,
                  isSynced: true,
                  _id: order._id.toString()
                };
              });
              break;
            case 'transactions':
              formattedData = data.map(transaction => ({
                id: transaction._id.toString(),
                type: transaction.type,
                customerId: transaction.customerId || null,
                customerName: transaction.customerName || '',
                amount: transaction.amount || 0,
                total: transaction.amount || 0,
                paymentMethod: transaction.paymentMethod || 'cash',
                description: transaction.description || '',
                date: transaction.date || transaction.createdAt,
                razorpayOrderId: transaction.razorpayOrderId || null,
                razorpayPaymentId: transaction.razorpayPaymentId || null,
                planOrderId: transaction.planOrderId ? transaction.planOrderId.toString() : null,
                planId: transaction.planId ? transaction.planId.toString() : null,
                status: transaction.status || 'completed',
                createdAt: transaction.createdAt,
                updatedAt: transaction.updatedAt,
                isSynced: true,
                _id: transaction._id.toString()
              }));
              break;
            case 'purchaseOrders':
            case 'vendorOrders': // Backward compatibility
              formattedData = data.map(order => ({
                id: order._id.toString(),
                supplierName: order.supplierName,
                items: order.items || [],
                total: order.total || 0,
                status: order.status || 'pending',
                notes: order.notes || '',
                expectedDeliveryDate: order.expectedDeliveryDate,
                actualDeliveryDate: order.actualDeliveryDate,
                cancelledAt: order.cancelledAt,
                createdAt: order.createdAt,
                updatedAt: order.updatedAt,
                isSynced: true,
                _id: order._id.toString()
              }));
              break;
            case 'refunds':
              formattedData = data.map(refund => ({
                id: refund._id.toString(),
                orderId: refund.orderId?.toString() || refund.orderId,
                customerId: refund.customerId?.toString() || refund.customerId || null,
                sellerId: refund.sellerId?.toString() || refund.sellerId,
                items: refund.items || [],
                totalRefundAmount: refund.totalRefundAmount || 0,
                reason: refund.reason || '',
                refundedByUser: refund.refundedByUser || '',
                createdAt: refund.createdAt,
                updatedAt: refund.updatedAt,
                isSynced: true,
                _id: refund._id.toString()
              }));
              break;
            default:
              formattedData = data;
          }

          return { dataType, data: formattedData, count: formattedData.length };
        } catch (error) {
          console.error(`Error fetching delta data for ${dataType}:`, error);
          return { dataType, data: [], error: error.message, count: 0 };
        }
      });

      const results = await Promise.allSettled(fetchPromises);

      results.forEach(promiseResult => {
        if (promiseResult.status === 'fulfilled') {
          const { dataType, data, count } = promiseResult.value;
          result.data[dataType] = {
            items: data,
            count: count,
            updatedAt: deltaData[dataType].latestUpdateTime
          };
        } else {
          console.error(`Failed to fetch data for ${promiseResult.reason}`);
        }
      });
    }

    res.json({
      success: true,
      data: result,
      serverTime: new Date()
    });
  } catch (error) {
    console.error('Get delta sync error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching delta sync data',
      error: error.message
    });
  }
};

/**
 * Get latest data for each data type based on provided timestamps
 * Returns data where updatedAt > timestamp for each data type
 */
const getLatestData = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const { timestamps: lastFetchTimes } = req.body;

    if (!sellerId) {
      return res.status(401).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    if (!lastFetchTimes || typeof lastFetchTimes !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'lastFetchTimes object is required'
      });
    }

    //('🔄 LATEST FETCH: Getting latest data for seller:', sellerId);
    //('🔄 LATEST FETCH: Last fetch times:', lastFetchTimes);

    // Check if user's current plan is valid
    let isPlanValid = false;
    let restrictedModules = ['upgrade', 'settings']; // Only allow these when plan is invalid

    try {
      const seller = await Seller.findById(sellerId);
      if (seller && seller.currentPlanId) {
        const currentPlanOrder = await PlanOrder.findById(seller.currentPlanId).populate('planId');
        if (currentPlanOrder && currentPlanOrder.planId) {
          const now = new Date();
          const remainingMs = computeRemainingMs(currentPlanOrder, currentPlanOrder.planId, now);
          isPlanValid = remainingMs > 0 && currentPlanOrder.status !== 'expired';
        }
      }

      //('🔄 LATEST FETCH: Plan valid check:', isPlanValid, 'for seller:', sellerId);

      // If plan is not valid, restrict access to only upgrade and settings
      if (!isPlanValid) {
        //('⚠️ LATEST FETCH: Plan expired - restricting access to upgrade and settings only');
      }
    } catch (planCheckError) {
      console.error('Error checking plan validity in delta sync:', planCheckError);
      // If we can't check plan validity, assume it's valid to avoid blocking users
      isPlanValid = true;
    }

    const result = {};

    // Process each data type
    const dataTypes = Object.keys(lastFetchTimes);

    // Define restricted data types that should not be accessible when plan is expired
    const restrictedDataTypes = ['customers', 'products', 'orders', 'transactions', 'purchaseOrders', 'refunds'];

    for (const dataType of dataTypes) {
      const lastFetchTime = lastFetchTimes[dataType];
      if (!lastFetchTime) continue;

      try {
        // If plan is not valid and this is a restricted data type, return empty array
        if (!isPlanValid && restrictedDataTypes.includes(dataType)) {
          //(`🔄 LATEST FETCH: Restricting access to ${dataType} due to expired plan`);
          result[dataType] = [];
          continue;
        }

        let query = { sellerId };
        query.updatedAt = { $gt: new Date(lastFetchTime) };

        let data = [];
        let model;

        switch (dataType) {
          case 'customers':
            model = Customer;
            data = await Customer.find(query).sort({ updatedAt: -1 });
            // Format data like the regular endpoints
            data = data.map(customer => ({
              id: customer._id.toString(),
              name: customer.name,
              mobileNumber: customer.mobileNumber,
              phone: customer.mobileNumber,
              email: customer.email,
              dueAmount: customer.dueAmount || 0,
              balanceDue: customer.dueAmount || 0,
              createdAt: customer.createdAt,
              updatedAt: customer.updatedAt,
              isSynced: true,
              _id: customer._id.toString()
            }));
            break;

          case 'products':
            model = Product;
            data = await Product.find(query).populate('categoryId', 'name').sort({ updatedAt: -1 });
            // Format data like the regular endpoints
            data = data.map(product => ({
              id: product._id.toString(),
              name: product.name,
              barcode: product.barcode || '',
              categoryId: product.categoryId && product.categoryId._id ? product.categoryId._id.toString() : (typeof product.categoryId === 'string' ? product.categoryId : null),
              category: product.categoryId ? product.categoryId.name : '',
              stock: product.stock || 0,
              quantity: product.stock || 0,
              unit: product.unit || 'pcs',
              costPrice: product.costPrice || 0,
              unitPrice: product.costPrice || 0,
              sellingUnitPrice: product.sellingUnitPrice || 0,
              sellingPrice: product.sellingUnitPrice || 0,
              lowStockLevel: product.lowStockLevel || 10,
              mfg: product.mfg,
              mfgDate: product.mfg,
              expiryDate: product.expiryDate,
              description: product.description || '',
              isActive: product.isActive !== undefined ? product.isActive : true,
              createdAt: product.createdAt,
              updatedAt: product.updatedAt,
              isSynced: true,
              _id: product._id.toString()
            }));
            break;

          case 'categories':
            model = ProductCategory;
            data = await ProductCategory.find(query).sort({ updatedAt: -1 });
            // Format data like the regular endpoints
            data = data.map(category => ({
              id: category._id.toString(),
              name: category.name,
              isActive: category.isActive !== undefined ? category.isActive : true,
              description: category.description || '',
              createdAt: category.createdAt,
              updatedAt: category.updatedAt,
              isSynced: true,
              _id: category._id.toString()
            }));
            break;

          case 'orders':
            model = Order;
            data = await Order.find(query).populate('customerId', 'name mobileNumber').lean().sort({ updatedAt: -1 });
            // Format data like the regular endpoints
            data = data.map(order => ({
              id: order._id.toString(),
              customerId: order.customerId ? order.customerId._id.toString() : null,
              customerName: order.customerId ? order.customerId.name : order.customerName || '',
              customerMobile: order.customerId ? order.customerId.mobileNumber : order.customerMobile || '',
              paymentMethod: order.paymentMethod || 'cash',
              items: order.items || [],
              subtotal: order.subtotal || 0,
              discountPercent: order.discountPercent || 0,
              discountAmount: order.discountAmount || 0,
              taxPercent: order.taxPercent || 0,
              taxAmount: order.taxAmount || 0,
              totalAmount: order.totalAmount || 0,
              createdAt: order.createdAt,
              updatedAt: order.updatedAt,
              isSynced: true,
              _id: order._id.toString()
            }));
            break;

          case 'transactions':
            model = Transaction;
            data = await Transaction.find(query).sort({ updatedAt: -1 });
            break;

          case 'vendorOrders':
          case 'purchaseOrders':
            model = VendorOrder;
            data = await VendorOrder.find(query).sort({ updatedAt: -1 });
            break;

          case 'refunds':
            model = Refund;
            data = await Refund.find(query).sort({ updatedAt: -1 });
            break;

          case 'staff':
            // For now, staff data might not exist in MongoDB
            // This is for future staff management functionality
            data = [];
            break;

          default:
            console.warn(`Unknown data type for latest fetch: ${dataType}`);
            continue;
        }

        result[dataType] = {
          count: data.length,
          data: data,
          timestamp: new Date()
        };

        //(`🔄 LATEST FETCH: Found ${data.length} ${dataType} updated since ${lastFetchTime}`);

      } catch (error) {
        console.error(`Error fetching latest ${dataType}:`, error);
        result[dataType] = {
          count: 0,
          data: [],
          error: error.message,
          timestamp: new Date()
        };
      }
    }

    res.json({
      success: true,
      data: result,
      serverTime: new Date(),
      requestedTypes: dataTypes
    });

  } catch (error) {
    console.error('Get latest data error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching latest data',
      error: error.message
    });
  }
};

/**
 * Fetch all latest data since a specific timestamp
 * Takes a single lastFetchTime and returns all data updated after that time
 */
const fetchLatestData = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const { lastFetchTime } = req.query;

    if (!sellerId) {
      return res.status(401).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    if (!lastFetchTime) {
      return res.status(400).json({
        success: false,
        message: 'lastFetchTime is required'
      });
    }

    //('🔄 FETCH LATEST: Getting all data updated since:', lastFetchTime);

    const queryTime = new Date(lastFetchTime);
    if (isNaN(queryTime.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid lastFetchTime format'
      });
    }

    const result = {
      customers: [],
      products: [],
      orders: [],
      transactions: [],
      purchaseOrders: [],
      categories: [],
      refunds: [],
      plans: [],
      planOrders: [],
      staff: []
    };

    // Define all data types and their corresponding models
    const dataTypes = [
      { key: 'customers', model: Customer },
      { key: 'products', model: Product },
      { key: 'categories', model: ProductCategory },
      { key: 'orders', model: Order },
      { key: 'transactions', model: Transaction },
      { key: 'purchaseOrders', model: VendorOrder },
      { key: 'refunds', model: Refund },
      { key: 'plans', model: Plan },
      { key: 'planOrders', model: PlanOrder }
      // Note: Staff is not included as there's no staff model yet
    ];

    // Fetch data for each type
    for (const { key, model } of dataTypes) {
      try {
        const query = {
          updatedAt: { $gt: queryTime }
        };

        // Only add sellerId for non-global collections
        if (key !== 'plans') {
          query.sellerId = sellerId;
        }

        let data = await model.find(query).sort({ updatedAt: -1 });

        // Format data based on type
        switch (key) {
          case 'customers':
            data = data.map(customer => ({
              id: customer._id.toString(),
              name: customer.name,
              mobileNumber: customer.mobileNumber,
              phone: customer.mobileNumber,
              email: customer.email,
              dueAmount: customer.dueAmount || 0,
              balanceDue: customer.dueAmount || 0,
              createdAt: customer.createdAt,
              updatedAt: customer.updatedAt,
              isSynced: true,
              _id: customer._id.toString()
            }));
            break;

          case 'products':
            data = await model.find(query).populate('categoryId', 'name').sort({ updatedAt: -1 });
            data = data.map(product => ({
              id: product._id.toString(),
              name: product.name,
              barcode: product.barcode || '',
              categoryId: product.categoryId && product.categoryId._id ? product.categoryId._id.toString() : (typeof product.categoryId === 'string' ? product.categoryId : null),
              category: product.categoryId ? product.categoryId.name : '',
              stock: product.stock || 0,
              quantity: product.stock || 0,
              unit: product.unit || 'pcs',
              costPrice: product.costPrice || 0,
              unitPrice: product.costPrice || 0,
              sellingUnitPrice: product.sellingUnitPrice || 0,
              sellingPrice: product.sellingUnitPrice || 0,
              lowStockLevel: product.lowStockLevel || 10,
              mfg: product.mfg,
              mfgDate: product.mfg,
              expiryDate: product.expiryDate,
              description: product.description || '',
              isActive: product.isActive !== undefined ? product.isActive : true,
              createdAt: product.createdAt,
              updatedAt: product.updatedAt,
              isSynced: true,
              _id: product._id.toString()
            }));
            break;

          case 'categories':
            data = data.map(category => ({
              id: category._id.toString(),
              name: category.name,
              isActive: category.isActive !== undefined ? category.isActive : true,
              description: category.description || '',
              createdAt: category.createdAt,
              updatedAt: category.updatedAt,
              isSynced: true,
              _id: category._id.toString()
            }));
            break;

          case 'orders':
            data = await model.find(query).populate('customerId', 'name mobileNumber').lean().sort({ updatedAt: -1 });
            data = data.map(order => ({
              id: order._id.toString(),
              customerId: order.customerId ? order.customerId._id.toString() : null,
              customerName: order.customerId ? order.customerId.name : order.customerName || '',
              customerMobile: order.customerId ? order.customerId.mobileNumber : order.customerMobile || '',
              paymentMethod: order.paymentMethod || 'cash',
              items: order.items || [],
              subtotal: order.subtotal || 0,
              discountPercent: order.discountPercent || 0,
              discountAmount: order.discountAmount || 0,
              taxPercent: order.taxPercent || 0,
              taxAmount: order.taxAmount || 0,
              totalAmount: order.totalAmount || 0,
              createdAt: order.createdAt,
              updatedAt: order.updatedAt,
              isSynced: true,
              _id: order._id.toString()
            }));
            break;

          case 'purchaseOrders':
            data = data.map(order => ({
              id: order._id.toString(),
              supplierName: order.supplierName,
              items: order.items || [],
              total: order.total || 0,
              status: order.status || 'pending',
              notes: order.notes || '',
              expectedDeliveryDate: order.expectedDeliveryDate,
              actualDeliveryDate: order.actualDeliveryDate,
              cancelledAt: order.cancelledAt,
              createdAt: order.createdAt,
              updatedAt: order.updatedAt,
              isSynced: true,
              _id: order._id.toString()
            }));
            break;

          case 'refunds':
            data = data.map(refund => ({
              id: refund._id.toString(),
              orderId: refund.orderId?.toString() || refund.orderId,
              customerId: refund.customerId?.toString() || refund.customerId || null,
              sellerId: refund.sellerId?.toString() || refund.sellerId,
              items: refund.items || [],
              totalRefundAmount: refund.totalRefundAmount || 0,
              reason: refund.reason || '',
              refundedByUser: refund.refundedByUser || '',
              createdAt: refund.createdAt,
              updatedAt: refund.updatedAt,
              isSynced: true,
              _id: refund._id.toString()
            }));
            break;

          case 'plans':
            data = data.map(plan => {
              // If plan is not valid, restrict modules to only upgrade and settings
              const actualUnlockedModules = plan.unlockedModules || [];
              const restrictedUnlockedModules = isPlanValid ? actualUnlockedModules : restrictedModules;

              return {
                id: plan._id.toString(),
                name: plan.name,
                description: plan.description,
                price: plan.price,
                durationDays: plan.durationDays,
                unlockedModules: restrictedUnlockedModules,
                lockedModules: isPlanValid ? (plan.lockedModules || []) : actualUnlockedModules.filter(module => !restrictedModules.includes(module)),
                maxCustomers: plan.maxCustomers,
                maxProducts: plan.maxProducts,
                maxOrders: plan.maxOrders,
                isActive: plan.isActive,
                totalSales: plan.totalSales,
                totalRevenue: plan.totalRevenue,
                createdAt: plan.createdAt,
                updatedAt: plan.updatedAt,
                _id: plan._id.toString(),
                planRestricted: !isPlanValid // Add flag to indicate plan restriction
              };
            });
            break;

          case 'planOrders':
            data = data.map(planOrder => ({
              id: planOrder._id.toString(),
              planId: planOrder.planId?.toString() || planOrder.planId,
              sellerId: planOrder.sellerId?.toString() || planOrder.sellerId,
              expiryDate: planOrder.expiryDate,
              durationDays: planOrder.durationDays,
              price: planOrder.price,
              status: planOrder.status,
              paymentStatus: planOrder.paymentStatus,
              paymentMethod: planOrder.paymentMethod,
              lastActivatedAt: planOrder.lastActivatedAt,
              accumulatedUsedMs: planOrder.accumulatedUsedMs,
              customerLimit: planOrder.customerLimit,
              productLimit: planOrder.productLimit,
              orderLimit: planOrder.orderLimit,
              customerCurrentCount: planOrder.customerCurrentCount,
              productCurrentCount: planOrder.productCurrentCount,
              orderCurrentCount: planOrder.orderCurrentCount,
              razorpayOrderId: planOrder.razorpayOrderId,
              razorpayPaymentId: planOrder.razorpayPaymentId,
              razorpaySignature: planOrder.razorpaySignature,
              totalCustomers: planOrder.totalCustomers,
              totalOrders: planOrder.totalOrders,
              totalProducts: planOrder.totalProducts,
              createdAt: planOrder.createdAt,
              updatedAt: planOrder.updatedAt,
              isSynced: true,
              _id: planOrder._id.toString()
            }));
            break;

          default:
            // For transactions, keep as-is since they don't need special formatting
            data = data.map(item => ({
              ...item.toObject ? item.toObject() : item,
              id: item._id.toString(),
              _id: item._id.toString(),
              isSynced: true
            }));
        }

        result[key] = data;
        //(`🔄 FETCH LATEST: Found ${data.length} ${key} updated since ${lastFetchTime}`);

      } catch (error) {
        console.error(`Error fetching latest ${key}:`, error);
        result[key] = [];
      }
    }

    // Calculate total count
    const totalCount = Object.values(result).reduce((sum, arr) => sum + arr.length, 0);

    res.json({
      success: true,
      data: result,
      meta: {
        totalCount,
        lastFetchTime,
        serverTime: new Date(),
        dataTypes: Object.keys(result).filter(key => result[key].length > 0)
      }
    });

  } catch (error) {
    console.error('Fetch latest data error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching latest data',
      error: error.message
    });
  }
};

/**
 * Get plan orders for the seller
 */
const getPlanOrders = async (req, res) => {
  try {
    const sellerId = req.sellerId;

    if (!sellerId) {
      return res.status(401).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    const PlanOrder = require('../models/PlanOrder');
    const planOrders = await PlanOrder.find({ sellerId }).sort({ createdAt: -1 });

    // Format plan orders for frontend
    const formattedPlanOrders = planOrders.map(planOrder => ({
      id: planOrder._id.toString(),
      _id: planOrder._id.toString(),
      planId: planOrder.planId,
      expiryDate: planOrder.expiryDate,
      durationDays: planOrder.durationDays,
      price: planOrder.price,
      status: planOrder.status,
      paymentStatus: planOrder.paymentStatus,
      paymentMethod: planOrder.paymentMethod,
      lastActivatedAt: planOrder.lastActivatedAt,
      accumulatedUsedMs: planOrder.accumulatedUsedMs,
      customerLimit: planOrder.customerLimit,
      productLimit: planOrder.productLimit,
      orderLimit: planOrder.orderLimit,
      customerCurrentCount: planOrder.customerCurrentCount,
      productCurrentCount: planOrder.productCurrentCount,
      orderCurrentCount: planOrder.orderCurrentCount,
      createdAt: planOrder.createdAt,
      updatedAt: planOrder.updatedAt,
      isDeleted: planOrder.isDeleted,
      isSynced: true
    }));

    res.json({
      success: true,
      data: formattedPlanOrders
    });
  } catch (error) {
    console.error('Get plan orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching plan orders',
      error: error.message
    });
  }
};

module.exports = {
  getCustomers,
  getProducts,
  getProductBatches,
  createProductBatch,
  updateProductBatch,
  deleteProductBatch,
  getOrders,
  getTransactions,
  getVendorOrders,
  getCategories,
  getAllData,
  getPlans,
  upgradePlan,
  getCurrentPlan,
  createRazorpayOrder,
  verifyRazorpayPayment,
  getSellerProfile,
  updateSellerSettings,
  getSyncTracking,
  getDeltaSync,
  getLatestData,
  fetchLatestData,
  getPlanOrders
};