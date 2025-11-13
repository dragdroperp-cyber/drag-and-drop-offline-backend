const Customer = require('../models/Customer');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Transaction = require('../models/Transaction');
const VendorOrder = require('../models/VendorOrder');
const ProductCategory = require('../models/ProductCategory');
const Plan = require('../models/Plan');
const PlanOrder = require('../models/PlanOrder');
const Seller = require('../models/Seller');
const { createOrder, verifyPayment, convertToPaise } = require('../utils/razorpay');
const { computeRemainingMs, formatRemaining, getPlanDurationMs } = require('../utils/planTimers');
const { setActivePlanForSeller } = require('./planValidity');
const { getPlanUsageSummary } = require('../utils/planUsage');

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
    
    // Transform to match frontend format - MongoDB uses 'stock' and 'costPrice'
    const formattedProducts = products.map(product => {
      return {
        id: product._id.toString(),
        name: product.name,
        barcode: product.barcode || '',
        categoryId: product.categoryId ? product.categoryId._id.toString() : null,
        category: product.categoryId ? product.categoryId.name : '',
        stock: product.stock || 0, // MongoDB uses 'stock'
        quantity: product.stock || 0, // Frontend compatibility
        unit: product.unit || 'pcs',
        costPrice: product.costPrice || 0, // MongoDB uses 'costPrice'
        unitPrice: product.costPrice || 0, // Frontend compatibility
        sellingUnitPrice: product.sellingUnitPrice || 0,
        sellingPrice: product.sellingUnitPrice || 0, // Backward compatibility
        lowStockLevel: product.lowStockLevel || 10,
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

/**
 * Get all orders for a seller
 */
const getOrders = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const orders = await Order.find({ sellerId })
      .populate('customerId', 'name mobileNumber')
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

      return {
        id: order._id.toString(),
        sellerId: order.sellerId.toString(),
        customerId: order.customerId ? order.customerId._id.toString() : null,
        customerName: order.customerName || (order.customerId ? order.customerId.name : 'Walk-in Customer'),
        customerMobile: order.customerMobile || (order.customerId ? (order.customerId.mobileNumber || order.customerId.phone || '') : ''),
        paymentMethod: order.paymentMethod || 'cash',
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
    
    const [customers, products, orders, transactions, vendorOrders, categories] = await Promise.all([
      Customer.find({ sellerId }).sort({ createdAt: -1 }),
      Product.find({ sellerId }).populate('categoryId', 'name').sort({ createdAt: -1 }),
      Order.find({ sellerId }).populate('customerId', 'name mobileNumber').sort({ createdAt: -1 }),
      Transaction.find({ sellerId }).sort({ createdAt: -1 }),
      VendorOrder.find({ sellerId }).sort({ createdAt: -1 }),
      ProductCategory.find({ sellerId }).sort({ createdAt: -1 })
    ]);

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

    // Format products - MongoDB uses 'stock' and 'costPrice'
    const formattedProducts = products.map(product => {
      return {
        id: product._id.toString(),
        name: product.name,
        barcode: product.barcode || '',
        categoryId: product.categoryId ? product.categoryId._id.toString() : null,
        category: product.categoryId ? product.categoryId.name : '',
        stock: product.stock || 0, // MongoDB uses 'stock'
        quantity: product.stock || 0, // Frontend compatibility
        unit: product.unit || 'pcs',
        costPrice: product.costPrice || 0, // MongoDB uses 'costPrice'
        unitPrice: product.costPrice || 0, // Frontend compatibility
        sellingUnitPrice: product.sellingUnitPrice || 0,
        sellingPrice: product.sellingUnitPrice || 0, // Backward compatibility
        lowStockLevel: product.lowStockLevel || 10,
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

      return {
        id: order._id.toString(),
        sellerId: order.sellerId.toString(),
        customerId: order.customerId ? order.customerId._id.toString() : null,
        customerName: order.customerName || (order.customerId ? order.customerId.name : 'Walk-in Customer'),
        customerMobile: order.customerMobile || (order.customerId ? (order.customerId.mobileNumber || order.customerId.phone || '') : ''),
        paymentMethod: order.paymentMethod || 'cash',
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

    res.json({
      success: true,
      data: {
        customers: formattedCustomers,
        products: formattedProducts,
        orders: formattedOrders,
        transactions: formattedTransactions,
        purchaseOrders: formattedVendorOrders,
        categories: formattedCategories
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
            currentPlanId: planOrder.planId._id.toString(),
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

      // Handle unlimited limits
      const maxCustomers = plan.maxCustomers === null || plan.maxCustomers === undefined || plan.maxCustomers === 0 
        ? 'Unlimited' 
        : plan.maxCustomers;
      const maxProducts = plan.maxProducts === null || plan.maxProducts === undefined || plan.maxProducts === 0 
        ? 'Unlimited' 
        : plan.maxProducts;

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
        unlockedModules: plan.unlockedModules || [],
        lockedModules: plan.lockedModules || [],
        description: plan.description || '',
        color: color,
        icon: icon,
        popular: popular,
        _id: planId,
        durationDays: plan.durationDays,
        rawPrice: plan.price,
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

    const existingPlanOrder = await PlanOrder.findOne({
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

    const activationResult = await setActivePlanForSeller({
      sellerId: seller._id,
      planId: plan._id,
      allowCreateOnMissing: true,
    });

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

    const isNewOrder = !existingPlanOrder || createdRecently;

    if (isNewOrder) {
      console.log(`✅ Plan upgraded: Seller ${seller.name} (${seller.email}) upgraded to plan "${plan.name}"`);
    } else {
      console.log(`✅ Plan activated: Seller ${seller.name} (${seller.email}) activated plan "${plan.name}"`);
    }

    res.json({
      success: true,
      message: isNewOrder
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
            planId: planOrder.planId._id.toString(),
            planName: planOrder.planId.name,
            status: planOrder.status,
            expiryDate: planOrder.expiryDate,
            paymentStatus: planOrder.paymentStatus
          }
        });
      }

      planOrder.razorpayPaymentId = razorpayPaymentId;
      planOrder.razorpaySignature = razorpaySignature;
      planOrder.paymentStatus = 'completed';
      planOrder.status = 'active';
      planOrder.lastActivatedAt = new Date();
      planOrder.accumulatedUsedMs = 0;
      planOrder.expiryDate = new Date(planOrder.lastActivatedAt.getTime() + getPlanDurationMs(planDoc));
      await planOrder.save();
    } else {
      const activationTime = new Date();
      const expiryDate = new Date(activationTime.getTime() + getPlanDurationMs(planDoc));
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
        status: 'active',
        lastActivatedAt: activationTime,
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

    // Update seller's currentPlanId
    seller.currentPlanId = planOrder._id;
    await seller.save();

    if (!planDoc || !planDoc.name) {
      planDoc = await Plan.findById(planOrder.planId);
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

    console.log(`✅ Payment verified: Seller ${seller.name} (${seller.email}) purchased plan "${planDoc?.name || 'Plan'}"`);

    const planIdString = planDoc?._id?.toString() || (typeof planOrder.planId === 'object' && planOrder.planId !== null && planOrder.planId._id
      ? planOrder.planId._id.toString()
      : planOrder.planId.toString());

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
    console.log('[Backend] GET /seller/profile - sellerId:', sellerId);
    
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

    console.log('[Backend] GET /seller/profile - Seller found:', {
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
      businessCategory,
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

    // Update business category
    if (businessCategory !== undefined) {
      seller.businessCategory = businessCategory.trim() || null;
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
          businessCategory: seller.businessCategory,
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

module.exports = {
  getCustomers,
  getProducts,
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
  updateSellerSettings
};

