const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Product = require('../models/Product');
const ProductBatch = require('../models/ProductBatch');
const Order = require('../models/Order');
const Transaction = require('../models/Transaction');
const VendorOrder = require('../models/VendorOrder');
const { adjustPlanUsage } = require('../utils/planUsage');
const ProductCategory = require('../models/ProductCategory');
const Refund = require('../models/Refund');
const SyncTracking = require('../models/SyncTracking');
const Expense = require('../models/Expense');
const CustomerTransaction = require('../models/CustomerTransaction');
const Supplier = require('../models/Supplier');
const SupplierTransaction = require('../models/SupplierTransaction');
const SellerSettings = require('../models/SellerSettings');
const DProduct = require('../models/DProduct');
const Target = require('../models/Target');
const { checkAndSendInventoryAlerts } = require('../utils/inventoryAlerts');

// Helper to enforce correct balance based on transactions
const recalculateSupplierBalance = async (supplierId, sellerId) => {
  try {
    const transactions = await SupplierTransaction.find({
      supplierId,
      sellerId,
      isDeleted: { $ne: true }
    });

    let totalDues = 0;
    let totalPayments = 0;

    transactions.forEach(t => {
      // isPayment: Transactions that REDUCE the amount we owe (Payments, Returns, Settlements, Credit Notes, Cancellations)
      // Including 'cancel_purchase' to offset the original 'purchase_order' transaction which remains in history.
      const isPayment = ['payment', 'cash', 'online', 'upi', 'card', 'remove_due', 'settlement', 'cancel_purchase', 'refund', 'purchase_return', 'debit_note', 'return', 'credit_note'].includes(t.type);

      // isCredit: Transactions that INCREASE the amount we owe (Purchases, Opening Balance)
      const isCredit = ['due', 'add_due', 'opening_balance', 'purchase_order', 'credit_usage'].includes(t.type);

      if (isPayment) totalPayments += Math.abs(Number(t.amount || 0));
      else if (isCredit) totalDues += Math.abs(Number(t.amount || 0));
    });

    const calculatedBalance = parseFloat((totalDues - totalPayments).toFixed(2));

    await Supplier.findByIdAndUpdate(supplierId, {
      dueAmount: calculatedBalance
    });
    console.log(`[Sync] Recalculated balance for supplier ${supplierId}: ${calculatedBalance}`);
  } catch (error) {
    console.error("Error recalculating supplier balance:", error);
  }
};

const adjustProductStockForOrder = async (sellerId, orderItems) => {
  //(`🔄 [BATCH_REDUCTION] Starting batch stock reduction for ${orderItems.length} items`);
  if (!Array.isArray(orderItems) || orderItems.length === 0) {
    //(`🔄 [BATCH_REDUCTION] No items to process`);
    return;
  }

  for (const item of orderItems) {
    try {
      if (!item || !item.productId || !mongoose.Types.ObjectId.isValid(item.productId)) {
        continue;
      }

      const quantity = typeof item.quantity === 'number' ? item.quantity : parseFloat(item.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        continue;
      }

      // Get product to check trackExpiry setting
      const Product = require('../models/Product');
      const product = await Product.findOne({ _id: item.productId, sellerId });

      if (!product) {
        console.warn(`Product not found for seller`);
        continue;
      }

      // Determine sorting logic based on trackExpiry
      let sortCriteria;
      if (product.trackExpiry) {
        // FEFO (First Expired, First Out): Sort by expiry date ascending (earliest expiry first)
        sortCriteria = { expiry: 1 };
        //(`🎯 Using FEFO for product ${product.name} (trackExpiry: ${product.trackExpiry})`);
      } else {
        // FIFO (First In, First Out): Sort by creation date ascending (oldest first)
        sortCriteria = { createdAt: 1 };
        //(`🎯 Using FIFO for product ${product.name} (trackExpiry: ${product.trackExpiry})`);
      }

      // Find all active batches for this product with appropriate sorting
      const batches = await ProductBatch.find({
        sellerId,
        productId: item.productId,
        isDeleted: false,
        quantity: { $gt: 0 }
      }).sort(sortCriteria);

      // Found active batches

      //(`📦 Found ${batches.length} batches for product ${product.name}, needing ${quantity} units`);
      // Processing order batches

      let remainingQuantity = quantity;
      const deductionDetails = [];

      for (const batch of batches) {
        if (remainingQuantity <= 0) break;

        const deductQuantity = Math.min(batch.quantity, remainingQuantity);
        const originalQuantity = batch.quantity;

        batch.quantity -= deductQuantity;
        remainingQuantity -= deductQuantity;

        const savedBatch = await batch.save();
        //(`💾 Saved batch ${batch._id} with new quantity: ${savedBatch.quantity}`);

        deductionDetails.push({
          batchId: batch._id,
          batchNumber: batch.batchNumber,
          originalQuantity,
          deductedQuantity: deductQuantity,
          remainingQuantity: batch.quantity
        });

        //(`📦 Deducted ${deductQuantity} from batch ${batch.batchNumber || batch._id} (${originalQuantity} → ${batch.quantity}) | Remaining needed: ${remainingQuantity}`);
      }

      // If we couldn't deduct all quantity (insufficient stock), log a warning
      // Insufficient stock warning suppressed
      const totalDeducted = deductionDetails.reduce((sum, d) => sum + d.deductedQuantity, 0);
      //(`✅ Successfully deducted ${totalDeducted}/${quantity} units from ${deductionDetails.length} batches`);
      //(`📊 Deduction summary:`, deductionDetails);

      // Verify the changes were saved
      const updatedBatches = await ProductBatch.find({
        _id: { $in: deductionDetails.map(d => d.batchId) }
      }).select('_id batchNumber quantity');

      // Verification complete

    } catch (error) {
      // Error adjusting batch stock suppressed
    }
  }

  //(`✅ [BATCH_REDUCTION] Completed batch stock reduction for all ${orderItems.length} items`);
};

/**
 * Helper function to prevent duplicates based on unique identifier
 */
/**
 * Helper function to prevent duplicates based on unique identifier
 * Checks for existing document by sellerId and unique fields
 */
const findExistingDocument = async (Model, sellerId, uniqueFields) => {
  const query = { sellerId, ...uniqueFields };
  return await Model.findOne(query);
};

/**
 * Helper to resolve entity by ID or localId (Stable ID Strategy)
 * 
 * OFFLINE-FIRST ARCHITECTURE:
 * 1. Primary Identifier: `localId` (UUID) generated by frontend. This is stable across offline/online states.
 * 2. Backend Identifier: `_id` (ObjectId) generated by MongoDB. 
 * 
 * Resolution Logic:
 * - If `mongoId` is provided and valid, try to find by `_id`.
 * - If not found by `_id` (or `mongoId` invalid/missing), try to find by `localId`.
 * - This ensures robustness: we can resolve relations using either the permanent backend ID or the stable local ID.
 * - All sync functions should use this to resolve dependencies (e.g. finding a Customer for an Order).
 */
const resolveEntity = async (Model, sellerId, localId, mongoId) => {
  // Stricter resolution to prevent casting errors
  // Check mongoId only if it looks like a valid ObjectId string (24 chars hex)
  if (mongoId && typeof mongoId === 'string' && mongoId.length === 24 && mongoose.isValidObjectId(mongoId)) {
    const found = await Model.findOne({ _id: mongoId, sellerId });
    if (found) return found;
  }

  // Alternative: if mongoId is already an ObjectId object
  if (mongoId && mongoId instanceof mongoose.Types.ObjectId) {
    const found = await Model.findOne({ _id: mongoId, sellerId });
    if (found) return found;
  }

  if (localId) {
    // localId can be String or Number, but schema says String. 
    // Mongoose handles number to string cast for query usually.
    const found = await Model.findOne({ localId: String(localId), sellerId });
    if (found) return found;
  }
  return null;
};

/**
 * Helper to check if frontend ID already exists in backend
 * Uses a mapping table or checks by frontend ID field
 */
const findExistingByFrontendId = async (Model, sellerId, frontendId) => {
  // Some models might have a frontendId field for tracking
  // For now, we'll use name-based matching for most cases
  return null;
};

/**
 * Sync Customers
 */
const syncCustomers = async (req, res) => {
  try {
    const { items } = req.body;
    const sellerId = req.sellerId;
    const results = { success: [], failed: [] };
    let deletionCount = 0;

    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'Items must be an array' });
    }

    // Check if these are Customer Transactions (which have customerId, type, amount) and NOT Customers (which have name)
    if (items.length > 0) {
      const firstItem = items[0];
      if (firstItem.type && (firstItem.customerId || firstItem.customerLocalId) && firstItem.amount !== undefined) {
        return syncCustomerTransactions(req, res);
      }
    }

    // Sort items: Customers first, then CustomerTransactions
    const sortedItems = [...items].sort((a, b) => {
      const isATransaction = (a.type && (a.customerId || a.customerLocalId) && a.amount !== undefined);
      const isBTransaction = (b.type && (b.customerId || b.customerLocalId) && b.amount !== undefined);
      if (isATransaction && !isBTransaction) return 1;
      if (!isATransaction && isBTransaction) return -1;
      return 0;
    });

    for (const item of sortedItems) {
      try {
        const isTransaction = (item.type && (item.customerId || item.customerLocalId) && item.amount !== undefined);

        if (isTransaction) {
          // --- Process Customer Transaction ---
          if (item.isDeleted === true) {
            const existing = await resolveEntity(CustomerTransaction, sellerId, item.id, item._id);
            if (existing) {
              await CustomerTransaction.findByIdAndDelete(existing._id);
              results.success.push({ id: item.id, _id: existing._id, action: 'deleted', type: 'customerTransaction' });
              deletionCount++;
            } else {
              results.success.push({ id: item.id, _id: item._id || null, action: 'deleted', type: 'customerTransaction' });
            }
            continue;
          }

          let existingTx = await resolveEntity(CustomerTransaction, sellerId, item.id, item._id);

          // Resolve Customer
          let customerId = null;
          let customerLocalId = item.customerId || item.customerLocalId;
          let customerMongoId = item.customerMongoId || (mongoose.isValidObjectId(item.customerId) ? item.customerId : null);

          const customer = await resolveEntity(Customer, sellerId, customerLocalId, customerMongoId);
          if (customer) {
            customerId = customer._id;
            customerLocalId = customer.localId;
            customerMongoId = customer._id;
          } else if (item.customerId && mongoose.isValidObjectId(item.customerId)) {
            // Fallback: if provided ID is valid mongoID but not found via resolveEntity (which checks sellerId), try raw findById??
            // No, resolveEntity checks sellerId. If not found, it implies it doesn't exist or wrong seller.
          }

          if (!customerId && !customerLocalId) {
            results.failed.push({ id: item.id, error: `Customer ID missing for transaction` });
            continue;
          }

          // Resolve Order
          let orderId = null;
          let orderLocalId = item.orderId || item.orderLocalId;
          let orderMongoId = item.orderMongoId || (mongoose.isValidObjectId(item.orderId) ? item.orderId : null);

          if (orderLocalId || orderMongoId) {
            const order = await resolveEntity(Order, sellerId, orderLocalId, orderMongoId);
            if (order) {
              orderId = order._id;
              orderLocalId = order.localId;
              orderMongoId = order._id;
            }
          }

          const transactionData = {
            sellerId,
            customerId: customerId, // Can be null if using only localId currently? Schema requires customerId usually.
            // If customerId is null (not synced yet), we have a problem. 
            // BUT we sorted customers first. So if it's a new customer, it should exist by now.
            // If it's a legacy transaction referencing a deleted customer...
            customerLocalId,
            customerMongoId,
            type: item.type,
            amount: item.amount,
            date: item.date || new Date(),
            description: item.description || '',
            orderId: orderId,
            orderLocalId: orderLocalId,
            orderMongoId: orderMongoId,
            previousBalance: item.previousBalance || 0,
            currentBalance: item.currentBalance || 0,
            localId: item.id
          };

          if (existingTx) {
            Object.assign(existingTx, transactionData);
            await existingTx.save();
            results.success.push({ id: item.id, _id: existingTx._id, action: 'updated', type: 'customerTransaction' });
          } else {
            const newTx = new CustomerTransaction(transactionData);
            const saved = await newTx.save();
            results.success.push({ id: item.id, _id: saved._id, action: 'created', type: 'customerTransaction' });
          }
        } else {
          // --- Process Customer ---
          if (item.isDeleted === true) {
            const existing = await resolveEntity(Customer, sellerId, item.id, item._id);
            if (existing) {
              await Customer.findByIdAndDelete(existing._id);
              results.success.push({ id: item.id, _id: existing._id, action: 'deleted', type: 'customer' });
              deletionCount++;
              await adjustPlanUsage(sellerId, 'customers', -1);
            } else {
              results.success.push({ id: item.id, _id: item._id || null, action: 'deleted', type: 'customer' });
            }
            continue;
          }

          let existingCust = await resolveEntity(Customer, sellerId, item.id, item._id);

          if (!existingCust) {
            const mobileNumber = item.mobileNumber || item.phone;
            // Optional: match by mobile
          }

          if (existingCust) {
            existingCust.name = item.name.trim();
            existingCust.dueAmount = item.dueAmount !== undefined ? item.dueAmount : existingCust.dueAmount;
            existingCust.mobileNumber = item.mobileNumber || item.phone || existingCust.mobileNumber;
            existingCust.email = item.email !== undefined ? item.email : existingCust.email;
            existingCust.address = item.address !== undefined ? item.address : existingCust.address;
            existingCust.isDeleted = false;
            existingCust.localId = item.id || existingCust.localId; // Ensure localId provided
            await existingCust.save();
            results.success.push({ id: item.id, _id: existingCust._id, action: 'updated', type: 'customer' });
          } else {
            const customer = new Customer({
              sellerId,
              name: item.name,
              dueAmount: item.dueAmount || 0,
              mobileNumber: item.mobileNumber || item.phone || '',
              email: item.email,
              localId: item.id
            });
            const saved = await customer.save();
            const usageResult = await adjustPlanUsage(sellerId, 'customers', 1);
            if (!usageResult.success) {
              await Customer.findByIdAndUpdate(saved._id, { isDeleted: true, updatedAt: new Date() });
              results.failed.push({ id: item.id, error: usageResult.message || 'Plan limit exceeded', action: 'limit-exceeded' });
              continue;
            }
            results.success.push({ id: item.id, _id: saved._id, action: 'created', type: 'customer' });
          }
        }
      } catch (error) {
        console.error('Error syncing customer/transaction:', error);
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    if (results.success.length > 0 || deletionCount > 0) {
      const [customerCount, txCount] = await Promise.all([
        Customer.countDocuments({ sellerId }),
        CustomerTransaction.countDocuments({ sellerId })
      ]);
      await Promise.all([
        SyncTracking.updateLatestTime(sellerId, 'customers', customerCount),
        SyncTracking.updateLatestTime(sellerId, 'customerTransactions', txCount)
      ]);
    }

    res.json({ success: true, results, summary: { total: items.length, successful: results.success.length, failed: results.failed.length } });
  } catch (error) {
    console.error('Sync customers error:', error);
    res.status(500).json({ success: false, message: 'Error syncing customers', error: error.message });
  }
};

/**
 * Sync Categories (must be done before products)
 */
const syncCategories = async (req, res) => {
  try {
    const { items } = req.body;
    const sellerId = req.sellerId;
    const results = { success: [], failed: [] };
    let deletionCount = 0;

    if (!Array.isArray(items)) {
      return res.status(400).json({
        success: false,
        message: 'Items must be an array'
      });
    }

    for (const item of items) {
      try {
        // Handle deletion: if item has isDeleted: true, delete it from MongoDB
        if (item.isDeleted === true) {
          const existing = await resolveEntity(ProductCategory, sellerId, item.id, item._id);

          if (existing) {
            // Delete from MongoDB
            await ProductCategory.findByIdAndUpdate(existing._id, {
              isDeleted: true,
              updatedAt: new Date()
            });
            results.success.push({ id: item.id, _id: existing._id, action: 'deleted' });
            deletionCount++;
          } else {
            // Item doesn't exist in backend, or _id doesn't match - treat as success
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue; // Skip to next item
        }

        // Normal sync (create or update)
        let existing = await resolveEntity(ProductCategory, sellerId, item.id, item._id);

        if (!existing) {
          existing = await findExistingDocument(
            ProductCategory,
            sellerId,
            { name: item.name }
          );
        }

        if (existing) {
          existing.name = item.name;
          existing.description = item.description;
          existing.image = item.image;
          existing.onlineSale = item.onlineSale !== false;
          existing.isActive = item.isActive !== undefined ? item.isActive : true;
          existing.isDeleted = false; // Ensure it's not hidden if re-synced
          // Ensure localId is set if found by name but missing localId
          if (!existing.localId && item.id) existing.localId = item.id;

          const saved = await existing.save();
          results.success.push({ id: item.id, _id: saved._id, action: 'exists_updated' });
        } else {
          // Create new category
          const category = new ProductCategory({
            sellerId,
            name: item.name,
            description: item.description,
            image: item.image,
            onlineSale: item.onlineSale !== false,
            isActive: item.isActive !== undefined ? item.isActive : true,
            localId: item.id,
            isDeleted: false
          });
          const saved = await category.save();
          results.success.push({ id: item.id, _id: saved._id, action: 'created' });
        }
      } catch (error) {
        console.error('Error syncing category:', error);
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    // Update sync tracking if there were successful syncs or deletions
    if (results.success.length > 0 || deletionCount > 0) {
      try {
        // Get actual count of categories for this seller (excluding soft deleted)
        const categoryCount = await ProductCategory.countDocuments({ sellerId, isDeleted: { $ne: true } });
        await SyncTracking.updateLatestTime(sellerId, 'categories', categoryCount);
        //(`📊 Updated sync tracking for categories: ${categoryCount} remaining (deleted ${deletionCount})`);
      } catch (trackingError) {
        console.error('Error updating sync tracking for categories:', trackingError);
      }
    }

    res.json({
      success: true,
      results,
      summary: {
        total: items.length,
        successful: results.success.length,
        failed: results.failed.length
      }
    });
  } catch (error) {
    console.error('Sync categories error:', error);
    res.status(500).json({
      success: false,
      message: 'Error syncing categories',
      error: error.message
    });
  }
};

/**
 * Sync Products (requires categories to be synced first)
 */
/**
 * Sync Products (requires categories to be synced first)
 */
const syncProducts = async (req, res) => {
  try {
    const { items } = req.body;
    const sellerId = req.sellerId;
    const results = { success: [], failed: [] };
    let deletionCount = 0;

    if (!Array.isArray(items)) {
      return res.status(400).json({
        success: false,
        message: 'Items must be an array'
      });
    }

    for (const item of items) {
      try {
        // Handle deletion
        if (item.isDeleted === true) {
          const existing = await resolveEntity(Product, sellerId, item.id, item._id);

          if (existing) {
            await Product.findByIdAndDelete(existing._id);
            results.success.push({ id: item.id, _id: existing._id, action: 'deleted' });
            deletionCount++;
            const usageResult = await adjustPlanUsage(sellerId, 'products', -1);
          } else {
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue;
        }

        // Resolve Category
        let categoryId = null;
        let categoryLocalId = item.categoryId || item.categoryLocalId;
        let categoryMongoId = item.categoryMongoId || (mongoose.isValidObjectId(item.categoryId) ? item.categoryId : null);

        // Try to find category
        const category = await resolveEntity(ProductCategory, sellerId, categoryLocalId, categoryMongoId);

        if (category) {
          categoryId = category._id;
          categoryLocalId = category.localId;
          categoryMongoId = category._id;
        } else if (item.category) {
          // Fallback: find/create by name (legacy)
          const categoryName = item.category.trim().toLowerCase();
          let cat = await ProductCategory.findOne({
            sellerId,
            $or: [
              { name: { $regex: new RegExp(`^${categoryName}$`, 'i') } },
              { name: categoryName }
            ]
          });
          if (!cat) {
            cat = new ProductCategory({
              sellerId,
              name: categoryName,
              isActive: true,
              image: item.categoryImage || '',
              description: item.categoryDescription || ''
            });
            await cat.save();
          }
          categoryId = cat._id;
          categoryLocalId = cat.localId; // Might be null for new cat
          categoryMongoId = cat._id;
        }

        // Find Existing Product
        let existing = await resolveEntity(Product, sellerId, item.id, item._id);

        // Fallback: Match by name/description
        if (!existing) {
          const productName = item.name.trim();
          const productDescription = (item.description || '').trim();
          const query = { sellerId, name: productName };
          if (productDescription) query.description = productDescription;
          else query.$or = [{ description: { $exists: false } }, { description: '' }, { description: null }];

          existing = await Product.findOne(query);
        }

        const productData = {
          name: item.name,
          unit: item.unit || item.quantityUnit || 'pcs',
          costPrice: item.costPrice !== undefined ? item.costPrice : (item.unitPrice !== undefined ? item.unitPrice : 0),
          sellingUnitPrice: item.sellingUnitPrice !== undefined ? item.sellingUnitPrice : (item.sellingPrice !== undefined ? item.sellingPrice : 0),
          mfg: item.mfg || item.mfgDate ? new Date(item.mfg || item.mfgDate) : undefined,
          expiryDate: item.expiryDate ? new Date(item.expiryDate) : undefined,
          trackExpiry: item.trackExpiry !== undefined ? item.trackExpiry : false,
          expiryThreshold: item.expiryThreshold !== undefined ? item.expiryThreshold : 30,
          description: item.description !== undefined ? item.description : '',
          barcode: item.barcode !== undefined ? item.barcode : '',
          lowStockLevel: item.lowStockLevel !== undefined ? item.lowStockLevel : 10,
          isActive: item.isActive !== undefined ? item.isActive : true,
          wholesalePrice: item.wholesalePrice !== undefined ? item.wholesalePrice : 0,
          wholesaleMOQ: item.wholesaleMOQ !== undefined ? item.wholesaleMOQ : 1,
          hsnCode: item.hsnCode !== undefined ? item.hsnCode : '',
          gstPercent: item.gstPercent !== undefined ? item.gstPercent : 0,
          isGstInclusive: item.isGstInclusive !== undefined ? item.isGstInclusive : true,
          longDescription: item.longDescription || '',
          isFeatured: item.isFeatured || false,
          discountPrice: item.discountPrice || 0,
          images: item.images || [],
          onlineSale: item.onlineSale !== false,

          // ID fields
          localId: item.id,
          categoryId: categoryId, // Legacy
          categoryLocalId: categoryLocalId,
          categoryMongoId: categoryMongoId,

          isDeleted: false
        };

        if (existing) {
          // Update
          Object.assign(existing, productData);
          await existing.save();
          results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
        } else {
          // Create
          const product = new Product({ ...productData, sellerId });
          const saved = await product.save();
          const usageResult = await adjustPlanUsage(sellerId, 'products', 1);
          if (!usageResult.success) {
            await Product.findByIdAndUpdate(saved._id, { isDeleted: true });
            results.failed.push({ id: item.id, error: usageResult.message, action: 'limit-exceeded' });
            continue;
          }
          results.success.push({ id: item.id, _id: saved._id, action: 'created' });
        }
      } catch (error) {
        console.error('Error syncing product:', error);
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    // Tracking updates
    if (results.success.length > 0 || deletionCount > 0) {
      const productCount = await Product.countDocuments({ sellerId });
      await SyncTracking.updateLatestTime(sellerId, 'products', productCount);
    }

    res.json({
      success: true,
      results,
      summary: { total: items.length, successful: results.success.length, failed: results.failed.length }
    });

    setImmediate(() => checkAndSendInventoryAlerts(sellerId).catch(console.error));
  } catch (error) {
    console.error('Sync products error:', error);
    res.status(500).json({ success: false, message: 'Error syncing products', error: error.message });
  }
};

/**
 * Sync Product Batches
 */
const syncProductBatches = async (req, res) => {
  try {
    const { items } = req.body;
    const sellerId = req.sellerId;
    const results = { success: [], failed: [] };
    let deletionCount = 0;

    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'Items must be an array' });
    }

    for (const item of items) {
      try {
        // Handle deletion
        if (item.isDeleted === true) {
          const existing = await resolveEntity(ProductBatch, sellerId, item.id, item._id);
          if (existing) {
            await ProductBatch.findByIdAndDelete(existing._id);
            results.success.push({ id: item.id, _id: existing._id, action: 'deleted' });
            deletionCount++;
          } else {
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue;
        }

        // Resolve Product
        let productId = null;
        let productLocalId = item.productLocalId || item.productId;

        // Strict detection: only treat as mongoId if it's a 24-char hex string
        let productMongoId = item.productMongoId;
        if (!productMongoId && typeof item.productId === 'string' && item.productId.length === 24 && mongoose.isValidObjectId(item.productId)) {
          productMongoId = item.productId;
        }

        const product = await resolveEntity(Product, sellerId, productLocalId, productMongoId);

        if (!product) {
          results.failed.push({ id: item.id, error: `Product not found for batch (ID: ${productLocalId || productMongoId})` });
          continue;
        }

        productId = product._id;
        productLocalId = product.localId;
        productMongoId = product._id;

        // Find Existing Batch
        let existing = await resolveEntity(ProductBatch, sellerId, item.id, item._id);

        // Fallback: match by product + batch number (if provided)
        if (!existing) {
          existing = await ProductBatch.findOne({
            sellerId,
            productId,
            batchNumber: item.batchNumber || ''
          });
        }

        const batchData = {
          sellerId,
          productId: productId,
          productLocalId: productLocalId,
          productMongoId: productMongoId,
          batchNumber: item.batchNumber || '',
          mfg: (item.mfg && item.mfg !== 'null') ? new Date(item.mfg) : null,
          expiry: (item.expiry && item.expiry !== 'null') ? new Date(item.expiry) : null,
          quantity: Number(item.quantity) || 0,
          costPrice: Number(item.costPrice) || 0,
          sellingUnitPrice: Number(item.sellingUnitPrice) || 0,
          wholesalePrice: Number(item.wholesalePrice) || 0,
          wholesaleMOQ: Number(item.wholesaleMOQ) || 1,
          localId: item.id
        };

        if (existing) {
          Object.assign(existing, batchData);
          await existing.save();
          results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
        } else {
          const newBatch = new ProductBatch(batchData);
          await newBatch.save();
          results.success.push({ id: item.id, _id: newBatch._id, action: 'created' });
        }
      } catch (error) {
        console.error('Error syncing product batch:', error);
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    if (results.success.length > 0 || deletionCount > 0) {
      await SyncTracking.updateLatestTime(sellerId, 'productBatches', results.success.length + deletionCount);
    }

    res.json({
      success: true,
      message: `Synced ${results.success.length} batches`,
      results
    });

    setImmediate(() => checkAndSendInventoryAlerts(sellerId).catch(console.error));
  } catch (error) {
    console.error('Sync product batches error:', error);
    res.status(500).json({ success: false, message: 'Error', error: error.message });
  }
};

/**
 * Sync Orders (sales/billing records)
 */
const syncOrders = async (req, res) => {
  try {
    const { items } = req.body;
    const sellerId = req.sellerId;
    const results = { success: [], failed: [] };
    let deletionCount = 0;

    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'Items must be an array' });
    }

    for (const item of items) {
      try {
        // Handle deletion
        if (item.isDeleted === true) {
          const existing = await resolveEntity(Order, sellerId, item.id, item._id);
          if (existing) {
            await Order.findByIdAndUpdate(existing._id, { isDeleted: true, updatedAt: new Date() });
            results.success.push({ id: item.id, _id: existing._id, action: 'deleted' });
            deletionCount++;
            await adjustPlanUsage(sellerId, 'orders', -1);
          } else {
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue;
        }

        // Validate
        if (!item.items || !Array.isArray(item.items) || item.items.length === 0) throw new Error('Order must have at least one item');
        if (item.totalAmount === undefined || item.totalAmount === null || typeof item.totalAmount !== 'number' || item.totalAmount < 0) throw new Error('Order must have valid totalAmount');

        // Resolve Customer
        let customerId = item.customerId; // This might be localId from frontend
        let customerLocalId = item.customerLocalId || item.customerId; // Prefer explicit localId, fallback to customerId
        let customerMongoId = item.customerMongoId;
        let resolvedCustomerId = null; // The actual ObjectId

        // Check if item.customerId is already a MongoId
        if (mongoose.isValidObjectId(item.customerId)) {
          customerMongoId = item.customerId;
        }

        const customer = await resolveEntity(Customer, sellerId, customerLocalId, customerMongoId);

        if (customer) {
          resolvedCustomerId = customer._id;
          customerLocalId = customer.localId;
          customerMongoId = customer._id;
        } else if (item.customerId) {
          // Only warn if a customer ID was provided but not found
          // It might be a guest user if customerId is missing/null, but if provided, it should exist
          // However, for offline sync, we might receive orders before customers.
          // But syncCustomers runs before syncOrders usually?
          // If not found, we set resolvedCustomerId to null to avoid casting errors, but keep LocalId
          console.warn(`Customer not found for order (ID: ${customerLocalId})`);
        }

        // Process Items (Resolve Products)
        const processedItems = [];
        for (const orderItem of item.items) {
          // Identify IDs
          const incomingProductId = orderItem.productId;
          const incomingProductLocalId = orderItem.productLocalId;
          const incomingProductMongoId = orderItem.productMongoId;

          const incomingDProductId = orderItem.dProductId;
          const incomingDProductLocalId = orderItem.dProductLocalId;
          const incomingDProductMongoId = orderItem.dProductMongoId;

          // Initialization
          let resolvedProductId = null;
          let productLocalId = incomingProductLocalId || (incomingProductId && (typeof incomingProductId !== 'string' || incomingProductId.length !== 24 || !mongoose.isValidObjectId(incomingProductId)) ? incomingProductId : null);
          let productMongoId = (incomingProductMongoId && typeof incomingProductMongoId === 'string' && incomingProductMongoId.length === 24 && mongoose.isValidObjectId(incomingProductMongoId)) ? incomingProductMongoId :
            (incomingProductId && typeof incomingProductId === 'string' && incomingProductId.length === 24 && mongoose.isValidObjectId(incomingProductId) ? incomingProductId : null);

          let resolvedDProductId = null;
          let dProductLocalId = incomingDProductLocalId || (incomingDProductId && (typeof incomingDProductId !== 'string' || incomingDProductId.length !== 24 || !mongoose.isValidObjectId(incomingDProductId)) ? incomingDProductId : null);
          let dProductMongoId = (incomingDProductMongoId && typeof incomingDProductMongoId === 'string' && incomingDProductMongoId.length === 24 && mongoose.isValidObjectId(incomingDProductMongoId)) ? incomingDProductMongoId :
            (incomingDProductId && typeof incomingDProductId === 'string' && incomingDProductId.length === 24 && mongoose.isValidObjectId(incomingDProductId) ? incomingDProductId : null);

          // Resolve Regular Product
          if (productLocalId || productMongoId) {
            const product = await resolveEntity(Product, sellerId, productLocalId, productMongoId);
            if (product) {
              resolvedProductId = product._id;
              productLocalId = product.localId;
              productMongoId = product._id;
            }
          }

          // Resolve DProduct
          if (orderItem.isDProduct && (dProductLocalId || dProductMongoId)) {
            const dProduct = await resolveEntity(DProduct, sellerId, dProductLocalId, dProductMongoId);
            if (dProduct) {
              resolvedDProductId = dProduct._id;
              dProductLocalId = dProduct.localId;
              dProductMongoId = dProduct._id;
            }
          }

          // Build clean item object
          const cleanedItem = { ...orderItem };

          // CRITICAL: Remove all ID fields before re-adding resolved ones to prevent casting errors from spread
          delete cleanedItem.productId;
          delete cleanedItem.productMongoId;
          delete cleanedItem.productLocalId;
          delete cleanedItem.dProductId;
          delete cleanedItem.dProductMongoId;
          delete cleanedItem.dProductLocalId;

          processedItems.push({
            ...cleanedItem,
            productId: resolvedProductId, // Will be ObjectId or null
            productLocalId: productLocalId, // String
            productMongoId: productMongoId, // ObjectId or null
            dProductId: resolvedDProductId, // Will be ObjectId or null
            dProductLocalId: dProductLocalId, // String
            dProductMongoId: dProductMongoId, // ObjectId or null
            // Ensure numbers
            quantity: Number(orderItem.quantity || 0),
            sellingPrice: Number(orderItem.sellingPrice || 0),
            costPrice: Number(orderItem.costPrice || 0)
          });
        }

        // Find Existing Order
        let existing = await resolveEntity(Order, sellerId, item.id, item._id);

        if (!existing && item.id) {
          // Duplicate check by content (legacy protection)
          const orderCreatedAt = item.createdAt || item.date;
          // ... duplicate check implementation if really needed, skipping for brevity/performance unless critical
          // Keeping it simple: Trust localId. 
        }

        // Prepare Data
        const orderData = {
          sellerId,
          customerId: resolvedCustomerId,
          customerLocalId: customerLocalId,
          customerMongoId: customerMongoId,
          customerName: item.customerName || '',
          customerMobile: item.customerMobile || '',
          items: processedItems,
          totalAmount: item.totalAmount,
          subtotal: item.subtotal || item.totalAmount,
          discountPercent: item.discountPercent || 0,
          taxPercent: item.taxPercent || 0,
          paymentMethod: item.paymentMethod || 'cash',
          splitPaymentDetails: item.splitPaymentDetails,
          invoiceNumber: item.invoiceNumber,
          allPaymentClear: item.allPaymentClear,
          stockDeducted: item.stockDeducted || false,
          dueAdded: item.dueAdded || false,
          localId: item.id,
          isDeleted: false
        };

        // Logic for allPaymentClear inference...
        if (orderData.allPaymentClear === undefined) {
          const pm = orderData.paymentMethod;
          orderData.allPaymentClear = (pm !== 'due' && pm !== 'credit' && !(pm === 'split' && item.splitPaymentDetails?.dueAmount > 0));
        }

        if (existing) {
          // Capture old due state
          const wasDueAdded = existing.dueAdded;
          const oldDue = (!existing.allPaymentClear && existing.paymentMethod === 'due') ? existing.totalAmount :
            (existing.splitPaymentDetails?.dueAmount || 0);

          Object.assign(existing, orderData);
          await existing.save();

          // Update customer due
          if (resolvedCustomerId && existing.dueAdded) { // Only if due WAS added (or we are maintaining it)
            // Re-calculate diff is hard. 
            // Simplified: If dueAdded is true, we assume the previous logic handled it.
            // If the order total/due changed, we adjust.
            // But honestly, recalculating entire customer balance from transactions is safer.
            // For now, minimal intervention.

            const newDue = (!existing.allPaymentClear && existing.paymentMethod === 'due') ? existing.totalAmount :
              (existing.splitPaymentDetails?.dueAmount || 0);

            if (wasDueAdded) {
              const diff = newDue - oldDue;
              if (diff !== 0) await Customer.findByIdAndUpdate(resolvedCustomerId, { $inc: { dueAmount: diff } });
            } else {
              // It wasn't added before (maybe new due?)
              if (newDue > 0) await Customer.findByIdAndUpdate(resolvedCustomerId, { $inc: { dueAmount: newDue } });
            }
          }

          results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
        } else {
          const order = new Order(orderData);
          const saved = await order.save();

          // Limits
          const usageResult = await adjustPlanUsage(sellerId, 'orders', 1);
          if (!usageResult.success) {
            await Order.findByIdAndUpdate(saved._id, { isDeleted: true });
            results.failed.push({ id: item.id, error: usageResult.message, action: 'limit-exceeded' });
            continue;
          }

          // Stock Deduction
          if (!item.stockDeducted) {
            await adjustProductStockForOrder(sellerId, processedItems);
            // Mark as deducted? No, avoid mutation if possible, or update Order? 
            // Usually adjustProductStock is side-effect.
          }

          // Customer Due
          if (resolvedCustomerId && !item.dueAdded) {
            const dueAmount = (!saved.allPaymentClear && saved.paymentMethod === 'due') ? saved.totalAmount :
              (saved.splitPaymentDetails?.dueAmount || 0);
            if (dueAmount > 0) {
              await Customer.findByIdAndUpdate(resolvedCustomerId, { $inc: { dueAmount: dueAmount } });
            }
          }

          results.success.push({ id: item.id, _id: saved._id, invoiceNumber: saved.invoiceNumber, action: 'created' });
        }

      } catch (error) {
        console.error('Error syncing order:', error);
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    if (results.success.length > 0 || deletionCount > 0) {
      const count = await Order.countDocuments({ sellerId, isDeleted: { $ne: true } });
      await SyncTracking.updateLatestTime(sellerId, 'orders', count);
    }

    res.json({ success: true, results, summary: { total: items.length, successful: results.success.length, failed: results.failed.length } });

    setImmediate(() => checkAndSendInventoryAlerts(sellerId).catch(console.error));
  } catch (error) {
    console.error('Sync orders error:', error);
    res.status(500).json({ success: false, message: 'Error syncing orders', error: error.message });
  }
};

/**
 * Sync Transactions (ONLY for plan purchases)
 */
const syncTransactions = async (req, res) => {
  try {
    const { items } = req.body;
    const sellerId = req.sellerId;
    const results = { success: [], failed: [] };

    if (!Array.isArray(items)) {
      return res.status(400).json({
        success: false,
        message: 'Items must be an array'
      });
    }

    for (const item of items) {
      try {
        // Handle deletion: if item has isDeleted: true
        if (item.isDeleted === true) {
          const existing = await resolveEntity(Transaction, sellerId, item.id, item._id);

          if (existing) {
            await Transaction.findByIdAndDelete(existing._id);
            results.success.push({ id: item.id, _id: existing._id, action: 'deleted' });
          } else {
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue;
        }

        // Check for duplicate by id from frontend or other unique identifier
        let existing = await resolveEntity(Transaction, sellerId, item.id, item._id);

        if (existing) {
          // Update existing transaction
          existing.type = item.type || existing.type;
          existing.amount = item.amount || item.total || existing.amount;
          existing.paymentMethod = item.paymentMethod || existing.paymentMethod;
          existing.description = item.description || existing.description;
          existing.date = item.date ? new Date(item.date) : existing.date;
          // Ensure localId if missing
          if (!existing.localId && item.id) existing.localId = item.id;

          await existing.save();
          results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
        } else {
          // Create new transaction
          const transaction = new Transaction({
            sellerId,
            type: item.type || 'sale',
            amount: item.amount || item.total || 0,
            paymentMethod: item.paymentMethod || 'cash',
            description: item.description,
            date: item.date ? new Date(item.date) : new Date(),
            razorpayOrderId: item.razorpayOrderId,
            razorpayPaymentId: item.razorpayPaymentId,
            planOrderId: item.planOrderId,
            planId: item.planId,
            localId: item.id
          });
          const saved = await transaction.save();
          results.success.push({ id: item.id, _id: saved._id, action: 'created' });
        }
      } catch (error) {
        console.error('Error syncing transaction:', error);
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    // Update sync tracking if there were successful syncs
    if (results.success.length > 0) {
      try {
        // Get actual count of transactions for this seller
        const transactionCount = await Transaction.countDocuments({ sellerId });
        await SyncTracking.updateLatestTime(sellerId, 'transactions', transactionCount);
      } catch (trackingError) {
        console.error('Error updating sync tracking for transactions:', trackingError);
      }
    }

    res.json({
      success: true,
      results,
      summary: {
        total: items.length,
        successful: results.success.length,
        failed: results.failed.length
      }
    });
  } catch (error) {
    console.error('Sync transactions error:', error);
    res.status(500).json({
      success: false,
      message: 'Error syncing transactions',
      error: error.message
    });
  }
};

/**
 * Sync Vendor Orders
 */
const syncVendorOrders = async (req, res) => {
  try {
    const { items } = req.body;
    const sellerId = req.sellerId;
    const results = { success: [], failed: [] };
    let deletionCount = 0;

    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'Items must be an array' });
    }

    for (const item of items) {
      try {
        if (item.isDeleted === true) {
          const existing = await resolveEntity(VendorOrder, sellerId, item.id, item._id);
          if (existing) {
            await VendorOrder.findByIdAndDelete(existing._id);
            results.success.push({ id: item.id, _id: existing._id, action: 'deleted' });
            deletionCount++;
          } else {
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue;
        }

        let existing = await resolveEntity(VendorOrder, sellerId, item.id, item._id);

        if (!existing && item.id) {
          existing = await VendorOrder.findOne({ sellerId, localId: item.id });
        }

        // Check for duplicate by content (if not found by ID)
        if (!existing) {
          const poCreatedAt = item.createdAt || item.date;
          const supplierName = (item.supplierName || '').trim();
          const itemsHash = JSON.stringify((item.items || []).map(i => ({
            productName: i.productName || i.name,
            quantity: i.quantity,
            price: i.price
          })).sort((a, b) => (a.productName || a.name || '').localeCompare(b.productName || b.name || '')));

          const similarPOs = await VendorOrder.find({
            sellerId,
            supplierName: supplierName,
            total: { $gte: (item.total || 0) - 0.01, $lte: (item.total || 0) + 0.01 }
          });

          for (const po of similarPOs) {
            const poItemsHash = JSON.stringify((po.items || []).map(i => ({
              productName: i.productName || i.name,
              quantity: i.quantity,
              price: i.price
            })).sort((a, b) => (a.productName || a.name || '').localeCompare(b.productName || b.name || '')));

            if (poItemsHash === itemsHash) {
              if (poCreatedAt && po.createdAt) {
                const poDate = new Date(po.createdAt);
                const itemDate = new Date(poCreatedAt);
                if (Math.abs(poDate.getTime() - itemDate.getTime()) <= 5000) {
                  existing = po;
                  break;
                }
              }
            }
          }
        }

        // Resolve Items (Products)
        const processedItems = [];
        if (item.items && Array.isArray(item.items)) {
          for (const poItem of item.items) {
            let productId = null;
            let productLocalId = poItem.productLocalId || poItem.productId;
            let productMongoId = poItem.productMongoId || (mongoose.isValidObjectId(poItem.productId) ? poItem.productId : null);

            const product = await resolveEntity(Product, sellerId, productLocalId, productMongoId);
            if (product) {
              productId = product._id;
              productLocalId = product.localId;
              productMongoId = product._id;
            }

            processedItems.push({
              ...poItem,
              productId: productId,
              productLocalId: productLocalId,
              productMongoId: productMongoId
            });
          }
        }

        // Resolve Supplier (if ID provided)
        let supplierId = null;
        let supplierLocalId = item.supplierId || item.supplierLocalId;
        let supplierMongoId = item.supplierMongoId || (mongoose.isValidObjectId(item.supplierId) ? item.supplierId : null);

        if (supplierLocalId || supplierMongoId) {
          const supplier = await resolveEntity(Supplier, sellerId, supplierLocalId, supplierMongoId);
          if (supplier) {
            supplierId = supplier._id;
            supplierLocalId = supplier.localId;
            supplierMongoId = supplier._id;
          }
        }

        const vendorOrderData = {
          supplierName: item.supplierName,
          supplierId: supplierId || undefined, // Keep undefined if not resolved/provided, utilize name
          supplierLocalId,
          supplierMongoId,
          items: processedItems,
          total: item.total || 0,
          status: item.status || 'pending',
          notes: item.notes || '',
          expectedDeliveryDate: item.expectedDeliveryDate ? new Date(item.expectedDeliveryDate) : null,
          actualDeliveryDate: item.actualDeliveryDate ? new Date(item.actualDeliveryDate) : null,
          cancelledAt: item.cancelledAt ? new Date(item.cancelledAt) : null,
          cancelledReason: item.cancelledReason || '',
          refundedAmount: item.refundedAmount || 0,
          localId: item.id,
          paymentMethod: item.paymentMethod || 'due',
          amountPaid: item.amountPaid || 0,
          balanceDue: item.balanceDue || 0,
          paymentStatus: item.paymentStatus || 'unpaid'
        };

        if (existing) {
          Object.assign(existing, vendorOrderData);
          await existing.save();
          results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
        } else {
          const vendorOrder = new VendorOrder({ ...vendorOrderData, sellerId });
          const saved = await vendorOrder.save();
          results.success.push({ id: item.id, _id: saved._id, action: 'created' });
        }
      } catch (error) {
        console.error('Error syncing vendor order:', error);
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    if (results.success.length > 0 || deletionCount > 0) {
      const vendorOrderCount = await VendorOrder.countDocuments({ sellerId, isDeleted: { $ne: true } });
      await SyncTracking.updateLatestTime(sellerId, 'vendorOrders', vendorOrderCount);
    }

    res.json({ success: true, results, summary: { total: items.length, successful: results.success.length, failed: results.failed.length } });
  } catch (error) {
    console.error('Sync vendor orders error:', error);
    res.status(500).json({ success: false, message: 'Error syncing vendor orders', error: error.message });
  }
};


/**
 * Internal sync functions (without req/res)
 */
const syncCategoriesInternal = async (sellerId, items) => {
  const results = { success: [], failed: [] };
  for (const item of items) {
    try {
      const existing = await findExistingDocument(ProductCategory, sellerId, { name: item.name });
      if (existing) {
        results.success.push({ id: item.id, _id: existing._id, action: 'exists' });
      } else {
        const category = new ProductCategory({ sellerId, name: item.name, description: item.description, isActive: item.isActive !== undefined ? item.isActive : true });
        const saved = await category.save();
        results.success.push({ id: item.id, _id: saved._id, action: 'created' });
      }
    } catch (error) {
      results.failed.push({ id: item.id, error: error.message });
    }
  }
  return results;
};

const syncProductsInternal = async (sellerId, items) => {
  const results = { success: [], failed: [] };
  for (const item of items) {
    try {
      let categoryId = null;
      if (item.category) {
        let category = await ProductCategory.findOne({ sellerId, name: item.category });
        if (!category) {
          category = new ProductCategory({ sellerId, name: item.category, isActive: true });
          await category.save();
        }
        categoryId = category._id;
      }
      // Check for duplicate by id/name + description
      const productName = item.name.trim();
      const productDescription = (item.description || '').trim();

      let existing = null;

      // Prefer matching by MongoDB _id when available
      if (item._id && mongoose.Types.ObjectId.isValid(item._id)) {
        const productById = await Product.findById(item._id);
        if (productById && productById.sellerId.toString() === sellerId.toString()) {
          existing = productById;
        }
      }

      // If description is provided, match by name + exact description
      if (!existing && productDescription) {
        existing = await Product.findOne({
          sellerId,
          name: productName,
          description: productDescription
        });
      } else if (!existing) {
        // If no description, match by name + empty/null description
        existing = await Product.findOne({
          sellerId,
          name: productName,
          $or: [
            { description: { $exists: false } },
            { description: '' },
            { description: null }
          ]
        });
      }

      if (existing) {
        // MongoDB uses 'stock' and 'costPrice'
        existing.unit = item.unit || existing.unit;
        existing.costPrice = item.costPrice !== undefined ? item.costPrice : (item.unitPrice !== undefined ? item.unitPrice : existing.costPrice);
        existing.sellingUnitPrice = item.sellingUnitPrice || item.sellingPrice || existing.sellingUnitPrice;
        existing.mfg = item.mfg || item.mfgDate ? new Date(item.mfg || item.mfgDate) : existing.mfg;
        existing.expiryDate = item.expiryDate ? new Date(item.expiryDate) : existing.expiryDate;
        existing.trackExpiry = item.trackExpiry !== undefined ? item.trackExpiry : existing.trackExpiry;
        existing.description = item.description || existing.description;
        existing.categoryId = categoryId || existing.categoryId;
        existing.barcode = item.barcode || existing.barcode || '';
        existing.lowStockLevel = item.lowStockLevel !== undefined ? item.lowStockLevel : existing.lowStockLevel;
        existing.isActive = item.isActive !== undefined ? item.isActive : existing.isActive;
        await existing.save();
        results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
      } else {
        // MongoDB uses 'stock' and 'costPrice'
        const product = new Product({
          sellerId,
          name: item.name,
          barcode: item.barcode || '',
          categoryId,
          unit: item.unit || 'pcs',
          lowStockLevel: item.lowStockLevel || 10,
          trackExpiry: item.trackExpiry || false,
          description: item.description || '',
          isActive: item.isActive !== undefined ? item.isActive : false
        });
        const saved = await product.save();
        results.success.push({ id: item.id, _id: saved._id, action: 'created' });
      }
    } catch (error) {
      results.failed.push({ id: item.id, error: error.message });
    }
  }
  return results;
};

const syncOrdersInternal = async (sellerId, items) => {
  const results = { success: [], failed: [] };
  for (const item of items) {
    try {
      // Validate required fields
      if (!item.items || !Array.isArray(item.items) || item.items.length === 0) {
        throw new Error('Order must have at least one item');
      }

      if (!item.totalAmount || typeof item.totalAmount !== 'number' || item.totalAmount <= 0) {
        throw new Error('Order must have a valid totalAmount');
      }

      // Validate payment method
      const validPaymentMethods = ['cash', 'card', 'upi', 'due', 'credit', 'split'];
      const paymentMethod = item.paymentMethod || 'cash';
      if (!validPaymentMethods.includes(paymentMethod)) {
        throw new Error(`Invalid payment method: ${paymentMethod}`);
      }

      // Validate split payment details if payment method is split
      if (paymentMethod === 'split') {
        if (!item.splitPaymentDetails) {
          throw new Error('Split payment requires splitPaymentDetails');
        }

        const splitDetails = item.splitPaymentDetails;
        const validSplitTypes = ['cash_online', 'online_due', 'cash_due'];

        if (!splitDetails.type || !validSplitTypes.includes(splitDetails.type)) {
          throw new Error(`Invalid split payment type: ${splitDetails.type || 'missing'}`);
        }

        // Validate amounts
        const cashAmount = typeof splitDetails.cashAmount === 'number' ? splitDetails.cashAmount : 0;
        const onlineAmount = typeof splitDetails.onlineAmount === 'number' ? splitDetails.onlineAmount : 0;
        const dueAmount = typeof splitDetails.dueAmount === 'number' ? splitDetails.dueAmount : 0;

        if (cashAmount < 0 || onlineAmount < 0 || dueAmount < 0) {
          throw new Error('Split payment amounts cannot be negative');
        }

        // Validate that amounts match the split type (amounts must be >= 0, but required amounts must be > 0)
        if (splitDetails.type === 'cash_online' && (cashAmount <= 0 || onlineAmount <= 0)) {
          throw new Error('Cash + Online split requires both cash and online amounts >= 0');
        }
        if (splitDetails.type === 'online_due' && (onlineAmount <= 0 || dueAmount <= 0)) {
          throw new Error('Online + Due split requires both online and due amounts >= 0');
        }
        if (splitDetails.type === 'cash_due' && (cashAmount <= 0 || dueAmount <= 0)) {
          throw new Error('Cash + Due split requires both cash and due amounts >= 0');
        }

        // Validate that split amounts sum to totalAmount (within 0.01 tolerance)
        const splitTotal = cashAmount + onlineAmount + dueAmount;
        if (Math.abs(splitTotal - item.totalAmount) > 0.01) {
          throw new Error(`Split payment total (${splitTotal.toFixed(2)}) must equal order total (${item.totalAmount.toFixed(2)})`);
        }
      }

      // Validate items array and normalize productId
      for (const orderItem of item.items) {
        if (!orderItem.name || typeof orderItem.name !== 'string' || orderItem.name.trim() === '') {
          throw new Error('Order item must have a valid name');
        }
        if (typeof orderItem.sellingPrice !== 'number' || orderItem.sellingPrice < 0) {
          throw new Error('Order item must have a valid sellingPrice');
        }
        if (typeof orderItem.costPrice !== 'number' || orderItem.costPrice < 0) {
          throw new Error('Order item must have a valid costPrice');
        }
        if (typeof orderItem.quantity !== 'number' || orderItem.quantity <= 0) {
          throw new Error('Order item must have a valid quantity');
        }
        if (!orderItem.unit || typeof orderItem.unit !== 'string') {
          throw new Error('Order item must have a valid unit');
        }

        // Normalize productId: convert valid ObjectId strings to ObjectId, invalid ones to null
        if (orderItem.productId) {
          if (mongoose.Types.ObjectId.isValid(orderItem.productId)) {
            // Valid ObjectId string - convert to ObjectId
            orderItem.productId = new mongoose.Types.ObjectId(orderItem.productId);
          } else {
            // Invalid ObjectId (likely a temporary frontend ID) - set to null
            console.warn(`Order item has invalid productId: ${orderItem.productId}, setting to null`);
            orderItem.productId = null;
          }
        } else {
          // No productId provided - set to null
          orderItem.productId = null;
        }
      }

      // Convert customerId to ObjectId if it's a string
      let customerId = null;
      if (item.customerId) {
        if (mongoose.Types.ObjectId.isValid(item.customerId)) {
          customerId = new mongoose.Types.ObjectId(item.customerId);
        } else {
          console.warn(`Invalid customerId format: ${item.customerId}`);
        }
      }

      // Check for duplicate by content
      let existing = null;
      if (item._id && mongoose.Types.ObjectId.isValid(item._id)) {
        existing = await Order.findById(item._id);
        if (existing && existing.sellerId.toString() !== sellerId.toString()) {
          existing = null;
        }
      }

      // If not found by _id, check for duplicate by content
      if (!existing) {
        const orderCreatedAt = item.createdAt || item.date;
        const customerId = item.customerId && mongoose.Types.ObjectId.isValid(item.customerId)
          ? new mongoose.Types.ObjectId(item.customerId)
          : null;

        const itemsHash = JSON.stringify((item.items || []).map(i => ({
          name: i.name,
          quantity: i.quantity,
          sellingPrice: i.sellingPrice,
          costPrice: i.costPrice
        })).sort((a, b) => (a.name || '').localeCompare(b.name || '')));

        const similarOrders = await Order.find({
          sellerId,
          customerId: customerId || null,
          totalAmount: { $gte: item.totalAmount - 0.01, $lte: item.totalAmount + 0.01 }
        });

        for (const order of similarOrders) {
          const orderItemsHash = JSON.stringify((order.items || []).map(i => ({
            name: i.name,
            quantity: i.quantity,
            sellingPrice: i.sellingPrice,
            costPrice: i.costPrice
          })).sort((a, b) => (a.name || '').localeCompare(b.name || '')));

          if (orderItemsHash === itemsHash && orderCreatedAt && order.createdAt) {
            const orderDate = new Date(order.createdAt);
            const itemDate = new Date(orderCreatedAt);
            const timeDiff = Math.abs(orderDate.getTime() - itemDate.getTime());
            // If orders are created within 5 seconds and have identical content, consider duplicate
            if (timeDiff <= 5000) {
              existing = order;
              //(`⚠️ Duplicate order detected by content (within 5s): ${order._id}`);
              break;
            }
          }
        }
      }

      if (existing && existing.sellerId.toString() === sellerId.toString()) {
        existing.customerId = customerId || existing.customerId;
        existing.paymentMethod = paymentMethod;
        existing.items = item.items;
        existing.totalAmount = item.totalAmount;

        // Update split payment details if present
        if (paymentMethod === 'split' && item.splitPaymentDetails) {
          existing.splitPaymentDetails = {
            type: item.splitPaymentDetails.type,
            cashAmount: item.splitPaymentDetails.cashAmount || 0,
            onlineAmount: item.splitPaymentDetails.onlineAmount || 0,
            dueAmount: item.splitPaymentDetails.dueAmount || 0
          };
        } else {
          // Clear split payment details if payment method changed - use undefined instead of null
          existing.splitPaymentDetails = undefined;
        }
        await existing.save();
        results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
      } else {
        const orderData = {
          sellerId,
          customerId: customerId,
          paymentMethod: paymentMethod,
          items: item.items,
          totalAmount: item.totalAmount
        };

        // Add split payment details only if payment method is split and details are provided
        // Don't include splitPaymentDetails at all if it's null or payment method is not split
        if (paymentMethod === 'split' && item.splitPaymentDetails && item.splitPaymentDetails !== null) {
          orderData.splitPaymentDetails = {
            type: item.splitPaymentDetails.type,
            cashAmount: item.splitPaymentDetails.cashAmount || 0,
            onlineAmount: item.splitPaymentDetails.onlineAmount || 0,
            dueAmount: item.splitPaymentDetails.dueAmount || 0
          };
        }

        const order = new Order(orderData);
        const saved = await order.save();
        const usageResult = await adjustPlanUsage(sellerId, 'orders', 1);
        if (!usageResult.success) {
          await Order.findByIdAndUpdate(saved._id, {
            isDeleted: true,
            updatedAt: new Date()
          });
          results.failed.push({ id: item.id, error: usageResult.message || 'Plan limit reached', action: 'limit-exceeded' });
          continue;
        }

        // Always deduct from batches in backend (batch-based inventory system)
        // The stockDeducted flag was for old product-based system
        //(`[SYNC] Deducting from product batches for order ${item.id}`);
        await adjustProductStockForOrder(sellerId, item.items);

        results.success.push({ id: item.id, _id: saved._id, action: 'created' });
      }
    } catch (error) {
      console.error('Error syncing order:', error);
      results.failed.push({ id: item.id, error: error.message });
    }
  }
  return results;
};

const syncCustomersInternal = async (sellerId, items) => {
  const results = { success: [], failed: [] };
  for (const item of items) {
    try {
      // Check for duplicate by name + mobileNumber (or email)
      const mobileNumber = item.mobileNumber || item.phone;
      const email = item.email;

      let existing = null;
      if (mobileNumber) {
        existing = await Customer.findOne({
          sellerId,
          name: item.name.trim(),
          mobileNumber: mobileNumber.trim()
        });
      }

      if (!existing && email) {
        existing = await Customer.findOne({
          sellerId,
          name: item.name.trim(),
          email: email.trim().toLowerCase()
        });
      }

      if (existing) {
        existing.dueAmount = item.dueAmount || existing.dueAmount;
        // Use mobileNumber, fallback to phone for backward compatibility
        existing.mobileNumber = item.mobileNumber || item.phone || existing.mobileNumber;
        existing.email = item.email || existing.email;
        await existing.save();
        results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
      } else {
        // Use mobileNumber, fallback to phone for backward compatibility
        const customer = new Customer({
          sellerId,
          name: item.name,
          dueAmount: item.dueAmount || 0,
          mobileNumber: item.mobileNumber || item.phone || '',
          email: item.email
        });
        const saved = await customer.save();
        results.success.push({ id: item.id, _id: saved._id, action: 'created' });
      }
    } catch (error) {
      results.failed.push({ id: item.id, error: error.message });
    }
  }
  return results;
};

const syncTransactionsInternal = async (sellerId, items) => {
  const results = { success: [], failed: [] };
  for (const item of items) {
    try {
      let existing = (item._id && mongoose.Types.ObjectId.isValid(item._id)) ? await Transaction.findById(item._id) : null;
      if (existing && existing.sellerId.toString() === sellerId.toString()) {
        existing.amount = item.amount || item.total || existing.amount;
        existing.paymentMethod = item.paymentMethod || existing.paymentMethod;
        await existing.save();
        results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
      } else {
        const transaction = new Transaction({ sellerId, type: item.type || 'sale', amount: item.amount || item.total || 0, paymentMethod: item.paymentMethod || 'cash', description: item.description, date: item.date ? new Date(item.date) : new Date() });
        const saved = await transaction.save();
        results.success.push({ id: item.id, _id: saved._id, action: 'created' });
      }
    } catch (error) {
      results.failed.push({ id: item.id, error: error.message });
    }
  }
  return results;
};

const syncVendorOrdersInternal = async (sellerId, items) => {
  const results = { success: [], failed: [] };
  for (const item of items) {
    try {
      // Check for duplicate by content
      let existing = null;
      if (item._id && mongoose.Types.ObjectId.isValid(item._id)) {
        existing = await VendorOrder.findById(item._id);
        if (existing && existing.sellerId.toString() !== sellerId.toString()) {
          existing = null;
        }
      }

      // If not found by _id, check for duplicate by content
      if (!existing) {
        const poCreatedAt = item.createdAt || item.date;
        const supplierName = (item.supplierName || '').trim();

        const itemsHash = JSON.stringify((item.items || []).map(i => ({
          productName: i.productName || i.name,
          quantity: i.quantity,
          price: i.price
        })).sort((a, b) => (a.productName || a.name || '').localeCompare(b.productName || b.name || '')));

        const similarPOs = await VendorOrder.find({
          sellerId,
          supplierName: supplierName,
          total: { $gte: (item.total || 0) - 0.01, $lte: (item.total || 0) + 0.01 }
        });

        for (const po of similarPOs) {
          const poItemsHash = JSON.stringify((po.items || []).map(i => ({
            productName: i.productName || i.name,
            quantity: i.quantity,
            price: i.price
          })).sort((a, b) => (a.productName || a.name || '').localeCompare(b.productName || b.name || '')));

          if (poItemsHash === itemsHash && poCreatedAt && po.createdAt) {
            const poDate = new Date(po.createdAt);
            const itemDate = new Date(poCreatedAt);
            const timeDiff = Math.abs(poDate.getTime() - itemDate.getTime());
            // If vendor orders are created within 5 seconds and have identical content, consider duplicate
            if (timeDiff <= 5000) {
              existing = po;
              //(`⚠️ Duplicate vendor order detected by content (within 5s): ${po._id}`);
              break;
            }
          }
        }
      }

      if (existing && existing.sellerId.toString() === sellerId.toString()) {
        existing.items = item.items || existing.items;
        existing.total = item.total || existing.total;
        existing.status = item.status || existing.status;
        await existing.save();
        results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
      } else {
        const vendorOrder = new VendorOrder({ sellerId, supplierName: item.supplierName, items: item.items || [], total: item.total || 0, status: item.status || 'pending' });
        const saved = await vendorOrder.save();
        results.success.push({ id: item.id, _id: saved._id, action: 'created' });
      }
    } catch (error) {
      results.failed.push({ id: item.id, error: error.message });
    }
  }
  return results;
};

/**
 * Get sync status
 */
const getSyncStatus = async (req, res) => {
  try {
    const sellerId = req.sellerId;

    const counts = {
      customers: await Customer.countDocuments({ sellerId }),
      products: await Product.countDocuments({ sellerId }),
      transactions: await Transaction.countDocuments({ sellerId }),
      vendorOrders: await VendorOrder.countDocuments({ sellerId }),
      categories: await ProductCategory.countDocuments({ sellerId })
    };

    res.json({
      success: true,
      sellerId,
      counts
    });
  } catch (error) {
    console.error('Get sync status error:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting sync status',
      error: error.message
    });
  }
};

/**
 * Sync Refunds
 */
const syncRefunds = async (req, res) => {
  try {
    const { items } = req.body;
    const sellerId = req.sellerId;
    const results = { success: [], failed: [] };
    let deletionCount = 0;

    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'Items must be an array' });
    }

    for (const item of items) {
      try {
        if (item.isDeleted === true) {
          const existing = await resolveEntity(Refund, sellerId, item.id, item._id);
          if (existing) {
            await Refund.findByIdAndUpdate(existing._id, { isDeleted: true, updatedAt: new Date() });
            results.success.push({ id: item.id, _id: existing._id, action: 'deleted' });
            deletionCount++;
          } else {
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue;
        }

        let existing = await resolveEntity(Refund, sellerId, item.id, item._id);

        if (!existing && item.id) {
          existing = await Refund.findOne({ sellerId, localId: item.id });
        }

        // Resolve Entities
        let orderId = null;
        let orderLocalId = item.orderId || item.orderLocalId;
        let orderMongoId = item.orderMongoId || (mongoose.isValidObjectId(item.orderId) ? item.orderId : null);
        const order = await resolveEntity(Order, sellerId, orderLocalId, orderMongoId);
        if (order) {
          orderId = order._id;
          orderLocalId = order.localId;
          orderMongoId = order._id;
        }

        let customerId = item.customerId;
        let customerLocalId = item.customerLocalId || item.customerId;
        let customerMongoId = item.customerMongoId || (mongoose.isValidObjectId(item.customerId) ? item.customerId : null);
        const customer = await resolveEntity(Customer, sellerId, customerLocalId, customerMongoId);
        if (customer) {
          customerId = customer._id;
          customerLocalId = customer.localId;
          customerMongoId = customer._id;
        }

        // Resolve Items
        const processedItems = [];
        if (item.items && Array.isArray(item.items)) {
          for (const rItem of item.items) {
            let productId = null;
            let productLocalId = rItem.productLocalId || rItem.productId;
            let productMongoId = rItem.productMongoId || (mongoose.isValidObjectId(rItem.productId) ? rItem.productId : null);

            const product = await resolveEntity(Product, sellerId, productLocalId, productMongoId);
            if (product) {
              productId = product._id;
              productLocalId = product.localId;
              productMongoId = product._id;
            }

            processedItems.push({
              ...rItem,
              productId: productId,
              productLocalId: productLocalId,
              productMongoId: productMongoId
            });
          }
        }

        const refundData = {
          orderId,
          orderLocalId,
          orderMongoId,
          customerId,
          customerLocalId,
          customerMongoId,
          sellerId,
          items: processedItems,
          totalRefundAmount: item.totalRefundAmount || 0,
          reason: item.reason || '',
          refundedByUser: item.refundedByUser || 'System',
          localId: item.id
        };

        if (existing) {
          Object.assign(existing, refundData);
          await existing.save();
          results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
        } else {
          // Validate order existence before creation?
          // If orderId is null, it's a problem. 
          if (!orderId && !orderLocalId) {
            results.failed.push({ id: item.id, error: 'Order not found for refund' });
            continue;
          }

          const refund = new Refund(refundData);
          const saved = await refund.save();
          results.success.push({ id: item.id, _id: saved._id, action: 'created' });

          // Stock Logic: If stockAdjusted is false, update stock
          if (item.stockAdjusted !== true) {
            // Logic to update batches... 
            // Assuming existing logic was empty or weirdly implemented inline. 
            // Will leave as is: "Stock adjustment for refunds is handled in refund controller" or implemented here?
            // The previous code had a loop for products but commented "handled in refund controller". 
            // I'll stick to that behaviour.
          }
        }
      } catch (error) {
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    if (results.success.length > 0 || deletionCount > 0) {
      const count = await Refund.countDocuments({ sellerId, isDeleted: { $ne: true } });
      await SyncTracking.updateLatestTime(sellerId, 'refunds', count);
    }

    res.json({ success: true, results, summary: { total: items.length, successful: results.success.length, failed: results.failed.length } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error', error: error.message });
  }
};

/**
 * Sync Expenses
 */
const syncExpenses = async (req, res) => {
  try {
    const { items } = req.body;
    const sellerId = req.sellerId;
    const results = { success: [], failed: [] };
    let deletionCount = 0;

    if (!Array.isArray(items)) {
      return res.status(400).json({
        success: false,
        message: 'Items must be an array'
      });
    }

    for (const item of items) {
      try {
        // Handle deletion: if item has isDeleted: true, delete it from MongoDB
        if (item.isDeleted === true) {
          const existing = await resolveEntity(Expense, sellerId, item.id, item._id);

          if (existing) {
            await Expense.findByIdAndDelete(existing._id);
            results.success.push({ id: item.id, _id: existing._id, action: 'deleted' });
            deletionCount++;
          } else {
            // Item doesn't exist in backend, or _id doesn't match - treat as success
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue;
        }

        // Normal sync (create or update)
        let existing = await resolveEntity(Expense, sellerId, item.id, item._id);

        if (!existing && item.id) {
          existing = await Expense.findOne({ sellerId, localId: item.id });
        }

        if (existing) {
          existing.amount = item.amount;
          existing.category = item.category;
          existing.description = item.description;
          existing.date = item.date;
          await existing.save();
          results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
        } else {
          const expense = new Expense({
            sellerId,
            amount: item.amount,
            category: item.category,
            description: item.description,
            date: item.date || new Date(),
            localId: item.id
          });
          const saved = await expense.save();
          results.success.push({ id: item.id, _id: saved._id, action: 'created' });
        }
      } catch (error) {
        console.error('Error syncing expense:', error);
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    // Update sync tracking if there were successful syncs or deletions
    if (results.success.length > 0 || deletionCount > 0) {
      try {
        const count = await Expense.countDocuments({ sellerId });
        await SyncTracking.updateLatestTime(sellerId, 'expenses', count);
      } catch (trackingError) {
        console.error('Error updating sync tracking for expenses:', trackingError);
      }
    }

    res.json({
      success: true,
      results,
      summary: {
        total: items.length,
        successful: results.success.length,
        failed: results.failed.length
      }
    });

  } catch (error) {
    console.error('Sync expenses error:', error);
    res.status(500).json({ success: false, message: 'Error syncing expenses', error: error.message });
  }
};

/**
 * Sync Customer Transactions
 */
const syncCustomerTransactions = async (req, res) => {
  try {
    const { items } = req.body;
    const sellerId = req.sellerId;
    const results = { success: [], failed: [] };
    let deletionCount = 0;

    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'Items must be an array' });
    }

    for (const item of items) {
      try {
        // Handle deletion
        if (item.isDeleted === true) {
          const existing = await resolveEntity(CustomerTransaction, sellerId, item.id, item._id);
          if (existing) {
            await CustomerTransaction.findByIdAndDelete(existing._id);
            results.success.push({ id: item.id, _id: existing._id, action: 'deleted' });
            deletionCount++;
          } else {
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue;
        }

        let existing = await resolveEntity(CustomerTransaction, sellerId, item.id, item._id);

        // Resolve Customer
        let customerId = item.customerId;
        let customerLocalId = item.customerLocalId || item.customerId;
        let customerMongoId = item.customerMongoId;

        if (mongoose.isValidObjectId(item.customerId)) {
          customerMongoId = item.customerId;
        }

        const customer = await resolveEntity(Customer, sellerId, customerLocalId, customerMongoId);
        if (customer) {
          customerId = customer._id;
          customerLocalId = customer.localId;
          customerMongoId = customer._id;
        }

        if (!customerId && !customerLocalId && !customerMongoId && !customer) {
          results.failed.push({ id: item.id, error: `Customer not found for transaction` });
          continue;
        }

        // Resolve Order
        let orderId = null;
        let orderLocalId = item.orderId || item.orderLocalId;
        let orderMongoId = item.orderMongoId || (mongoose.isValidObjectId(item.orderId) ? item.orderId : null);

        const order = await resolveEntity(Order, sellerId, orderLocalId, orderMongoId);
        if (order) {
          orderId = order._id;
          orderLocalId = order.localId;
          orderMongoId = order._id;
        }

        const transactionData = {
          sellerId,
          customerId: customerId,
          customerLocalId,
          customerMongoId,
          type: item.type,
          amount: item.amount,
          date: item.date || new Date(),
          description: item.description || '',
          orderId: orderId,
          orderLocalId: orderLocalId,
          orderMongoId: orderMongoId,
          previousBalance: item.previousBalance || 0,
          currentBalance: item.currentBalance || 0,
          localId: item.id
        };

        if (existing) {
          Object.assign(existing, transactionData);
          await existing.save();
          results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
        } else {
          const newTx = new CustomerTransaction(transactionData);
          const saved = await newTx.save();
          results.success.push({ id: item.id, _id: saved._id, action: 'created' });
        }

      } catch (error) {
        console.error('Error syncing customer transaction:', error);
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    if (results.success.length > 0 || deletionCount > 0) {
      const count = await CustomerTransaction.countDocuments({ sellerId });
      await SyncTracking.updateLatestTime(sellerId, 'customerTransactions', count);
    }

    res.json({ success: true, results, summary: { total: items.length, successful: results.success.length, failed: results.failed.length } });
  } catch (error) {
    console.error('Sync customer transactions error:', error);
    res.status(500).json({ success: false, message: 'Error syncing customer transactions', error: error.message });
  }
};

// ... (previous code)

/**
 * Sync Settings (Singleton per seller)
 */
const syncSettings = async (req, res) => {
  try {
    const { items } = req.body;
    const sellerId = req.sellerId;
    const results = { success: [], failed: [] };

    if (!Array.isArray(items)) {
      return res.status(400).json({
        success: false,
        message: 'Items must be an array'
      });
    }

    for (const item of items) {
      try {
        // Settings are singleton - we always upsert based on sellerId
        // We ignore item.id regarding creation, but return it for frontend mapping

        let settings = await SellerSettings.findOne({ sellerId });

        if (!settings) {
          settings = new SellerSettings({ sellerId });
        }

        // Update fields if provided in the payload
        if (item.billSettings) settings.billSettings = { ...settings.billSettings, ...item.billSettings };
        if (item.reportSettings) settings.reportSettings = { ...settings.reportSettings, ...item.reportSettings };
        if (item.emailSettings) settings.emailSettings = { ...settings.emailSettings, ...item.emailSettings };

        // Ensure standard fields are preserved if not provided in partial update
        // (Mongoose might overwrite with empty object if we are not careful, but spread above handles it)

        const saved = await settings.save();

        results.success.push({
          id: item.id,
          _id: saved._id,
          action: 'updated',
          // Return the full updated object if useful, but sync protocol usually just needs id mapping
        });

      } catch (error) {
        console.error('Error syncing settings for item:', error);
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    // Update sync tracking (always 1 for settings as it's singleton)
    if (results.success.length > 0) {
      try {
        await SyncTracking.updateLatestTime(sellerId, 'settings', 1);
      } catch (trackingError) {
        console.error('Error updating sync tracking for settings:', trackingError);
      }
    }

    res.json({
      success: true,
      results,
      summary: {
        total: items.length,
        successful: results.success.length,
        failed: results.failed.length
      }
    });

  } catch (error) {
    console.error('Sync settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Error syncing settings',
      error: error.message
    });
  }
};

/**
 * Sync Suppliers
 */
/**
 * Sync Suppliers
 */
const syncSuppliers = async (req, res) => {
  try {
    const { items } = req.body;
    const sellerId = req.sellerId;
    const results = { success: [], failed: [] };
    let deletionCount = 0;

    if (!Array.isArray(items)) {
      return res.status(400).json({
        success: false,
        message: 'Items must be an array'
      });
    }

    if (items.length > 0) {
      const firstItem = items[0];
      if (firstItem.type && firstItem.supplierId && firstItem.amount !== undefined) {
        return syncSupplierTransactions(req, res);
      }
    }

    const sortedItems = [...items].sort((a, b) => {
      const isATransaction = (a.type && a.supplierId && a.amount !== undefined);
      const isBTransaction = (b.type && b.supplierId && b.amount !== undefined);
      if (isATransaction && !isBTransaction) return 1;
      if (!isATransaction && isBTransaction) return -1;
      return 0;
    });

    for (const item of sortedItems) {
      try {
        const isTransaction = (item.type && item.supplierId && item.amount !== undefined);

        if (isTransaction) {
          // --- Process Supplier Transaction ---
          // Delegate to loop logic as per existing flow
          if (item.isDeleted === true) {
            const existing = await resolveEntity(SupplierTransaction, sellerId, item.id, item._id);
            if (existing) {
              await SupplierTransaction.findByIdAndDelete(existing._id);
              results.success.push({ id: item.id, _id: existing._id, action: 'deleted', type: 'supplierTransaction' });
              deletionCount++;
            } else {
              results.success.push({ id: item.id, _id: item._id || null, action: 'deleted', type: 'supplierTransaction' });
            }
            continue;
          }

          let existingTx = await resolveEntity(SupplierTransaction, sellerId, item.id, item._id);

          // Resolve Supplier
          let resolvedSupplierId = null;
          let supplierLocalId = item.supplierId || item.supplierLocalId;
          let supplierMongoId = item.supplierMongoId || (mongoose.isValidObjectId(item.supplierId) ? item.supplierId : null);

          // Attempt resolution via resolveEntity
          const supplier = await resolveEntity(Supplier, sellerId, supplierLocalId, supplierMongoId);
          if (supplier) {
            resolvedSupplierId = supplier._id;
          } else {
            // Fallback for cases where ID might be provided but not resolved (unlikely if resolveEntity works well)
            if (item.supplierId && !mongoose.isValidObjectId(item.supplierId)) {
              // Try looking up by localId explicitly if resolveEntity failed (it essentially does this anyway)
              const supplierByLocal = await Supplier.findOne({ sellerId, localId: item.supplierId });
              if (supplierByLocal) resolvedSupplierId = supplierByLocal._id;
            }
          }

          if (!resolvedSupplierId) {
            results.failed.push({ id: item.id, error: `Supplier not found for transaction` });
            continue;
          }

          // Resolve Order (Vendor Order)
          let resolvedOrderId = null;
          let orderLocalId = item.orderId || item.orderLocalId;
          let orderMongoId = item.orderMongoId || (mongoose.isValidObjectId(item.orderId) ? item.orderId : null);

          const order = await resolveEntity(VendorOrder, sellerId, orderLocalId, orderMongoId);
          if (order) {
            resolvedOrderId = order._id;
          }

          const transactionData = {
            sellerId,
            supplierId: resolvedSupplierId,
            type: item.type,
            amount: item.amount,
            date: item.date || new Date(),
            description: item.description || '',
            previousBalance: item.previousBalance || 0,
            currentBalance: item.currentBalance || 0,
            orderId: resolvedOrderId,
            localId: item.id
          };

          if (existingTx) {
            Object.assign(existingTx, transactionData);
            await existingTx.save();
            results.success.push({ id: item.id, _id: existingTx._id, action: 'updated', type: 'supplierTransaction' });
          } else {
            const newTx = new SupplierTransaction(transactionData);
            const saved = await newTx.save();
            results.success.push({ id: item.id, _id: saved._id, action: 'created', type: 'supplierTransaction' });
          }

        } else {
          // --- Process Supplier ---
          if (item.isDeleted === true) {
            const existing = await resolveEntity(Supplier, sellerId, item.id, item._id);

            if (existing) {
              await Supplier.findByIdAndDelete(existing._id);
              results.success.push({ id: item.id, _id: existing._id, action: 'deleted', type: 'supplier' });
              deletionCount++;
            } else {
              results.success.push({ id: item.id, _id: item._id || null, action: 'deleted', type: 'supplier' });
            }
            continue;
          }

          let existingSup = await resolveEntity(Supplier, sellerId, item.id, item._id);

          if (!existingSup && item.id) {
            existingSup = await Supplier.findOne({ sellerId, localId: item.id });
          }

          if (existingSup) {
            existingSup.name = item.name.trim();
            existingSup.dueAmount = item.dueAmount !== undefined ? item.dueAmount : existingSup.dueAmount;
            existingSup.mobileNumber = item.mobileNumber || item.phone || existingSup.mobileNumber;
            existingSup.email = item.email !== undefined ? item.email : existingSup.email;
            existingSup.address = item.address !== undefined ? item.address : existingSup.address;
            existingSup.gstNumber = item.gstNumber !== undefined ? item.gstNumber : existingSup.gstNumber;
            existingSup.isDeleted = false;
            // Ensure localId is set if missing
            if (!existingSup.localId && item.id) existingSup.localId = item.id;

            await existingSup.save();
            results.success.push({ id: item.id, _id: existingSup._id, action: 'updated', type: 'supplier' });

            // Recalculate balance to ensure consistency
            await recalculateSupplierBalance(existingSup._id, sellerId);
          } else {
            const supplier = new Supplier({
              sellerId,
              name: item.name,
              dueAmount: item.dueAmount || 0,
              mobileNumber: item.mobileNumber || item.phone || '',
              email: item.email,
              address: item.address,
              gstNumber: item.gstNumber,
              localId: item.id
            });
            const saved = await supplier.save();
            results.success.push({ id: item.id, _id: saved._id, action: 'created', type: 'supplier' });

            // Recalculate balance to ensure consistency
            await recalculateSupplierBalance(saved._id, sellerId);
          }
        }
      } catch (error) {
        console.error('Error syncing supplier/transaction:', error);
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    if (results.success.length > 0 || deletionCount > 0) {
      try {
        const [supplierCount, txCount] = await Promise.all([
          Supplier.countDocuments({ sellerId }),
          SupplierTransaction.countDocuments({ sellerId })
        ]);

        await Promise.all([
          SyncTracking.updateLatestTime(sellerId, 'suppliers', supplierCount),
          SyncTracking.updateLatestTime(sellerId, 'supplierTransactions', txCount)
        ]);
      } catch (trackingError) {
        console.error('Error updating sync tracking in syncSuppliers:', trackingError);
      }
    }

    res.json({
      success: true,
      results,
      summary: {
        total: items.length,
        successful: results.success.length,
        failed: results.failed.length
      }
    });
  } catch (error) {
    console.error('Sync suppliers error:', error);
    res.status(500).json({
      success: false,
      message: 'Error syncing suppliers',
      error: error.message
    });
  }
};

/**
 * Sync Supplier Transactions
 */
/**
 * Sync Supplier Transactions
 */
const syncSupplierTransactions = async (req, res) => {
  try {
    const { items } = req.body;
    const sellerId = req.sellerId;
    const results = { success: [], failed: [] };
    let deletionCount = 0;
    const affectedSupplierIds = new Set(); // Track affected suppliers

    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'Items must be an array' });
    }

    for (const item of items) {
      try {
        if (item.isDeleted === true) {
          const existing = await resolveEntity(SupplierTransaction, sellerId, item.id, item._id);

          if (existing) {
            const tempSupplierId = existing.supplierId;
            await SupplierTransaction.findByIdAndDelete(existing._id);
            results.success.push({ id: item.id, _id: existing._id, action: 'deleted' });
            deletionCount++;
            if (tempSupplierId) affectedSupplierIds.add(tempSupplierId.toString());
          } else {
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue;
        }

        let existing = await resolveEntity(SupplierTransaction, sellerId, item.id, item._id);

        if (!existing && item.id) {
          existing = await SupplierTransaction.findOne({ sellerId, localId: item.id });
        }

        // Resolve Supplier
        let supplierId = null;
        let supplierLocalId = item.supplierId || item.supplierLocalId;
        let supplierMongoId = item.supplierMongoId || (mongoose.isValidObjectId(item.supplierId) ? item.supplierId : null);

        const supplier = await resolveEntity(Supplier, sellerId, supplierLocalId, supplierMongoId);
        if (supplier) {
          supplierId = supplier._id;
        } else {
          // Fallback
          if (item.supplierId && !mongoose.isValidObjectId(item.supplierId)) {
            const sup = await Supplier.findOne({ sellerId, localId: item.supplierId });
            if (sup) supplierId = sup._id;
          }
        }

        if (!supplierId) {
          // Ensure we don't crash but fail gracefully
          results.failed.push({ id: item.id, error: `Supplier not found for transaction` });
          continue;
        }

        // Resolve Order (Vendor Order)
        let orderId = null;
        let orderLocalId = item.orderId || item.orderLocalId;
        let orderMongoId = item.orderMongoId || (mongoose.isValidObjectId(item.orderId) ? item.orderId : null);

        const order = await resolveEntity(VendorOrder, sellerId, orderLocalId, orderMongoId);
        if (order) {
          orderId = order._id;
        }

        const transactionData = {
          sellerId,
          supplierId,
          type: item.type,
          amount: item.amount,
          date: item.date || new Date(),
          description: item.description || '',
          previousBalance: item.previousBalance || 0,
          currentBalance: item.currentBalance || 0,
          orderId: orderId,
          localId: item.id
        };

        if (existing) {
          Object.assign(existing, transactionData);
          await existing.save();
          results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
        } else {
          const newTx = new SupplierTransaction(transactionData);
          const saved = await newTx.save();
          results.success.push({ id: item.id, _id: saved._id, action: 'created' });
        }

        if (supplierId) affectedSupplierIds.add(supplierId.toString());

      } catch (error) {
        console.error('Error syncing supplier transaction:', error);
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    // Recalculate balances for all affected suppliers
    if (affectedSupplierIds.size > 0) {
      // console.log(`[Sync] Recalculating balances for ${affectedSupplierIds.size} suppliers`);
      for (const supId of affectedSupplierIds) {
        await recalculateSupplierBalance(supId, sellerId);
      }
    }

    // Update sync tracking
    if (results.success.length > 0 || deletionCount > 0) {
      try {
        const count = await SupplierTransaction.countDocuments({ sellerId });
        await SyncTracking.updateLatestTime(sellerId, 'supplierTransactions', count);
      } catch (trackingError) {
        console.error('Error updating sync tracking for supplier transactions:', trackingError);
      }
    }

    res.json({
      success: true,
      results,
      summary: {
        total: items.length,
        successful: results.success.length,
        failed: results.failed.length
      }
    });
  } catch (error) {
    console.error('Sync supplier transactions error:', error);
    res.status(500).json({ success: false, message: 'Error syncing supplier transactions', error: error.message });
  }
};



/**
 * Sync D-Products
 */
const syncDProducts = async (req, res) => {
  try {
    const { items } = req.body;
    const sellerId = req.sellerId;
    const results = { success: [], failed: [] };
    let deletionCount = 0;

    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'Items must be an array' });
    }

    for (const item of items) {
      try {
        // Handle deletion
        if (item.isDeleted === true) {
          const existing = await resolveEntity(DProduct, sellerId, item.id, item._id);
          if (existing) {
            await DProduct.findByIdAndDelete(existing._id);
            results.success.push({ id: item.id, _id: existing._id, action: 'deleted' });
            deletionCount++;
          } else {
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue;
        }

        // Find Existing D-Product
        let existing = await resolveEntity(DProduct, sellerId, item.id, item._id);

        // Fallback: match by pCode
        if (!existing) {
          existing = await DProduct.findOne({
            sellerId,
            pCode: item.pCode
          });
        }

        const dProductData = {
          pCode: item.pCode,
          productName: item.productName,
          unit: item.unit || 'pcs',
          taxPercentage: item.taxPercentage || 0,
          isActive: item.isActive !== undefined ? item.isActive : true,
          localId: item.id
        };

        if (existing) {
          Object.assign(existing, dProductData);
          await existing.save();
          results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
        } else {
          const newDProduct = new DProduct({
            ...dProductData,
            sellerId
          });
          await newDProduct.save();
          results.success.push({ id: item.id, _id: newDProduct._id, action: 'created' });
        }
      } catch (error) {
        console.error('Error syncing D-Product:', error);
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    // Update sync tracking
    if (results.success.length > 0 || deletionCount > 0) {
      try {
        const count = await DProduct.countDocuments({ sellerId });
        await SyncTracking.updateLatestTime(sellerId, 'dProducts', count);
      } catch (trackingError) {
        console.error('Error updating sync tracking for D-Products:', trackingError);
      }
    }

    res.json({
      success: true,
      results,
      summary: {
        total: items.length,
        successful: results.success.length,
        failed: results.failed.length
      }
    });
  } catch (error) {
    console.error('Sync D-Products error:', error);
    res.status(500).json({ success: false, message: 'Error syncing D-Products', error: error.message });
  }
};



/**
 * Sync Targets
 */
const syncTargets = async (req, res) => {
  try {
    const { items } = req.body;
    const sellerId = req.sellerId;
    const results = { success: [], failed: [] };
    let deletionCount = 0;

    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'Items must be an array' });
    }

    for (const item of items) {
      try {
        if (item.isDeleted === true) {
          const existing = await resolveEntity(Target, sellerId, item.id, item._id);
          if (existing) {
            await Target.findByIdAndDelete(existing._id);
            results.success.push({ id: item.id, _id: existing._id, action: 'deleted' });
            deletionCount++;
          } else {
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue;
        }

        let existing = await resolveEntity(Target, sellerId, item.id, item._id);

        // Match by Date (only one target per day per seller)
        if (!existing && item.date) {
          const startOfDay = new Date(item.date); startOfDay.setHours(0, 0, 0, 0);
          const endOfDay = new Date(item.date); endOfDay.setHours(23, 59, 59, 999);
          existing = await Target.findOne({
            sellerId,
            date: { $gte: startOfDay, $lte: endOfDay }
          });
        }

        const targetData = {
          sellerId,
          targetAmount: item.targetAmount,
          date: item.date,
          localId: item.id,
          isDeleted: false,
          updatedAt: item.updatedAt || new Date()
        };

        if (existing) {
          Object.assign(existing, targetData);
          await existing.save();
          results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
        } else {
          const newTarget = new Target(targetData);
          const saved = await newTarget.save();
          results.success.push({ id: item.id, _id: saved._id, action: 'created' });
        }
      } catch (error) {
        console.error('Error syncing target:', error);
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    if (results.success.length > 0 || deletionCount > 0) {
      const count = await Target.countDocuments({ sellerId });
      await SyncTracking.updateLatestTime(sellerId, 'targets', count);
    }

    res.json({
      success: true,
      results,
      summary: { total: items.length, successful: results.success.length, failed: results.failed.length }
    });
  } catch (error) {
    console.error('Sync targets error:', error);
    res.status(500).json({ success: false, message: 'Error syncing targets', error: error.message });
  }
};

module.exports = {
  syncCustomers,
  syncProducts,
  syncProductBatches,
  syncOrders,
  syncTransactions,
  syncVendorOrders,
  syncCategories,
  syncRefunds,
  syncExpenses,
  syncCustomerTransactions,
  syncSuppliers,
  syncSupplierTransactions,
  getSyncStatus,
  syncSettings,
  syncDProducts,
  syncTargets
};
