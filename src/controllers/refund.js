const mongoose = require('mongoose');
const Refund = require('../models/Refund');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Seller = require('../models/Seller');
const SyncTracking = require('../models/SyncTracking');

/**
 * Create a new refund
 * POST /api/refunds/create
 * SECURITY: All operations filter by sellerId to ensure sellers can only access their own orders
 */
exports.createRefund = async (req, res) => {
  try {
    const { orderId, items, reason } = req.body;
    const sellerId = req.sellerId; // From verifySeller middleware

    if (!orderId || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Order ID and items are required'
      });
    }

    // SECURITY: Find the order - MUST match sellerId to prevent cross-seller access
    const order = await Order.findOne({ _id: orderId, sellerId });
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Get seller to check refund window
    const seller = await Seller.findById(sellerId);
    const refundWindowHours = seller?.refundWindowHours || 24 * 7; // Default 7 days
    const orderAgeHours = (Date.now() - new Date(order.createdAt).getTime()) / (1000 * 60 * 60);

    if (orderAgeHours > refundWindowHours) {
      return res.status(400).json({
        success: false,
        message: `Refund window expired. Orders older than ${refundWindowHours} hours cannot be refunded.`
      });
    }

    // Calculate total refund amount and validate items
    let totalRefundAmount = 0;
    const refundItems = [];

    for (const refundItem of items) {
      const { productId, qty } = refundItem;

      if (!productId || !qty || qty <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid item data: productId and qty (greater than 0) are required'
        });
      }

      // Find the order item - handle both ObjectId and string matching
      const orderItem = order.items.find(item => {
        if (!item.productId) return false;
        const itemProductId = item.productId.toString();
        const searchProductId = productId.toString();
        return itemProductId === searchProductId;
      });

      if (!orderItem) {
        return res.status(400).json({
          success: false,
          message: `Product not found in order. Please check the product ID.`
        });
      }

      // Check already refunded quantity
      const existingRefunds = await Refund.find({
        orderId: order._id,
        sellerId
      });

      const alreadyRefundedQty = existingRefunds.reduce((sum, refund) => {
        const refundItem = refund.items.find(item =>
          item.productId && item.productId.toString() === productId.toString()
        );
        return sum + (refundItem ? refundItem.qty : 0);
      }, 0);

      const qtyAvailable = orderItem.quantity - alreadyRefundedQty;

      if (qty > qtyAvailable) {
        return res.status(400).json({
          success: false,
          message: `Cannot refund ${qty} units. Only ${qtyAvailable} units available for refund for product ${orderItem.name}`
        });
      }

      const rate = orderItem.sellingPrice;
      const lineTotal = rate * qty;
      totalRefundAmount += lineTotal;

      refundItems.push({
        productId,
        name: orderItem.name,
        qty,
        rate,
        lineTotal,
        unit: orderItem.unit || 'pcs'
      });

      // Stock update moved to after refund record creation for data integrity
    }

    // Create refund record FIRST (before updating stock)
    const refund = new Refund({
      orderId: order._id,
      customerId: order.customerId,
      sellerId,
      items: refundItems,
      totalRefundAmount,
      reason: reason || '',
      refundedByUser: seller?.name || seller?.email || 'System',
      stockAdjusted: false // Stock will be adjusted below, so mark as not adjusted yet
    });

    const savedRefund = await refund.save();

    // Now update stock for each item (only after refund record is saved)
    const stockUpdatePromises = [];

    for (const refundItem of items) {
      const { productId, qty } = refundItem;

      const updatePromise = (async () => {
        try {
          let product = null;
          if (mongoose.Types.ObjectId.isValid(productId)) {
            product = await Product.findOne({ _id: productId, sellerId });
          }

          if (product) {
            // For refunds, we need to add quantity back to batches
            // We'll add to the most recently created batch (LIFO for refunds)
            const ProductBatch = require('../models/ProductBatch');
            const recentBatch = await ProductBatch.findOne({
              sellerId,
              productId,
              isDeleted: false
            }).sort({ createdAt: -1 }); // Most recent batch

            if (recentBatch) {
              recentBatch.quantity = (recentBatch.quantity || 0) + qty;
              await recentBatch.save();
              // Refund added to batch
            } else {
              // No active batches found logs suppressed
            }
          } else {
            // Product not found logs suppressed
          }
        } catch (error) {
          // Error updating stock logs suppressed
          throw error; // Re-throw to be caught by Promise.allSettled
        }
      })();

      stockUpdatePromises.push(updatePromise);
    }

    // Wait for all stock updates to complete
    const stockUpdateResults = await Promise.allSettled(stockUpdatePromises);

    // Check if any stock updates failed
    const failedUpdates = stockUpdateResults.filter(result => result.status === 'rejected');
    if (failedUpdates.length > 0) {
      // If stock updates failed, delete the refund record to maintain data integrity
      await Refund.findByIdAndUpdate(savedRefund._id, {
        isDeleted: true,
        updatedAt: new Date()
      });
      // Stock update failed log suppressed

      return res.status(500).json({
        success: false,
        message: 'Failed to update product stock after creating refund record. Refund has been cancelled.',
        error: 'Stock update error'
      });
    }

    // Mark refund as stock-adjusted since stock updates were successful
    savedRefund.stockAdjusted = true;
    await savedRefund.save();

    // Update sync tracking for refunds and products (since stock was modified)
    try {
      // Get actual counts for sync tracking
      const [refundCount, productCount] = await Promise.all([
        Refund.countDocuments({ sellerId }),
        Product.countDocuments({ sellerId })
      ]);

      await Promise.all([
        SyncTracking.updateLatestTime(sellerId, 'refunds', refundCount),
        SyncTracking.updateLatestTime(sellerId, 'products', productCount)
      ]);
    } catch (trackingError) {
      // Sync tracking error suppressed
    }

    res.status(201).json({
      success: true,
      data: {
        refundId: savedRefund._id.toString(),
        orderId: order._id.toString(),
        totalRefundAmount,
        itemsCount: refundItems.length,
        createdAt: savedRefund.createdAt
      },
      message: 'Refund processed successfully'
    });
  } catch (error) {
    // Create refund error suppressed
    res.status(500).json({
      success: false,
      message: 'Error processing refund',
      error: error.message
    });
  }
};

/**
 * Get all refunds for a seller
 * GET /api/refunds
 */
exports.getRefunds = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const { from, to, customerMobile, orderId } = req.query;

    let query = { sellerId };

    // Date range filter
    if (from || to) {
      query.createdAt = {};
      if (from) {
        query.createdAt.$gte = new Date(from);
      }
      if (to) {
        query.createdAt.$lte = new Date(to);
      }
    }

    // Customer mobile filter (via order lookup)
    if (customerMobile) {
      const orders = await Order.find({
        sellerId,
        customerMobile: { $regex: customerMobile, $options: 'i' }
      }).select('_id');
      const orderIds = orders.map(o => o._id);
      query.orderId = { $in: orderIds };
    }

    // Order ID filter
    if (orderId) {
      const order = await Order.findOne({
        sellerId,
        $or: [
          { _id: orderId },
          { id: orderId }
        ]
      });
      if (order) {
        query.orderId = order._id;
      } else {
        // No order found, return empty result
        return res.json({
          success: true,
          data: []
        });
      }
    }

    const refunds = await Refund.find(query)
      .populate('orderId', 'customerName customerMobile createdAt totalAmount')
      .sort({ createdAt: -1 })
      .lean();

    const formattedRefunds = refunds.map(refund => ({
      id: refund._id.toString(),
      refundId: refund._id.toString(),
      orderId: refund.orderId?._id?.toString() || refund.orderId?.toString(),
      customerId: refund.customerId?.toString(),
      totalRefundAmount: refund.totalRefundAmount,
      refundDate: refund.createdAt,
      refundedBy: refund.refundedByUser,
      itemsCount: refund.items.length,
      reason: refund.reason,
      items: refund.items,
      customerName: refund.orderId?.customerName,
      customerMobile: refund.orderId?.customerMobile,
      orderDate: refund.orderId?.createdAt,
      orderTotal: refund.orderId?.totalAmount
    }));

    res.json({
      success: true,
      data: formattedRefunds
    });
  } catch (error) {
    // Get refunds error suppressed
    res.status(500).json({
      success: false,
      message: 'Error fetching refunds',
      error: error.message
    });
  }
};

/**
 * Get refunds for a specific order
 * GET /api/refunds/order/:orderId
 */
exports.getOrderRefunds = async (req, res) => {
  try {
    const { orderId } = req.params;
    const sellerId = req.sellerId;

    const order = await Order.findOne({ _id: orderId, sellerId });
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    const refunds = await Refund.find({ orderId: order._id, sellerId })
      .sort({ createdAt: -1 })
      .lean();

    // Calculate refunded quantities per product
    const refundedQuantities = {};
    refunds.forEach(refund => {
      refund.items.forEach(item => {
        const productId = item.productId?.toString();
        if (productId) {
          refundedQuantities[productId] = (refundedQuantities[productId] || 0) + item.qty;
        }
      });
    });

    res.json({
      success: true,
      data: {
        refunds: refunds.map(refund => ({
          id: refund._id.toString(),
          totalRefundAmount: refund.totalRefundAmount,
          createdAt: refund.createdAt,
          reason: refund.refundedByUser,
          items: refund.items
        })),
        refundedQuantities
      }
    });
  } catch (error) {
    // Get order refunds error suppressed
    res.status(500).json({
      success: false,
      message: 'Error fetching order refunds',
      error: error.message
    });
  }
};

