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
const SellerSettings = require('../models/SellerSettings');
const { checkAndSendInventoryAlerts } = require('../utils/inventoryAlerts');

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
        console.warn(`Product ${item.productId} not found for seller ${sellerId}`);
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
      return res.status(400).json({
        success: false,
        message: 'Items must be an array'
      });
    }

    // Check if these are Customer Transactions (which have customerId, type, amount) and NOT Customers (which have name)
    // Customers might have 'id' and 'name'. Transactions have 'customerId', 'type'.
    // We check the first item to determine the batch type (assuming syncService sends homogeneous batches)
    if (items.length > 0) {
      const firstItem = items[0];
      // If it has 'type' AND 'customerId' AND 'amount' - likely a transaction
      // Customers DO NOT have 'type' or 'customerId' (they have 'id', 'name')
      if (firstItem.type && firstItem.customerId && firstItem.amount !== undefined) {
        // Delegate to syncCustomerTransactions logic
        return syncCustomerTransactions(req, res);
      }
    }

    // Sort items: CustomerTransactions first, then Customers
    // This ensures that when a payment is synced, the transaction record is created 
    // before/around the time the customer balance is updated.
    const sortedItems = [...items].sort((a, b) => {
      const isATransaction = (a.type && a.customerId && a.amount !== undefined);
      const isBTransaction = (b.type && b.customerId && b.amount !== undefined);
      if (isATransaction && !isBTransaction) return -1;
      if (!isATransaction && isBTransaction) return 1;
      return 0;
    });

    for (const item of sortedItems) {
      try {
        const isTransaction = (item.type && item.customerId && item.amount !== undefined);

        if (isTransaction) {
          // --- Process Customer Transaction ---
          if (item.isDeleted === true) {
            let existing = (item._id && mongoose.Types.ObjectId.isValid(item._id)) ? await CustomerTransaction.findById(item._id) : null;
            if (!existing && item.id) {
              existing = await CustomerTransaction.findOne({ sellerId, localId: item.id });
            }

            if (existing && existing.sellerId.toString() === sellerId.toString()) {
              await CustomerTransaction.findByIdAndDelete(existing._id);
              results.success.push({ id: item.id, _id: existing._id, action: 'deleted', type: 'customerTransaction' });
              deletionCount++;
            } else {
              results.success.push({ id: item.id, _id: item._id || null, action: 'deleted', type: 'customerTransaction' });
            }
            continue;
          }

          let existingTx = null;
          if (item._id && mongoose.Types.ObjectId.isValid(item._id)) {
            existingTx = await CustomerTransaction.findById(item._id);
            if (existingTx && existingTx.sellerId.toString() !== sellerId.toString()) existingTx = null;
          }
          if (!existingTx && item.id) {
            existingTx = await CustomerTransaction.findOne({ sellerId, localId: item.id });
          }

          // Resolve customerId
          let resolvedCustomerId = item.customerId;
          if (item.customerId && !mongoose.Types.ObjectId.isValid(item.customerId)) {
            const customer = await Customer.findOne({ sellerId, localId: item.customerId });
            if (customer) {
              resolvedCustomerId = customer._id;
            } else {
              // Customer not found warning suppressed
              results.failed.push({ id: item.id, error: `Customer not found for ID: ${item.customerId}` });
              continue;
            }
          }

          // Resolve Order ID (Optional)
          let resolvedOrderId = item.orderId;
          if (item.orderId && !mongoose.Types.ObjectId.isValid(item.orderId)) {
            const order = await Order.findOne({ sellerId, localId: item.orderId });
            resolvedOrderId = order ? order._id : null;
          }

          const transactionData = {
            sellerId,
            customerId: resolvedCustomerId,
            type: item.type,
            amount: item.amount,
            date: item.date || new Date(),
            description: item.description || '',
            orderId: resolvedOrderId,
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
            let existing = null;
            if (item._id && mongoose.Types.ObjectId.isValid(item._id)) {
              existing = await Customer.findById(item._id);
            }
            if (!existing && item.id) {
              existing = await Customer.findOne({ sellerId, localId: item.id });
            }

            if (existing && existing.sellerId.toString() === sellerId.toString()) {
              await Customer.findByIdAndDelete(existing._id);
              results.success.push({ id: item.id, _id: existing._id, action: 'deleted', type: 'customer' });
              deletionCount++;
              await adjustPlanUsage(sellerId, 'customers', -1);
            } else {
              results.success.push({ id: item.id, _id: item._id || null, action: 'deleted', type: 'customer' });
            }
            continue;
          }

          let existingCust = null;
          if (item._id && mongoose.Types.ObjectId.isValid(item._id)) {
            existingCust = await Customer.findById(item._id);
            if (existingCust && existingCust.sellerId.toString() !== sellerId.toString()) {
              existingCust = null;
            }
          }

          if (!existingCust && item.id) {
            existingCust = await Customer.findOne({ sellerId, localId: item.id });
          }

          /* 
          // Logic disabled to allow multiple customers with same mobile number as per user request
          if (!existingCust) {
            const mobileNumber = item.mobileNumber || item.phone;
            if (mobileNumber) {
              existingCust = await Customer.findOne({ sellerId, name: item.name.trim(), mobileNumber: mobileNumber.trim() });
            }
          }
          */

          if (existingCust) {
            existingCust.name = item.name.trim();
            existingCust.dueAmount = item.dueAmount !== undefined ? item.dueAmount : existingCust.dueAmount;
            existingCust.mobileNumber = item.mobileNumber || item.phone || existingCust.mobileNumber;
            existingCust.email = item.email !== undefined ? item.email : existingCust.email;
            existingCust.address = item.address !== undefined ? item.address : existingCust.address;
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
        console.error(`Error syncing customer/transaction ${item.id}:`, error);
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    // Update sync tracking if there were successful syncs or deletions
    if (results.success.length > 0 || deletionCount > 0) {
      try {
        // Update both counts as this endpoint now handles both simultaneously
        const [customerCount, txCount] = await Promise.all([
          Customer.countDocuments({ sellerId }),
          CustomerTransaction.countDocuments({ sellerId })
        ]);

        await Promise.all([
          SyncTracking.updateLatestTime(sellerId, 'customers', customerCount),
          SyncTracking.updateLatestTime(sellerId, 'customerTransactions', txCount)
        ]);
      } catch (trackingError) {
        console.error('Error updating sync tracking in syncCustomers:', trackingError);
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
    console.error('Sync customers error:', error);
    res.status(500).json({
      success: false,
      message: 'Error syncing customers',
      error: error.message
    });
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
          let existing = (item._id && mongoose.Types.ObjectId.isValid(item._id)) ? await ProductCategory.findById(item._id) : null;
          if (!existing && item.id) {
            existing = await ProductCategory.findOne({ sellerId, localId: item.id });
          }

          if (existing && existing.sellerId.toString() === sellerId.toString()) {
            // Delete from MongoDB
            await ProductCategory.findByIdAndUpdate(item._id, {
              isDeleted: true,
              updatedAt: new Date()
            });
            //(`Deleted category ${item._id} from MongoDB`);
            results.success.push({ id: item.id, _id: item._id, action: 'deleted' });
            deletionCount++;
          } else {
            // Item doesn't exist in backend, or _id doesn't match - treat as success
            //(`Category ${item.id} not found in MongoDB, treating deletion as success`);
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue; // Skip to next item
        }

        // Normal sync (create or update)
        // Check for duplicate by localId or name
        let existing = null;
        if (item.id) {
          existing = await ProductCategory.findOne({ sellerId, localId: item.id });
        }

        if (!existing) {
          existing = await findExistingDocument(
            ProductCategory,
            sellerId,
            { name: item.name }
          );
        }

        if (existing) {
          results.success.push({ id: item.id, _id: existing._id, action: 'exists' });
        } else {
          // Create new category
          const category = new ProductCategory({
            sellerId,
            name: item.name,
            description: item.description,
            image: item.image,
            isActive: item.isActive !== undefined ? item.isActive : true,
            localId: item.id
          });
          const saved = await category.save();
          results.success.push({ id: item.id, _id: saved._id, action: 'created' });
        }
      } catch (error) {
        console.error(`Error syncing category ${item.id}:`, error);
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
        // Handle deletion: if item has isDeleted: true, delete it from MongoDB
        if (item.isDeleted === true) {
          let existing = (item._id && mongoose.Types.ObjectId.isValid(item._id)) ? await Product.findById(item._id) : null;
          if (!existing && item.id) {
            existing = await Product.findOne({ sellerId, localId: item.id });
          }

          if (existing && existing.sellerId.toString() === sellerId.toString()) {
            // Hard delete from MongoDB - completely remove the document
            await Product.findByIdAndDelete(existing._id);
            //(`Permanently deleted product ${existing._id} (${existing.name}) from MongoDB`);
            results.success.push({ id: item.id, _id: existing._id, action: 'deleted' });
            deletionCount++;
            const usageResult = await adjustPlanUsage(sellerId, 'products', -1);
            if (!usageResult.success) {
              // usageResult.message warning suppressed
            }
          } else {
            // Item doesn't exist in backend, or _id doesn't match - treat as success
            //(`Product ${item.id} not found in MongoDB, treating deletion as success`);
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue; // Skip to next item
        }

        // Normal sync (create or update)
        // Handle category first - create or find existing category
        let categoryId = null;
        if (item.category) {
          // Normalize category name (trim and lowercase for matching)
          const categoryName = item.category.trim().toLowerCase();

          // Find existing category by name (case-insensitive)
          let category = await ProductCategory.findOne({
            sellerId,
            $or: [
              { name: { $regex: new RegExp(`^${categoryName}$`, 'i') } },
              { name: categoryName }
            ]
          });

          if (!category) {
            // Create category if it doesn't exist
            category = new ProductCategory({
              sellerId,
              name: categoryName,
              isActive: item.categoryIsActive !== undefined ? item.categoryIsActive : true,
              description: item.categoryDescription || ''
            });
            await category.save();
          }
          categoryId = category._id;
        } else if (item.categoryId) {
          // If categoryId is provided, check if it's a valid ObjectId
          if (mongoose.Types.ObjectId.isValid(item.categoryId)) {
            // Valid ObjectId - verify the category exists
            const category = await ProductCategory.findOne({
              _id: item.categoryId,
              sellerId
            });
            if (category) {
              categoryId = category._id;
            } else {
              console.warn(`Category with ObjectId ${item.categoryId} not found for seller ${sellerId}`);
            }
          } else {
            // Invalid ObjectId - could be a localId (from offline creation) or a name
            // First, try to find by localId
            let category = await ProductCategory.findOne({
              sellerId,
              localId: item.categoryId
            });

            if (category) {
              categoryId = category._id;
            } else {
              // Fallback: treat as category name (legacy behavior or manual input)
              const categoryName = String(item.categoryId).trim().toLowerCase();

              // Only treat as name if it doesn't look like a generated ID (optional heuristic)
              // But strictly speaking, if not found by localId, name check is the next best thing

              // Find existing category by name (case-insensitive)
              category = await ProductCategory.findOne({
                sellerId,
                $or: [
                  { name: { $regex: new RegExp(`^${categoryName}$`, 'i') } },
                  { name: categoryName }
                ]
              });

              if (!category) {
                // Determine if we should create a category from this "name"
                // If it looks like a localId (e.g. starts with 'cat-'), creating a category named 'cat-123' is probably wrong
                // But preventing data loss is priority.

                // Create category if it doesn't exist
                category = new ProductCategory({
                  sellerId,
                  name: categoryName,
                  isActive: true,
                  description: ''
                });
                await category.save();
              }
              categoryId = category._id;
            }
          }
        }

        // CRITICAL: Check for existing product by _id FIRST (for updates)
        // If _id exists and is valid, find by _id to update existing product
        let existing = null;

        if (item._id && mongoose.Types.ObjectId.isValid(item._id)) {
          existing = await Product.findById(item._id);
          // Verify sellerId matches (security check)
          if (existing && existing.sellerId.toString() !== sellerId.toString()) {
            existing = null; // Don't use if sellerId doesn't match
          }
        }

        // If not found by _id, check for duplicate by localId (if provided)
        if (!existing && item.id) {
          existing = await Product.findOne({ sellerId, localId: item.id });
        }

        // If not found by localId, check for duplicate by name + description (for new products)
        if (!existing) {
          const productName = item.name.trim();
          const productDescription = (item.description || '').trim();

          // If description is provided, match by name + exact description
          if (productDescription) {
            existing = await Product.findOne({
              sellerId,
              name: productName,
              description: productDescription
            });
          } else {
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
        }

        if (existing) {
          // Update existing product - MongoDB uses 'stock' and 'costPrice'
          // Frontend may send 'quantity' or 'stock', 'costPrice' or 'unitPrice'
          // CRITICAL: Update ALL fields, including name (product name can change)
          existing.name = item.name || existing.name;
          existing.unit = item.unit || item.quantityUnit || existing.unit;
          existing.costPrice = item.costPrice !== undefined ? item.costPrice : (item.unitPrice !== undefined ? item.unitPrice : existing.costPrice);
          existing.sellingUnitPrice = item.sellingUnitPrice !== undefined ? item.sellingUnitPrice : (item.sellingPrice !== undefined ? item.sellingPrice : existing.sellingUnitPrice);
          existing.mfg = item.mfg || item.mfgDate ? new Date(item.mfg || item.mfgDate) : existing.mfg;
          existing.expiryDate = item.expiryDate ? new Date(item.expiryDate) : existing.expiryDate;
          existing.trackExpiry = item.trackExpiry !== undefined ? item.trackExpiry : existing.trackExpiry;
          existing.description = item.description !== undefined ? item.description : existing.description;
          existing.categoryId = categoryId || existing.categoryId;
          existing.barcode = item.barcode !== undefined ? item.barcode : existing.barcode;
          existing.lowStockLevel = item.lowStockLevel !== undefined ? item.lowStockLevel : existing.lowStockLevel;
          existing.isActive = item.isActive !== undefined ? item.isActive : existing.isActive;
          existing.wholesalePrice = item.wholesalePrice !== undefined ? item.wholesalePrice : existing.wholesalePrice;
          existing.wholesaleMOQ = item.wholesaleMOQ !== undefined ? item.wholesaleMOQ : existing.wholesaleMOQ;
          existing.hsnCode = item.hsnCode !== undefined ? item.hsnCode : existing.hsnCode;
          existing.gstPercent = item.gstPercent !== undefined ? item.gstPercent : existing.gstPercent;
          existing.isGstInclusive = item.isGstInclusive !== undefined ? item.isGstInclusive : existing.isGstInclusive;
          // Store/update the localId for product batch mapping
          existing.localId = item.id || existing.localId;
          await existing.save();
          // Updated product in MongoDB
          results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
        } else {
          // Create new product - MongoDB uses 'stock' and 'costPrice'
          // Frontend may send 'quantity' or 'stock', 'costPrice' or 'unitPrice'
          const product = new Product({
            sellerId,
            name: item.name,
            barcode: item.barcode || '',
            categoryId,
            unit: item.unit || 'pcs',
            lowStockLevel: item.lowStockLevel || 10,
            trackExpiry: item.trackExpiry || false,
            description: item.description || '',
            isActive: item.isActive !== undefined ? item.isActive : false,
            wholesalePrice: item.wholesalePrice || 0,
            wholesaleMOQ: item.wholesaleMOQ || 1,
            hsnCode: item.hsnCode || '',
            gstPercent: item.gstPercent || 0,
            isGstInclusive: item.isGstInclusive !== undefined ? item.isGstInclusive : true,
            localId: item.id // Store the original frontend-generated ID for mapping
          });
          const saved = await product.save();
          const usageResult = await adjustPlanUsage(sellerId, 'products', 1);
          if (!usageResult.success) {
            await Product.findByIdAndUpdate(saved._id, {
              isDeleted: true,
              updatedAt: new Date()
            });
            results.failed.push({ id: item.id, error: usageResult.message || 'Plan limit reached', action: 'limit-exceeded' });
            continue;
          }
          results.success.push({ id: item.id, _id: saved._id, action: 'created' });
        }
      } catch (error) {
        console.error(`Error syncing product ${item.id}:`, error);
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    // Update sync tracking if there were successful syncs or deletions
    if (results.success.length > 0 || deletionCount > 0) {
      try {
        // Get actual count of products for this seller (hard deletes, so no filter needed)
        const productCount = await Product.countDocuments({ sellerId });
        await SyncTracking.updateLatestTime(sellerId, 'products', productCount);
        //(`📊 Updated sync tracking for products: ${productCount} remaining (deleted ${deletionCount})`);
      } catch (trackingError) {
        console.error('Error updating sync tracking for products:', trackingError);
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

    // Trigger inventory alerts check (deffered to next tick)
    setImmediate(() => {
      checkAndSendInventoryAlerts(sellerId)
        .catch(err => console.error('Error in inventory alerts check after syncProducts:', err));
    });
  } catch (error) {
    console.error('Sync products error:', error);
    res.status(500).json({
      success: false,
      message: 'Error syncing products',
      error: error.message
    });
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
      return res.status(400).json({
        success: false,
        message: 'Items must be an array'
      });
    }

    for (const item of items) {
      try {
        // console.log(`[SYNC] Processing product batch:`, { id: item.id, _id: item._id, productId: item.productId });
        // Handle deletion: if item has isDeleted: true, delete it from MongoDB
        if (item.isDeleted === true) {
          let existing = (item._id && mongoose.Types.ObjectId.isValid(item._id)) ? await ProductBatch.findById(item._id) : null;
          if (!existing && item.id) {
            existing = await ProductBatch.findOne({ sellerId, localId: item.id });
          }

          if (existing && existing.sellerId.toString() === sellerId.toString()) {
            // Hard delete from MongoDB - completely remove the document
            await ProductBatch.findByIdAndDelete(existing._id);
            //(`Permanently deleted product batch ${existing._id} from MongoDB`);
            results.success.push({ id: item.id, _id: existing._id, action: 'deleted' });
            deletionCount++;
          } else {
            // Item doesn't exist in backend, or _id doesn't match - treat as success
            //(`Product batch ${item.id} not found in MongoDB, treating deletion as success`);
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue; // Skip to next item
        }

        // Normal sync (create or update)
        let existing = null;

        // First try to find by _id if provided
        if (item._id && mongoose.Types.ObjectId.isValid(item._id)) {
          existing = await ProductBatch.findById(item._id);
          if (existing && existing.sellerId.toString() !== sellerId.toString()) {
            // _id exists but belongs to different seller - treat as new item
            existing = null;
          }
        }

        // PRODUCT LOOKUP — SUPPORT BOTH _id AND localId
        // console.log(`[SYNC] Looking for product with productId: ${item.productId}`);

        let product = null;

        // 1. Try MongoDB _id
        if (mongoose.isValidObjectId(item.productId)) {
          // console.log(`[SYNC] Trying to find by _id: ${item.productId}`);
          product = await Product.findOne({
            _id: item.productId,
            sellerId
          });
          // console.log(`[SYNC] Found by _id: ${product ? 'YES' : 'NO'}`);
        }

        // 2. If not found, try localId
        if (!product) {
          // console.log(`[SYNC] Trying to find by localId: ${item.productId}`);
          product = await Product.findOne({
            localId: item.productId,
            sellerId
          });
          // console.log(`[SYNC] Found by localId: ${product ? 'YES' : 'NO'}`);
        }

        // console.log(`[SYNC] Product found: ${product ? product._id : 'null'}`);

        if (!product) {
          results.failed.push({
            id: item.id,
            error: `Product ${item.productId} not found`
          });
          continue;
        }

        // Ensure product._id is a valid ObjectId
        if (!product._id || !mongoose.isValidObjectId(product._id)) {
          // console.error(`[SYNC] Product _id is invalid: ${product._id} (type: ${typeof product._id})`);
          results.failed.push({
            id: item.id,
            error: `Product _id is invalid: ${product._id}`
          });
          continue;
        }


        // console.log(`[SYNC] Creating batch with productId: ${product._id} (type: ${typeof product._id})`);

        if (!existing && item.id) {
          existing = await ProductBatch.findOne({ sellerId, localId: item.id });
          // console.log(`[SYNC] Found existing batch by localId: ${existing ? existing._id : 'NO'}`);
        }

        // Now try to find existing batch using the actual MongoDB productId
        if (!existing) {
          existing = await findExistingDocument(ProductBatch, sellerId, {
            productId: product._id,
            batchNumber: item.batchNumber || '',
            mfg: item.mfg ? new Date(item.mfg) : undefined
          });
          // console.log(`[SYNC] Found existing batch by productId lookup: ${existing ? existing._id : 'NO'}`);
        }

        const batchData = {
          sellerId,
          productId: product._id, // Use the actual MongoDB ObjectId from the found product
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
          // Update existing batch
          // console.log(`[SYNC] Updating existing batch ${existing._id} with productId: ${batchData.productId}`);
          await ProductBatch.findByIdAndUpdate(existing._id, batchData);
          results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
        } else {
          // Create new batch
          // console.log(`[SYNC] Creating new batch with productId: ${batchData.productId}`);
          const newBatch = new ProductBatch(batchData);
          await newBatch.save();
          results.success.push({ id: item.id, _id: newBatch._id, action: 'created' });
        }
      } catch (error) {
        console.error(`Error syncing product batch ${item?.id}:`, error);
        results.failed.push({
          id: item.id,
          error: error.message
        });
      }
    }

    // Update sync tracking for product batches
    const productBatchCount = results.success.length + deletionCount;
    if (productBatchCount > 0) {
      await SyncTracking.updateLatestTime(sellerId, 'productBatches', productBatchCount);
    }

    res.json({
      success: true,
      message: `Synced ${results.success.length} product batches successfully, ${results.failed.length} failed, ${deletionCount} deleted`,
      results
    });

    // Trigger inventory alerts check (deffered to next tick)
    setImmediate(() => {
      checkAndSendInventoryAlerts(sellerId)
        .catch(err => console.error('Error in inventory alerts check after syncProductBatches:', err));
    });
  } catch (error) {
    console.error('Sync product batches error:', error);
    res.status(500).json({
      success: false,
      message: 'Error syncing product batches',
      error: error.message
    });
  }
};

/**
 * Sync Orders (sales/billing records)
 */
const syncOrders = async (req, res) => {
  try {
    const { items } = req.body;
    const sellerId = req.sellerId;

    // (`[SYNC] 📥 RECEIVED ORDER SYNC REQUEST:`, {
    //   sellerId,
    //   itemCount: items?.length,
    //   items: items?.map(item => ({
    //     id: item.id,
    //     invoiceNumber: item.invoiceNumber,
    //     totalAmount: item.totalAmount
    //   }))
    // });

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
          let existing = (item._id && mongoose.Types.ObjectId.isValid(item._id)) ? await Order.findById(item._id) : null;
          if (!existing && item.id) {
            existing = await Order.findOne({ sellerId, localId: item.id });
          }

          if (existing && existing.sellerId.toString() === sellerId.toString()) {
            // Delete from MongoDB
            await Order.findByIdAndUpdate(item._id, {
              isDeleted: true,
              updatedAt: new Date()
            });
            //(`Deleted order ${item._id} from MongoDB`);
            results.success.push({ id: item.id, _id: item._id, action: 'deleted' });
            deletionCount++;
            const usageResult = await adjustPlanUsage(sellerId, 'orders', -1);
            if (!usageResult.success) {
              // usageResult.message warning suppressed
            }
          } else {
            // Item doesn't exist in backend, or _id doesn't match - treat as success
            //(`Order ${item.id} not found in MongoDB, treating deletion as success`);
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue; // Skip to next item
        }

        // Normal sync (create or update)
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

          // Validate amounts
          const cashAmount = typeof splitDetails.cashAmount === 'number' ? splitDetails.cashAmount : 0;
          const onlineAmount = typeof splitDetails.onlineAmount === 'number' ? splitDetails.onlineAmount : 0;
          const dueAmount = typeof splitDetails.dueAmount === 'number' ? splitDetails.dueAmount : 0;

          if (cashAmount < 0 || onlineAmount < 0 || dueAmount < 0) {
            throw new Error('Split payment amounts cannot be negative');
          }

          // Auto-infer type if missing or invalid
          const validSplitTypes = ['cash_online', 'online_due', 'cash_due', 'cash_online_due'];
          if (!splitDetails.type || !validSplitTypes.includes(splitDetails.type)) {
            if (cashAmount > 0 && onlineAmount > 0 && dueAmount > 0) splitDetails.type = 'cash_online_due';
            else if (cashAmount > 0 && onlineAmount > 0) splitDetails.type = 'cash_online';
            else if (onlineAmount > 0 && dueAmount > 0) splitDetails.type = 'online_due';
            else if (cashAmount > 0 && dueAmount > 0) splitDetails.type = 'cash_due';
            else splitDetails.type = 'cash_online'; // Fallback
          }

          // Validate that amounts match the split type (amounts must be >= 0)
          if (splitDetails.type === 'cash_online' && (cashAmount < 0 || onlineAmount < 0)) {
            throw new Error('Cash + Online split requires both cash and online amounts >= 0');
          }
          if (splitDetails.type === 'online_due' && (onlineAmount < 0 || dueAmount < 0)) {
            throw new Error('Online + Due split requires both online and due amounts >= 0');
          }
          if (splitDetails.type === 'cash_due' && (cashAmount < 0 || dueAmount < 0)) {
            throw new Error('Cash + Due split requires both cash and due amounts >= 0');
          }

          // Validate that split amounts sum to totalAmount (within 0.01 tolerance)
          const splitTotal = cashAmount + onlineAmount + dueAmount;
          if (Math.abs(splitTotal - item.totalAmount) > 0.1) { // Increased tolerance slightly for floating point issues in frontend
            throw new Error(`Split payment total (${splitTotal.toFixed(2)}) must equal order total (${item.totalAmount.toFixed(2)})`);
          }

          // If only one category is actually used, we could technically normalize the paymentMethod, 
          // but we'll leave it as split to respect the client's structure, 
          // as long as the amounts sum up.
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

          // Normalize productId: convert valid ObjectId strings to ObjectId, try to resolve from localId if needed
          if (orderItem.productId) {
            if (mongoose.Types.ObjectId.isValid(orderItem.productId)) {
              // Valid ObjectId string - convert to ObjectId
              orderItem.productId = new mongoose.Types.ObjectId(orderItem.productId);
            } else {
              // Invalid ObjectId - try to resolve as localId
              const resolvedProduct = await Product.findOne({ sellerId, localId: orderItem.productId });
              if (resolvedProduct) {
                orderItem.productId = resolvedProduct._id;
              } else {
                console.warn(`Order item has invalid and unresolveable productId: ${orderItem.productId}, setting to null`);
                orderItem.productId = null;
              }
            }
          } else {
            // No productId provided - set to null
            orderItem.productId = null;
          }
        }

        // Convert customerId from frontend ID to MongoDB ObjectId
        let customerId = null;
        if (item.customerId) {
          // First try if it's already a valid MongoDB ObjectId
          if (mongoose.Types.ObjectId.isValid(item.customerId)) {
            // Check if this ObjectId exists in MongoDB
            const customerExists = await Customer.findById(item.customerId);
            if (customerExists && customerExists.sellerId.toString() === sellerId.toString()) {
              customerId = new mongoose.Types.ObjectId(item.customerId);
            } else {
              console.warn(`Customer with ID ${item.customerId} not found or doesn't belong to seller ${sellerId}`);
            }
          } else {
            // If it's a frontend ID (not MongoDB ObjectId), try to find customer by localId
            const customerByLocalId = await Customer.findOne({ sellerId, localId: item.customerId });
            if (customerByLocalId) {
              customerId = customerByLocalId._id;
              // console.log(`[SYNC] Resolved local customerId ${item.customerId} to ObjectId ${customerId}`);
            } else {
              // If not found, throw error to verify dependency (Customer might not be synced yet)
              throw new Error(`Customer ID ${item.customerId} not found (localId lookup failed). Customer sync might be pending.`);
            }
          }
        }

        // Check for duplicate by multiple criteria to prevent duplicates
        // Duplicate check: sellerId + customerId + totalAmount + items hash + createdAt (within same minute)
        let existing = null;

        // First try by _id if provided
        if (item._id && mongoose.Types.ObjectId.isValid(item._id)) {
          existing = await Order.findById(item._id);
          if (existing && existing.sellerId.toString() !== sellerId.toString()) {
            existing = null; // Don't use if sellerId doesn't match
          }
        }

        // If not found by _id, check for duplicate by content
        if (!existing && item.id) {
          existing = await Order.findOne({ sellerId, localId: item.id });
        }

        if (!existing) {
          const orderCreatedAt = item.createdAt || item.date;
          const customerId = item.customerId ? (mongoose.Types.ObjectId.isValid(item.customerId) ? new mongoose.Types.ObjectId(item.customerId) : null) : null;

          // Create hash of items for comparison
          const itemsHash = JSON.stringify((item.items || []).map(i => ({
            name: i.name,
            quantity: i.quantity,
            sellingPrice: i.sellingPrice,
            costPrice: i.costPrice
          })).sort((a, b) => (a.name || '').localeCompare(b.name || '')));

          // Find orders with same sellerId, customerId, and similar totalAmount
          const similarOrders = await Order.find({
            sellerId,
            customerId: customerId || null,
            totalAmount: { $gte: item.totalAmount - 0.01, $lte: item.totalAmount + 0.01 }
          });

          // Check if any similar order has matching items and createdAt within same minute
          for (const order of similarOrders) {
            const orderItemsHash = JSON.stringify((order.items || []).map(i => ({
              name: i.name,
              quantity: i.quantity,
              sellingPrice: i.sellingPrice,
              costPrice: i.costPrice
            })).sort((a, b) => (a.name || '').localeCompare(b.name || '')));

            if (orderItemsHash === itemsHash) {
              // Check if createdAt is within 5 seconds (to catch rapid duplicates)
              if (orderCreatedAt && order.createdAt) {
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
        }

        if (existing && existing.sellerId.toString() === sellerId.toString()) {
          const wasDueAdded = existing.dueAdded;
          // Calculate Old Due before update
          const oldDue = (existing.allPaymentClear) ? 0 :
            (existing.paymentMethod === 'due' || existing.paymentMethod === 'credit') ? existing.totalAmount :
              (existing.paymentMethod === 'split' && existing.splitPaymentDetails) ? existing.splitPaymentDetails.dueAmount : 0;

          // Update existing order
          existing.customerId = customerId || existing.customerId;
          existing.paymentMethod = paymentMethod;
          existing.items = item.items;
          existing.totalAmount = item.totalAmount;
          existing.subtotal = item.subtotal ?? existing.subtotal ?? item.totalAmount;
          existing.discountPercent = item.discountPercent ?? existing.discountPercent ?? 0;
          existing.taxPercent = item.taxPercent ?? existing.taxPercent ?? 0;
          existing.customerName = item.customerName || existing.customerName || '';
          existing.customerMobile = item.customerMobile || existing.customerMobile || '';
          if (item.allPaymentClear !== undefined) {
            existing.allPaymentClear = item.allPaymentClear;
          } else {
            // Derive allPaymentClear if missing
            existing.allPaymentClear = (paymentMethod !== 'due' && paymentMethod !== 'credit' && !(paymentMethod === 'split' && item.splitPaymentDetails?.dueAmount > 0));
          }

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

          // Update sync status flags
          existing.stockDeducted = item.stockDeducted !== undefined ? item.stockDeducted : existing.stockDeducted;
          existing.dueAdded = item.dueAdded !== undefined ? item.dueAdded : existing.dueAdded;

          await existing.save();

          // Update Customer Due Amount for updated orders
          const currentAllPaymentClear = item.allPaymentClear !== undefined ? item.allPaymentClear : (paymentMethod !== 'due' && paymentMethod !== 'credit' && !(paymentMethod === 'split' && item.splitPaymentDetails?.dueAmount > 0));
          const newDue = currentAllPaymentClear ? 0 :
            (paymentMethod === 'due' || paymentMethod === 'credit') ? item.totalAmount :
              (paymentMethod === 'split' && item.splitPaymentDetails) ? item.splitPaymentDetails.dueAmount : 0;

          const oldLedger = wasDueAdded ? oldDue : 0;
          const diff = newDue - oldLedger;

          if (diff !== 0 && existing.customerId) {
            await Customer.findByIdAndUpdate(existing.customerId, { $inc: { dueAmount: diff } });
          }
          results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
        } else {
          // Create new order
          const orderData = {
            sellerId,
            customerId: customerId,
            paymentMethod: paymentMethod,
            items: item.items,
            totalAmount: item.totalAmount,
            subtotal: item.subtotal ?? item.totalAmount,
            discountPercent: item.discountPercent ?? 0,
            taxPercent: item.taxPercent ?? 0,
            customerName: item.customerName || '',
            customerMobile: item.customerMobile || '',
            invoiceNumber: item.invoiceNumber, // Include invoice number from frontend
            allPaymentClear: item.allPaymentClear !== undefined ? item.allPaymentClear : (paymentMethod !== 'due' && paymentMethod !== 'credit' && !(paymentMethod === 'split' && item.splitPaymentDetails?.dueAmount > 0)),
            localId: item.id,
            stockDeducted: item.stockDeducted || false,
            dueAdded: item.dueAdded || false
          };

          // Add split payment details only if payment method is split and details are provided
          // Don't include splitPaymentDetails at all if it's null, undefined, or payment method is not split
          if (paymentMethod === 'split' &&
            item.splitPaymentDetails &&
            item.splitPaymentDetails !== null &&
            item.splitPaymentDetails !== undefined &&
            item.splitPaymentDetails.type !== null &&
            item.splitPaymentDetails.type !== undefined) {
            orderData.splitPaymentDetails = {
              type: item.splitPaymentDetails.type,
              cashAmount: item.splitPaymentDetails.cashAmount || 0,
              onlineAmount: item.splitPaymentDetails.onlineAmount || 0,
              dueAmount: item.splitPaymentDetails.dueAmount || 0
            };
          }
          // Explicitly ensure splitPaymentDetails is not included if conditions aren't met
          // This prevents Mongoose from trying to validate null values

          // Saving order to MongoDB

          const order = new Order(orderData);
          const saved = await order.save();

          // Order saved successfully
          const usageResult = await adjustPlanUsage(sellerId, 'orders', 1);
          if (!usageResult.success) {
            await Order.findByIdAndUpdate(saved._id, {
              isDeleted: true,
              updatedAt: new Date()
            });
            results.failed.push({ id: item.id, error: usageResult.message || 'Plan limit reached', action: 'limit-exceeded' });
            continue;
          }

          // Dedect from batches in backend (batch-based inventory system)
          // ONLY if the frontend hasn't already performed the deduction.
          // This prevents double-deduction when both an order and its updated batches are synced.
          if (item.stockDeducted) {
            // Already deducted on frontend
          } else {
            await adjustProductStockForOrder(sellerId, item.items);
          }

          // Update Customer Due Amount for new orders
          if (customerId && !item.dueAdded) {
            const dueAmount = (paymentMethod === 'due') ? saved.totalAmount :
              (paymentMethod === 'split' && saved.splitPaymentDetails?.dueAmount) ? saved.splitPaymentDetails.dueAmount : 0;

            if (dueAmount > 0) {
              await Customer.findByIdAndUpdate(customerId, { $inc: { dueAmount: dueAmount } });

            }
          } else if (item.dueAdded) {
            // Skipping customer balance update for order - already added on frontend
          }

          //(`[SYNC] 📄 Order created with invoice: ${saved.invoiceNumber}`);
          results.success.push({ id: item.id, _id: saved._id, invoiceNumber: saved.invoiceNumber, action: 'created' });
        }
      } catch (error) {
        console.error(`Error syncing order ${item.id}:`, error);
        console.error('Order data:', JSON.stringify(item, null, 2));
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    // Update sync tracking if there were successful syncs or deletions
    if (results.success.length > 0 || deletionCount > 0) {
      try {
        // Get actual count of orders for this seller (excluding soft deleted)
        const orderCount = await Order.countDocuments({ sellerId, isDeleted: { $ne: true } });
        await SyncTracking.updateLatestTime(sellerId, 'orders', orderCount);
        //(`📊 Updated sync tracking for orders: ${orderCount} remaining (deleted ${deletionCount})`);
      } catch (trackingError) {
        console.error('Error updating sync tracking for orders:', trackingError);
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

    // Trigger inventory alerts check (deffered to next tick)
    setImmediate(() => {
      checkAndSendInventoryAlerts(sellerId)
        .catch(err => console.error('Error in inventory alerts check after syncOrders:', err));
    });
  } catch (error) {
    console.error('Sync orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Error syncing orders',
      error: error.message
    });
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
          let existing = (item._id && mongoose.Types.ObjectId.isValid(item._id)) ? await Transaction.findById(item._id) : null;
          if (!existing && item.id) {
            existing = await Transaction.findOne({ sellerId, localId: item.id });
          }

          if (existing && existing.sellerId.toString() === sellerId.toString()) {
            await Transaction.findByIdAndDelete(existing._id);
            results.success.push({ id: item.id, _id: existing._id, action: 'deleted' });
          } else {
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue;
        }

        // Check for duplicate by id from frontend or other unique identifier
        let existing = (item._id && mongoose.Types.ObjectId.isValid(item._id)) ? await Transaction.findById(item._id) : null;

        if (!existing && item.id) {
          existing = await Transaction.findOne({ sellerId, localId: item.id });
        }

        if (existing && existing.sellerId.toString() === sellerId.toString()) {
          // Update existing transaction
          existing.type = item.type || existing.type;
          existing.amount = item.amount || item.total || existing.amount;
          existing.paymentMethod = item.paymentMethod || existing.paymentMethod;
          existing.description = item.description || existing.description;
          existing.date = item.date ? new Date(item.date) : existing.date;
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
            planOrderId: item.planOrderId,
            planId: item.planId,
            localId: item.id
          });
          const saved = await transaction.save();
          results.success.push({ id: item.id, _id: saved._id, action: 'created' });
        }
      } catch (error) {
        console.error(`Error syncing transaction ${item.id}:`, error);
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
      return res.status(400).json({
        success: false,
        message: 'Items must be an array'
      });
    }

    for (const item of items) {
      try {
        // Handle deletion: if item has isDeleted: true, delete it from MongoDB
        if (item.isDeleted === true) {
          let existing = (item._id && mongoose.Types.ObjectId.isValid(item._id)) ? await VendorOrder.findById(item._id) : null;
          if (!existing && item.id) {
            existing = await VendorOrder.findOne({ sellerId, localId: item.id });
          }

          if (existing && existing.sellerId.toString() === sellerId.toString()) {
            // Delete from MongoDB
            await VendorOrder.findByIdAndDelete(item._id);
            //(`Deleted vendor order ${item._id} from MongoDB`);
            results.success.push({ id: item.id, _id: item._id, action: 'deleted' });
            deletionCount++;
          } else {
            // Item doesn't exist in backend, or _id doesn't match - treat as success
            //(`Vendor order ${item.id} not found in MongoDB, treating deletion as success`);
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue; // Skip to next item
        }

        // Normal sync (create or update)
        // Check for duplicate by multiple criteria to prevent duplicates
        let existing = null;

        // First try by _id if provided
        if (item._id && mongoose.Types.ObjectId.isValid(item._id)) {
          existing = await VendorOrder.findById(item._id);
          if (existing && existing.sellerId.toString() !== sellerId.toString()) {
            existing = null; // Don't use if sellerId doesn't match
          }
        }

        // If not found by _id, check for duplicate by localId
        if (!existing && item.id) {
          existing = await VendorOrder.findOne({ sellerId, localId: item.id });
        }

        // If not found by _id, check for duplicate by content
        if (!existing) {
          const poCreatedAt = item.createdAt || item.date;
          const supplierName = (item.supplierName || '').trim();

          // Create hash of items for comparison
          const itemsHash = JSON.stringify((item.items || []).map(i => ({
            productName: i.productName || i.name,
            quantity: i.quantity,
            price: i.price
          })).sort((a, b) => (a.productName || a.name || '').localeCompare(b.productName || b.name || '')));

          // Find vendor orders with same sellerId, supplierName, and similar total
          const similarPOs = await VendorOrder.find({
            sellerId,
            supplierName: supplierName,
            total: { $gte: (item.total || 0) - 0.01, $lte: (item.total || 0) + 0.01 }
          });

          // Check if any similar PO has matching items and createdAt within same minute
          for (const po of similarPOs) {
            const poItemsHash = JSON.stringify((po.items || []).map(i => ({
              productName: i.productName || i.name,
              quantity: i.quantity,
              price: i.price
            })).sort((a, b) => (a.productName || a.name || '').localeCompare(b.productName || b.name || '')));

            if (poItemsHash === itemsHash) {
              // Check if createdAt is within 5 seconds (to catch rapid duplicates)
              if (poCreatedAt && po.createdAt) {
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
        }

        if (existing && existing.sellerId.toString() === sellerId.toString()) {
          // Update existing order
          existing.supplierName = item.supplierName || existing.supplierName;
          existing.items = item.items || existing.items;
          existing.total = item.total || existing.total;
          existing.status = item.status || existing.status;
          existing.notes = item.notes || existing.notes;
          existing.expectedDeliveryDate = item.expectedDeliveryDate ? new Date(item.expectedDeliveryDate) : existing.expectedDeliveryDate;
          existing.actualDeliveryDate = item.actualDeliveryDate ? new Date(item.actualDeliveryDate) : existing.actualDeliveryDate;
          await existing.save();
          results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
        } else {
          // Create new order
          const vendorOrder = new VendorOrder({
            sellerId,
            supplierName: item.supplierName,
            items: item.items || [],
            total: item.total || 0,
            status: item.status || 'pending',
            notes: item.notes || '',
            expectedDeliveryDate: item.expectedDeliveryDate ? new Date(item.expectedDeliveryDate) : null,
            actualDeliveryDate: item.actualDeliveryDate ? new Date(item.actualDeliveryDate) : null,
            localId: item.id
          });
          const saved = await vendorOrder.save();
          results.success.push({ id: item.id, _id: saved._id, action: 'created' });
        }
      } catch (error) {
        console.error(`Error syncing vendor order ${item.id}:`, error);
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    // Update sync tracking if there were successful syncs or deletions
    if (results.success.length > 0 || deletionCount > 0) {
      try {
        // Get actual count of vendorOrders for this seller (excluding soft deleted)
        const vendorOrderCount = await VendorOrder.countDocuments({ sellerId, isDeleted: { $ne: true } });
        await SyncTracking.updateLatestTime(sellerId, 'vendorOrders', vendorOrderCount);
        //(`📊 Updated sync tracking for vendorOrders: ${vendorOrderCount} remaining (deleted ${deletionCount})`);
      } catch (trackingError) {
        console.error('Error updating sync tracking for vendorOrders:', trackingError);
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
    console.error('Sync vendor orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Error syncing vendor orders',
      error: error.message
    });
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
      console.error(`Error syncing order ${item.id}:`, error);
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
      return res.status(400).json({
        success: false,
        message: 'Items must be an array'
      });
    }

    for (const item of items) {
      try {
        // Handle deletion: if item has isDeleted: true, delete it from MongoDB
        if (item.isDeleted === true) {
          let existing = (item._id && mongoose.Types.ObjectId.isValid(item._id)) ? await Refund.findById(item._id) : null;
          if (!existing && item.id) {
            existing = await Refund.findOne({ sellerId, localId: item.id });
          }

          if (existing && existing.sellerId.toString() === sellerId.toString()) {
            // Delete from MongoDB
            await Refund.findByIdAndUpdate(item._id, {
              isDeleted: true,
              updatedAt: new Date()
            });
            //(`Deleted refund ${item._id} from MongoDB`);
            results.success.push({ id: item.id, _id: item._id, action: 'deleted' });
            deletionCount++;
          } else {
            // Item doesn't exist in backend, or _id doesn't match - treat as success
            //(`Refund ${item.id} not found in MongoDB, treating deletion as success`);
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue; // Skip to next item
        }

        // Normal sync (create or update)
        // Check if refund already exists
        // Check if refund already exists - try _id first
        let existing = (item._id && mongoose.Types.ObjectId.isValid(item._id)) ? await Refund.findById(item._id) : null;

        // If not found by _id, check for duplicate by localId (if provided)
        if (!existing && item.id) {
          existing = await Refund.findOne({ sellerId, localId: item.id });
        }

        if (existing && existing.sellerId.toString() === sellerId.toString()) {
          // Update existing refund
          existing.items = item.items || existing.items;
          existing.totalRefundAmount = item.totalRefundAmount !== undefined ? item.totalRefundAmount : existing.totalRefundAmount;
          existing.reason = item.reason !== undefined ? item.reason : existing.reason;
          existing.refundedByUser = item.refundedByUser || existing.refundedByUser;
          await existing.save();
          results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
        } else {
          // Verify order exists and belongs to seller
          const orderId = item.orderId;
          if (!orderId) {
            results.failed.push({ id: item.id, error: 'Order ID is required' });
            continue;
          }

          const order = await Order.findOne({ _id: orderId, sellerId });
          if (!order) {
            results.failed.push({ id: item.id, error: 'Order not found or does not belong to seller' });
            continue;
          }

          // Create new refund
          const refund = new Refund({
            orderId: order._id,
            customerId: item.customerId || order.customerId || null,
            sellerId,
            items: item.items || [],
            totalRefundAmount: item.totalRefundAmount || 0,
            reason: item.reason || '',
            refundedByUser: item.refundedByUser || 'System',
            localId: item.id
          });

          const saved = await refund.save();

          // Check if stock has already been adjusted by frontend
          // If stockAdjusted flag is set, frontend already updated stock, so skip backend stock updates
          // This prevents double stock increases during refund sync
          const stockAlreadyAdjusted = item.stockAdjusted === true;

          if (!stockAlreadyAdjusted) {
            // Update product stock (increase stock for refunded items) - for backward compatibility
            if (item.items && Array.isArray(item.items)) {
              for (const refundItem of item.items) {
                if (refundItem.productId && mongoose.Types.ObjectId.isValid(refundItem.productId)) {
                  const product = await Product.findOne({ _id: refundItem.productId, sellerId });
                  // Stock adjustment for refunds is now handled in refund controller
                  // using batch quantities instead of product stock
                }
              }
            }
          } else {
            //(`[SYNC] Refund ${item.id}: Stock already adjusted by frontend, skipping backend stock update`);
          }

          results.success.push({ id: item.id, _id: saved._id, action: 'created' });
        }
      } catch (error) {
        console.error(`Error syncing refund ${item.id}:`, error);
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    // Update sync tracking if there were successful syncs or deletions
    if (results.success.length > 0 || deletionCount > 0) {
      try {
        // Get actual count of refunds for this seller (excluding soft deleted)
        const refundCount = await Refund.countDocuments({ sellerId, isDeleted: { $ne: true } });
        await SyncTracking.updateLatestTime(sellerId, 'refunds', refundCount);
        //(`📊 Updated sync tracking for refunds: ${refundCount} remaining (deleted ${deletionCount})`);
      } catch (trackingError) {
        console.error('Error updating sync tracking for refunds:', trackingError);
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
    console.error('Sync refunds error:', error);
    res.status(500).json({
      success: false,
      message: 'Error syncing refunds',
      error: error.message
    });
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
          let existing = (item._id && mongoose.Types.ObjectId.isValid(item._id)) ? await Expense.findById(item._id) : null;
          if (!existing && item.id) {
            existing = await Expense.findOne({ sellerId, localId: item.id });
          }

          if (existing && existing.sellerId.toString() === sellerId.toString()) {
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
        let existing = null;
        if (item._id && mongoose.Types.ObjectId.isValid(item._id)) {
          existing = await Expense.findById(item._id);
          if (existing && existing.sellerId.toString() !== sellerId.toString()) {
            existing = null;
          }
        }

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
        console.error(`Error syncing expense ${item.id}:`, error);
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
      return res.status(400).json({
        success: false,
        message: 'Items must be an array'
      });
    }

    for (const item of items) {
      try {
        // Handle deletion
        if (item.isDeleted === true) {
          let existing = (item._id && mongoose.Types.ObjectId.isValid(item._id)) ? await CustomerTransaction.findById(item._id) : null;
          if (!existing && item.id) {
            existing = await CustomerTransaction.findOne({ sellerId, localId: item.id });
          }

          if (existing && existing.sellerId.toString() === sellerId.toString()) {
            await CustomerTransaction.findByIdAndDelete(existing._id);
            results.success.push({ id: item.id, _id: existing._id, action: 'deleted' });
            deletionCount++;
          } else {
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue;
        }

        let existing = null;
        if (item._id && mongoose.Types.ObjectId.isValid(item._id)) {
          existing = await CustomerTransaction.findById(item._id);
          if (existing && existing.sellerId.toString() !== sellerId.toString()) existing = null;
        }
        if (!existing && item.id) {
          existing = await CustomerTransaction.findOne({ sellerId, localId: item.id });
        }

        // Resolve customerId
        let customerId = item.customerId;
        if (item.customerId && !mongoose.Types.ObjectId.isValid(item.customerId)) {
          const customer = await Customer.findOne({ sellerId, localId: item.customerId });
          if (customer) {
            customerId = customer._id;
          } else {
            // If customer not found by localId, validation will fail.
            // Try to find if the passed ID was actually a valid _id but just string format check failed?
            // No, isValid handles that.
            // If we can't resolve the customer, we can't save the transaction.
            console.warn(`Could not resolve customerId for transaction ${item.id}. Customer ID: ${item.customerId}`);
            results.failed.push({ id: item.id, error: `Customer not found for ID: ${item.customerId}` });
            continue;
          }
        } else if (!item.customerId) {
          results.failed.push({ id: item.id, error: `Missing customerId` });
          continue;
        }

        // Resolve Order ID (Optional)
        let orderId = item.orderId;
        if (item.orderId && !mongoose.Types.ObjectId.isValid(item.orderId)) {
          const order = await Order.findOne({ sellerId, localId: item.orderId });
          // If order not found, default to null rather than failing
          orderId = order ? order._id : null;
        } else if (!item.orderId) {
          orderId = null;
        }

        const transactionData = {
          sellerId,
          customerId,
          type: item.type,
          amount: item.amount,
          date: item.date || new Date(),
          description: item.description || '',
          orderId: orderId, // Use resolved or null
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
        console.error(`Error syncing customer transaction ${item.id}:`, error);
        results.failed.push({ id: item.id, error: error.message });
      }
    }

    if (results.success.length > 0 || deletionCount > 0) {
      try {
        const count = await CustomerTransaction.countDocuments({ sellerId });
        await SyncTracking.updateLatestTime(sellerId, 'customerTransactions', count);
      } catch (trackingError) {
        console.error('Error updating sync tracking for customer transactions:', trackingError);
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
        console.error(`Error syncing settings for item ${item.id}:`, error);
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
  getSyncStatus,
  syncSettings
};

