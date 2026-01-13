/**
 * Universal Incremental Sync Controller
 * Provides a dynamic sync endpoint that works with any collection
 */

const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Transaction = require('../models/Transaction');
const VendorOrder = require('../models/VendorOrder');
const ProductCategory = require('../models/ProductCategory');
const Refund = require('../models/Refund');
const PlanOrder = require('../models/PlanOrder');
const Plan = require('../models/Plan');
const Expense = require('../models/Expense');
const CustomerTransaction = require('../models/CustomerTransaction');
const ProductBatch = require('../models/ProductBatch');
const Supplier = require('../models/Supplier');
const SupplierTransaction = require('../models/SupplierTransaction');
const DProduct = require('../models/DProduct');

// Map collection names to Mongoose models
const MODEL_MAP = {
  customers: Customer,
  products: Product,
  orders: Order,
  transactions: Transaction,
  'vendor-orders': VendorOrder,
  'purchaseOrders': VendorOrder, // Alias
  categories: ProductCategory,
  refunds: Refund,
  'plan-orders': PlanOrder,
  planOrders: PlanOrder, // Alias
  plans: Plan,  // Global/system data, handled specially
  expenses: Expense,
  'product-batches': ProductBatch,
  productBatches: ProductBatch,
  'customer-transactions': CustomerTransaction,
  customerTransactions: CustomerTransaction, // Alias
  suppliers: Supplier,
  'supplier-transactions': SupplierTransaction,
  supplierTransactions: SupplierTransaction, // Alias
  'd-products': DProduct,
  dProducts: DProduct // Alias
};

// Collections that don't require sellerId filtering (global/system data)
const GLOBAL_COLLECTIONS = ['plans'];

// Valid collection names (include global collections)
const VALID_COLLECTIONS = [...Object.keys(MODEL_MAP), ...GLOBAL_COLLECTIONS];

/**
 * Universal incremental sync endpoint
 * GET /sync/:collection?since=TIMESTAMP
 */
const incrementalSync = async (req, res) => {
  try {
    const { collection } = req.params;
    const sellerId = req.sellerId;
    const since = req.query.since ? new Date(req.query.since) : null;

    // Validate collection name
    if (!VALID_COLLECTIONS.includes(collection)) {
      return res.status(400).json({
        success: false,
        message: `Invalid collection name. Valid collections: ${VALID_COLLECTIONS.join(', ')}`
      });
    }

    // Get the model for this collection
    const Model = MODEL_MAP[collection];
    if (!Model) {
      return res.status(500).json({
        success: false,
        message: `Model not found for collection: ${collection}`
      });
    }

    // Build query: sellerId + not deleted + optionally updated after timestamp
    const query = { isDeleted: false };

    // Only add sellerId filter for non-global collections
    if (!GLOBAL_COLLECTIONS.includes(collection)) {
      query.sellerId = mongoose.Types.ObjectId.isValid(sellerId)
        ? new mongoose.Types.ObjectId(sellerId)
        : sellerId;
    }

    // If since timestamp provided, only get items updated after that time
    if (since && !isNaN(since.getTime())) {
      query.updatedAt = { $gt: since };
    }

    // Find all matching documents
    const documents = await Model.find(query)
      .sort({ updatedAt: 1 }) // Sort by updatedAt ascending
      .lean(); // Use lean() for better performance

    // Find deleted documents (isDeleted = true)
    const deletedQuery = { isDeleted: true };

    // Only add sellerId filter for non-global collections
    if (!GLOBAL_COLLECTIONS.includes(collection)) {
      deletedQuery.sellerId = mongoose.Types.ObjectId.isValid(sellerId)
        ? new mongoose.Types.ObjectId(sellerId)
        : sellerId;
    }

    if (since && !isNaN(since.getTime())) {
      deletedQuery.updatedAt = { $gt: since };
    }

    const deletedDocuments = await Model.find(deletedQuery)
      .select('_id updatedAt')
      .lean();

    // Transform documents to frontend format
    const updated = documents.map(doc => {
      const transformed = {
        ...doc,
        id: doc._id.toString(),
        _id: doc._id.toString()
      };
      // Remove MongoDB-specific fields
      delete transformed.__v;
      return transformed;
    });

    // Transform deleted documents to just IDs
    const deleted = deletedDocuments.map(doc => ({
      id: doc._id.toString(),
      _id: doc._id.toString(),
      updatedAt: doc.updatedAt
    }));

    res.json({
      success: true,
      collection,
      updated,
      deleted,
      count: {
        updated: updated.length,
        deleted: deleted.length,
        total: updated.length + deleted.length
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(`Error in incremental sync for ${req.params.collection}:`, error);
    res.status(500).json({
      success: false,
      message: `Error syncing ${req.params.collection}`,
      error: error.message
    });
  }
};

module.exports = {
  incrementalSync
};

