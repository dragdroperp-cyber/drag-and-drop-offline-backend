const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Transaction = require('../models/Transaction');
const VendorOrder = require('../models/VendorOrder');
const { adjustPlanUsage } = require('../utils/planUsage');
const ProductCategory = require('../models/ProductCategory');
const Refund = require('../models/Refund');

const adjustProductStockForOrder = async (sellerId, orderItems) => {
  if (!Array.isArray(orderItems) || orderItems.length === 0) {
    return;
  }

  for (const item of orderItems) {
    try {
      if (!item || !item.productId || !mongoose.Types.ObjectId.isValid(item.productId)) {
        continue;
      }

      const product = await Product.findOne({
        _id: item.productId,
        sellerId
      });

      if (!product) {
        continue;
      }

      const quantity = typeof item.quantity === 'number' ? item.quantity : parseFloat(item.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        continue;
      }

      const currentStock = product.stock !== undefined && product.stock !== null
        ? product.stock
        : (product.quantity !== undefined && product.quantity !== null ? product.quantity : 0);

      const updatedStock = Math.max(0, currentStock - quantity);
      product.stock = updatedStock;
      product.quantity = updatedStock;

      await product.save();
    } catch (error) {
      console.error(`Error adjusting stock for product ${item?.productId}:`, error);
    }
  }
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
          const existing = item._id ? await Customer.findById(item._id) : null;
          
          if (existing && existing.sellerId.toString() === sellerId.toString()) {
            // Soft delete from MongoDB
            await Customer.findByIdAndUpdate(item._id, {
              isDeleted: true,
              updatedAt: new Date()
            });
            console.log(`Deleted customer ${item._id} from MongoDB`);
            results.success.push({ id: item.id, _id: item._id, action: 'deleted' });
            const usageResult = await adjustPlanUsage(sellerId, 'customers', -1);
            if (!usageResult.success) {
              console.warn(`Plan usage warning (customers delete): ${usageResult.message}`);
            }
          } else {
            // Item doesn't exist in backend, or _id doesn't match - treat as success
            console.log(`Customer ${item.id} not found in MongoDB, treating deletion as success`);
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue; // Skip to next item
        }
        
        // Normal sync (create or update)
        let existing = null;
        
        // First try to find by _id if provided (for updates from synced items)
        if (item._id) {
          existing = await Customer.findById(item._id);
          if (existing && existing.sellerId.toString() !== sellerId.toString()) {
            existing = null; // Don't use if sellerId doesn't match
          }
        }
        
        // If not found by _id, check for duplicate by name + mobileNumber
        if (!existing) {
          const mobileNumber = item.mobileNumber || item.phone;
          const email = item.email;
          
          // Try to find by name + mobileNumber
          if (mobileNumber) {
            existing = await Customer.findOne({
              sellerId,
              name: item.name.trim(),
              mobileNumber: mobileNumber.trim()
            });
          }
          
          // If not found and email exists, try by name + email
          if (!existing && email) {
            existing = await Customer.findOne({
              sellerId,
              name: item.name.trim(),
              email: email.trim().toLowerCase()
            });
          }
          
          // If still not found, try by name only (as last resort)
          if (!existing && !mobileNumber && !email) {
            existing = await Customer.findOne({
              sellerId,
              name: item.name.trim(),
              $or: [
                { mobileNumber: { $exists: false } },
                { mobileNumber: '' },
                { mobileNumber: null }
              ]
            });
            
            // Also ensure email is empty/null if found
            if (existing && existing.email && existing.email.trim() !== '') {
              existing = null; // Don't match if email exists
            }
          }
        }

        if (existing) {
          // Update ALL fields of existing customer
          existing.name = item.name.trim();
          existing.dueAmount = item.dueAmount !== undefined ? item.dueAmount : existing.dueAmount;
          existing.mobileNumber = item.mobileNumber || item.phone || existing.mobileNumber;
          existing.email = item.email !== undefined ? item.email : existing.email;
          existing.address = item.address !== undefined ? item.address : existing.address;
          await existing.save();
          
          // Log if this was marked as an update
          if (item.isUpdate === true) {
            console.log(`Updated customer ${existing._id} (marked with isUpdate flag)`);
          }
          
          results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
        } else {
          // Create new customer
          // Use mobileNumber, fallback to phone for backward compatibility
          const customer = new Customer({
            sellerId,
            name: item.name,
            dueAmount: item.dueAmount || 0,
            mobileNumber: item.mobileNumber || item.phone || '',
            email: item.email
          });
          const saved = await customer.save();
          const usageResult = await adjustPlanUsage(sellerId, 'customers', 1);
          if (!usageResult.success) {
            await Customer.findByIdAndUpdate(saved._id, {
              isDeleted: true,
              updatedAt: new Date()
            });
            results.failed.push({ id: item.id, error: usageResult.message || 'Plan limit reached', action: 'limit-exceeded' });
            continue;
          }
          results.success.push({ id: item.id, _id: saved._id, action: 'created' });
        }
      } catch (error) {
        console.error(`Error syncing customer ${item.id}:`, error);
        results.failed.push({ id: item.id, error: error.message });
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
          const existing = item._id ? await ProductCategory.findById(item._id) : null;
          
          if (existing && existing.sellerId.toString() === sellerId.toString()) {
            // Delete from MongoDB
            await ProductCategory.findByIdAndUpdate(item._id, {
              isDeleted: true,
              updatedAt: new Date()
            });
            console.log(`Deleted category ${item._id} from MongoDB`);
            results.success.push({ id: item.id, _id: item._id, action: 'deleted' });
          } else {
            // Item doesn't exist in backend, or _id doesn't match - treat as success
            console.log(`Category ${item.id} not found in MongoDB, treating deletion as success`);
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue; // Skip to next item
        }
        
        // Normal sync (create or update)
        // Check for duplicate by name
        const existing = await findExistingDocument(
          ProductCategory,
          sellerId,
          { name: item.name }
        );

        if (existing) {
          results.success.push({ id: item.id, _id: existing._id, action: 'exists' });
        } else {
          // Create new category
          const category = new ProductCategory({
            sellerId,
            name: item.name,
            description: item.description,
            image: item.image,
            isActive: item.isActive !== undefined ? item.isActive : true
          });
          const saved = await category.save();
          results.success.push({ id: item.id, _id: saved._id, action: 'created' });
        }
      } catch (error) {
        console.error(`Error syncing category ${item.id}:`, error);
        results.failed.push({ id: item.id, error: error.message });
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
          const existing = item._id ? await Product.findById(item._id) : null;
          
          if (existing && existing.sellerId.toString() === sellerId.toString()) {
            // Delete from MongoDB
            await Product.findByIdAndUpdate(item._id, {
              isDeleted: true,
              updatedAt: new Date()
            });
            console.log(`Deleted product ${item._id} from MongoDB`);
            results.success.push({ id: item.id, _id: item._id, action: 'deleted' });
            const usageResult = await adjustPlanUsage(sellerId, 'products', -1);
            if (!usageResult.success) {
              console.warn(`Plan usage warning (products delete): ${usageResult.message}`);
            }
          } else {
            // Item doesn't exist in backend, or _id doesn't match - treat as success
            console.log(`Product ${item.id} not found in MongoDB, treating deletion as success`);
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
          // If categoryId is provided directly, verify it exists
          const category = await ProductCategory.findOne({
            _id: item.categoryId,
            sellerId
          });
          if (category) {
            categoryId = category._id;
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
        
        // If not found by _id, check for duplicate by name + description (for new products)
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
          existing.stock = item.stock !== undefined ? item.stock : (item.quantity !== undefined ? item.quantity : existing.stock);
          existing.unit = item.unit || item.quantityUnit || existing.unit;
          existing.costPrice = item.costPrice !== undefined ? item.costPrice : (item.unitPrice !== undefined ? item.unitPrice : existing.costPrice);
          existing.sellingUnitPrice = item.sellingUnitPrice !== undefined ? item.sellingUnitPrice : (item.sellingPrice !== undefined ? item.sellingPrice : existing.sellingUnitPrice);
          existing.mfg = item.mfg || item.mfgDate ? new Date(item.mfg || item.mfgDate) : existing.mfg;
          existing.expiryDate = item.expiryDate ? new Date(item.expiryDate) : existing.expiryDate;
          existing.description = item.description !== undefined ? item.description : existing.description;
          existing.categoryId = categoryId || existing.categoryId;
          existing.barcode = item.barcode !== undefined ? item.barcode : existing.barcode;
          existing.lowStockLevel = item.lowStockLevel !== undefined ? item.lowStockLevel : existing.lowStockLevel;
          existing.isActive = item.isActive !== undefined ? item.isActive : existing.isActive;
          await existing.save();
          console.log(`✅ Updated product ${existing._id} in MongoDB:`, {
            name: existing.name,
            stock: existing.stock,
            costPrice: existing.costPrice
          });
          results.success.push({ id: item.id, _id: existing._id, action: 'updated' });
        } else {
          // Create new product - MongoDB uses 'stock' and 'costPrice'
          // Frontend may send 'quantity' or 'stock', 'costPrice' or 'unitPrice'
          const product = new Product({
            sellerId,
            name: item.name,
            barcode: item.barcode || '',
            categoryId,
            stock: item.stock !== undefined ? item.stock : (item.quantity || 0),
            unit: item.unit || 'pcs',
            costPrice: item.costPrice !== undefined ? item.costPrice : (item.unitPrice || 0),
            sellingUnitPrice: item.sellingUnitPrice || item.sellingPrice || 0,
            mfg: item.mfg || item.mfgDate ? new Date(item.mfg || item.mfgDate) : new Date(),
            expiryDate: item.expiryDate ? new Date(item.expiryDate) : new Date(),
            description: item.description || '',
            lowStockLevel: item.lowStockLevel || 10,
            isActive: item.isActive !== undefined ? item.isActive : false
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
    console.error('Sync products error:', error);
    res.status(500).json({
      success: false,
      message: 'Error syncing products',
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
    const results = { success: [], failed: [] };

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
          const existing = item._id ? await Order.findById(item._id) : null;
          
          if (existing && existing.sellerId.toString() === sellerId.toString()) {
            // Delete from MongoDB
            await Order.findByIdAndUpdate(item._id, {
              isDeleted: true,
              updatedAt: new Date()
            });
            console.log(`Deleted order ${item._id} from MongoDB`);
            results.success.push({ id: item.id, _id: item._id, action: 'deleted' });
            const usageResult = await adjustPlanUsage(sellerId, 'orders', -1);
            if (!usageResult.success) {
              console.warn(`Plan usage warning (orders delete): ${usageResult.message}`);
            }
          } else {
            // Item doesn't exist in backend, or _id doesn't match - treat as success
            console.log(`Order ${item.id} not found in MongoDB, treating deletion as success`);
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
            // If it's a frontend ID (not MongoDB ObjectId), try to find customer by frontend ID or other identifier
            // Look for customer in MongoDB that might have this as a custom field or match by name
            // For now, we'll treat it as null if it's not a valid ObjectId
            // The frontend should send the MongoDB _id if the customer was previously synced
            console.warn(`Customer ID ${item.customerId} is not a valid MongoDB ObjectId - treating as walk-in customer`);
            customerId = null; // Treat as walk-in customer
          }
        }
        
        // Check for duplicate by multiple criteria to prevent duplicates
        // Duplicate check: sellerId + customerId + totalAmount + items hash + createdAt (within same minute)
        let existing = null;
        
        // First try by _id if provided
        if (item._id) {
          existing = await Order.findById(item._id);
          if (existing && existing.sellerId.toString() !== sellerId.toString()) {
            existing = null; // Don't use if sellerId doesn't match
          }
        }
        
        // If not found by _id, check for duplicate by content
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
                  console.log(`⚠️ Duplicate order detected by content (within 5s): ${order._id}`);
                  break;
                }
              }
            }
          }
        }

        if (existing && existing.sellerId.toString() === sellerId.toString()) {
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
            customerMobile: item.customerMobile || ''
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
          
          // Only deduct stock in backend if frontend hasn't already deducted it
          // Frontend sets stockDeducted: true when it deducts stock
          const stockAlreadyDeducted = item.stockDeducted === true;
          if (!stockAlreadyDeducted) {
            console.log(`[SYNC] Stock not deducted in frontend, deducting in backend for order ${item.id}`);
            await adjustProductStockForOrder(sellerId, item.items);
          } else {
            console.log(`[SYNC] Stock already deducted in frontend (stockDeducted: true), skipping backend stock deduction for order ${item.id}`);
          }
          
          results.success.push({ id: item.id, _id: saved._id, action: 'created' });
        }
      } catch (error) {
        console.error(`Error syncing order ${item.id}:`, error);
        console.error('Order data:', JSON.stringify(item, null, 2));
        results.failed.push({ id: item.id, error: error.message });
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
        // Check for duplicate by id from frontend or other unique identifier
        const existing = item._id ? await Transaction.findById(item._id) : null;

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
            planId: item.planId
          });
          const saved = await transaction.save();
          results.success.push({ id: item.id, _id: saved._id, action: 'created' });
        }
      } catch (error) {
        console.error(`Error syncing transaction ${item.id}:`, error);
        results.failed.push({ id: item.id, error: error.message });
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
          const existing = item._id ? await VendorOrder.findById(item._id) : null;
          
          if (existing && existing.sellerId.toString() === sellerId.toString()) {
            // Delete from MongoDB
            await VendorOrder.findByIdAndUpdate(item._id, {
              isDeleted: true,
              updatedAt: new Date()
            });
            console.log(`Deleted vendor order ${item._id} from MongoDB`);
            results.success.push({ id: item.id, _id: item._id, action: 'deleted' });
          } else {
            // Item doesn't exist in backend, or _id doesn't match - treat as success
            console.log(`Vendor order ${item.id} not found in MongoDB, treating deletion as success`);
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue; // Skip to next item
        }
        
        // Normal sync (create or update)
        // Check for duplicate by multiple criteria to prevent duplicates
        let existing = null;
        
        // First try by _id if provided
        if (item._id) {
          existing = await VendorOrder.findById(item._id);
          if (existing && existing.sellerId.toString() !== sellerId.toString()) {
            existing = null; // Don't use if sellerId doesn't match
          }
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
                  console.log(`⚠️ Duplicate vendor order detected by content (within 5s): ${po._id}`);
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
            actualDeliveryDate: item.actualDeliveryDate ? new Date(item.actualDeliveryDate) : null
          });
          const saved = await vendorOrder.save();
          results.success.push({ id: item.id, _id: saved._id, action: 'created' });
        }
      } catch (error) {
        console.error(`Error syncing vendor order ${item.id}:`, error);
        results.failed.push({ id: item.id, error: error.message });
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
        existing.stock = item.stock !== undefined ? item.stock : (item.quantity !== undefined ? item.quantity : existing.stock);
        existing.unit = item.unit || existing.unit;
        existing.costPrice = item.costPrice !== undefined ? item.costPrice : (item.unitPrice !== undefined ? item.unitPrice : existing.costPrice);
        existing.sellingUnitPrice = item.sellingUnitPrice || item.sellingPrice || existing.sellingUnitPrice;
        existing.mfg = item.mfg || item.mfgDate ? new Date(item.mfg || item.mfgDate) : existing.mfg;
        existing.expiryDate = item.expiryDate ? new Date(item.expiryDate) : existing.expiryDate;
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
          stock: item.stock !== undefined ? item.stock : (item.quantity || 0),
          unit: item.unit || 'pcs',
          costPrice: item.costPrice !== undefined ? item.costPrice : (item.unitPrice || 0),
          sellingUnitPrice: item.sellingUnitPrice || item.sellingPrice || 0,
          mfg: item.mfg || item.mfgDate ? new Date(item.mfg || item.mfgDate) : new Date(),
          expiryDate: item.expiryDate ? new Date(item.expiryDate) : new Date(),
          description: item.description || '',
          lowStockLevel: item.lowStockLevel || 10,
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
      if (item._id) {
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
              console.log(`⚠️ Duplicate order detected by content (within 5s): ${order._id}`);
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
        
        // Only deduct stock in backend if frontend hasn't already deducted it
        // Frontend sets stockDeducted: true when it deducts stock
        const stockAlreadyDeducted = item.stockDeducted === true;
        if (!stockAlreadyDeducted) {
          console.log(`[SYNC] Stock not deducted in frontend, deducting in backend for order ${item.id}`);
          await adjustProductStockForOrder(sellerId, item.items);
        } else {
          console.log(`[SYNC] Stock already deducted in frontend (stockDeducted: true), skipping backend stock deduction for order ${item.id}`);
        }
        
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
      const existing = item._id ? await Transaction.findById(item._id) : null;
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
      if (item._id) {
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
              console.log(`⚠️ Duplicate vendor order detected by content (within 5s): ${po._id}`);
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
          const existing = item._id ? await Refund.findById(item._id) : null;
          
          if (existing && existing.sellerId.toString() === sellerId.toString()) {
            // Delete from MongoDB
            await Refund.findByIdAndUpdate(item._id, {
              isDeleted: true,
              updatedAt: new Date()
            });
            console.log(`Deleted refund ${item._id} from MongoDB`);
            results.success.push({ id: item.id, _id: item._id, action: 'deleted' });
          } else {
            // Item doesn't exist in backend, or _id doesn't match - treat as success
            console.log(`Refund ${item.id} not found in MongoDB, treating deletion as success`);
            results.success.push({ id: item.id, _id: item._id || null, action: 'deleted' });
          }
          continue; // Skip to next item
        }
        
        // Normal sync (create or update)
        // Check if refund already exists
        const existing = item._id ? await Refund.findById(item._id) : null;

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
            refundedByUser: item.refundedByUser || 'System'
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
                  if (product) {
                    product.stock = (product.stock || 0) + (refundItem.qty || 0);
                    await product.save();
                  }
                }
              }
            }
          } else {
            console.log(`[SYNC] Refund ${item.id}: Stock already adjusted by frontend, skipping backend stock update`);
          }

          results.success.push({ id: item.id, _id: saved._id, action: 'created' });
        }
      } catch (error) {
        console.error(`Error syncing refund ${item.id}:`, error);
        results.failed.push({ id: item.id, error: error.message });
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

module.exports = {
  syncCustomers,
  syncProducts,
  syncOrders,
  syncTransactions,
  syncVendorOrders,
  syncCategories,
  syncRefunds,
  getSyncStatus
};

