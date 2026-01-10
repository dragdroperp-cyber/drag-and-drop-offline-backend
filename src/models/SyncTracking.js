const mongoose = require('mongoose');

/**
 * Sync Tracking Model
 * Single document per seller containing latest update times for all data types
 * Used for efficient delta synchronization
 */
const syncTrackingSchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Seller',
    required: true,
    unique: true,
    index: true
  },
  // Latest update times for each data type
  customersLatestUpdateTime: { type: Date, default: Date.now },
  productsLatestUpdateTime: { type: Date, default: Date.now },
  productBatchesLatestUpdateTime: { type: Date, default: Date.now },
  categoriesLatestUpdateTime: { type: Date, default: Date.now },
  ordersLatestUpdateTime: { type: Date, default: Date.now },
  planOrdersLatestUpdateTime: { type: Date, default: Date.now },
  refundsLatestUpdateTime: { type: Date, default: Date.now },
  transactionsLatestUpdateTime: { type: Date, default: Date.now },
  customerTransactionsLatestUpdateTime: { type: Date, default: Date.now },
  vendorOrdersLatestUpdateTime: { type: Date, default: Date.now },
  expensesLatestUpdateTime: { type: Date, default: Date.now },
  achievementsLatestUpdateTime: { type: Date, default: Date.now },
  staffLatestUpdateTime: { type: Date, default: Date.now },
  suppliersLatestUpdateTime: { type: Date, default: Date.now },
  supplierTransactionsLatestUpdateTime: { type: Date, default: Date.now },

  // Record counts for each data type
  customersRecordCount: { type: Number, default: 0 },
  productsRecordCount: { type: Number, default: 0 },
  productBatchesRecordCount: { type: Number, default: 0 },
  categoriesRecordCount: { type: Number, default: 0 },
  ordersRecordCount: { type: Number, default: 0 },
  planOrdersRecordCount: { type: Number, default: 0 },
  refundsRecordCount: { type: Number, default: 0 },
  transactionsRecordCount: { type: Number, default: 0 },
  customerTransactionsRecordCount: { type: Number, default: 0 },
  vendorOrdersRecordCount: { type: Number, default: 0 },
  expensesRecordCount: { type: Number, default: 0 },
  achievementsRecordCount: { type: Number, default: 0 },
  staffRecordCount: { type: Number, default: 0 },
  suppliersRecordCount: { type: Number, default: 0 },
  supplierTransactionsRecordCount: { type: Number, default: 0 },

  // Last fetch times for each data type (used for incremental data fetching)
  customersLastSyncTime: { type: Date, default: null },
  productsLastSyncTime: { type: Date, default: null },
  productBatchesLastSyncTime: { type: Date, default: null },
  categoriesLastSyncTime: { type: Date, default: null },
  ordersLastSyncTime: { type: Date, default: null },
  planOrdersLastSyncTime: { type: Date, default: null },
  refundsLastSyncTime: { type: Date, default: null },
  transactionsLastSyncTime: { type: Date, default: null },
  customerTransactionsLastSyncTime: { type: Date, default: null },
  vendorOrdersLastSyncTime: { type: Date, default: null },
  expensesLastSyncTime: { type: Date, default: null },
  achievementsLastSyncTime: { type: Date, default: null },
  staffLastSyncTime: { type: Date, default: null },
  suppliersLastSyncTime: { type: Date, default: null },
  supplierTransactionsLastSyncTime: { type: Date, default: null }
}, {
  timestamps: true
});

// Ensure sellerId is unique
syncTrackingSchema.index({ sellerId: 1 }, { unique: true });

// Static method to update latest update time for a specific data type
syncTrackingSchema.statics.updateLatestTime = async function (sellerId, dataType, recordCount = null) {
  try {
    const now = new Date();

    // Build the update data for the specific data type
    const updateData = {
      [`${dataType}LatestUpdateTime`]: now
    };

    if (recordCount !== null) {
      updateData[`${dataType}RecordCount`] = recordCount;
    }

    const result = await this.findOneAndUpdate(
      { sellerId },
      updateData,
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      }
    );

    //(`✅ Updated sync tracking for ${dataType}: ${now}`);
    return result;
  } catch (error) {
    console.error(`❌ Error updating sync tracking for ${dataType}:`, error);
    throw error;
  }
};

// Static method to ensure a seller has a sync tracking document with all required fields
syncTrackingSchema.statics.ensureTracking = async function (sellerId) {
  try {
    // Force sellerId to be an ObjectId if it's a string
    const sid = typeof sellerId === 'string' ? new mongoose.Types.ObjectId(sellerId) : sellerId;

    // Use raw collection to see exactly what's in MongoDB, bypassing Mongoose defaults
    const rawDoc = await this.collection.findOne({ sellerId: sid });

    if (!rawDoc) {
      return await this.initializeForSeller(sellerId);
    }

    const dataTypes = ['customers', 'products', 'productBatches', 'categories', 'orders', 'planOrders', 'refunds', 'transactions', 'customerTransactions', 'vendorOrders', 'expenses', 'achievements', 'staff', 'suppliers', 'supplierTransactions'];

    // Check for missing fields and update if necessary
    let needsUpdate = false;
    const updateData = {};

    dataTypes.forEach(dataType => {
      const field = `${dataType}LatestUpdateTime`;
      // If field is missing from raw DB object, it needs to be initialized
      if (!(field in rawDoc)) {
        updateData[field] = new Date();
        updateData[`${dataType}RecordCount`] = 0;
        updateData[`${dataType}LastSyncTime`] = null;
        needsUpdate = true;
      }
    });

    if (needsUpdate) {
      // self-healing: add missing fields
      await this.collection.updateOne(
        { sellerId: sid },
        { $set: updateData }
      );
      // Refresh the document after update
      return await this.findOne({ sellerId: sid });
    }

    // Convert raw doc to Mongoose doc if we skipped update
    return this.findOne({ sellerId: sid });
  } catch (error) {
    console.error('❌ Error ensuring sync tracking:', error);
    throw error;
  }
};

// Static method to get latest update times and fetch times for all data types
syncTrackingSchema.statics.getLatestUpdateTimes = async function (sellerId) {
  try {
    const tracking = await this.ensureTracking(sellerId);

    const dataTypes = ['customers', 'products', 'productBatches', 'categories', 'orders', 'planOrders', 'refunds', 'transactions', 'customerTransactions', 'vendorOrders', 'expenses', 'achievements', 'staff', 'suppliers', 'supplierTransactions'];
    const result = {};

    dataTypes.forEach(dataType => {
      result[dataType] = {
        latestUpdateTime: tracking[`${dataType}LatestUpdateTime`] || new Date(0),
        recordCount: tracking[`${dataType}RecordCount`] || 0,
        lastFetchTime: tracking[`${dataType}LastSyncTime`] || null
      };
    });

    return result;
  } catch (error) {
    console.error('❌ Error getting latest update times:', error);
    throw error;
  }
};


// Static method to get delta data for fetch
syncTrackingSchema.statics.getDeltaData = async function (sellerId, lastFetchTimes) {
  try {
    const tracking = await this.ensureTracking(sellerId);

    const deltaData = {};
    const needsFullSync = [];

    // Check which data types need updates
    for (const [dataType, lastFetchTime] of Object.entries(lastFetchTimes)) {
      const latestUpdateTime = tracking ? tracking[`${dataType}LatestUpdateTime`] : null;
      const recordCount = tracking ? tracking[`${dataType}RecordCount`] : 0;

      if (!latestUpdateTime) {
        // No tracking data exists for this data type, need full sync
        needsFullSync.push(dataType);
        continue;
      }

      if (!lastFetchTime || new Date(lastFetchTime) < latestUpdateTime) {
        // Data has been updated since last sync
        deltaData[dataType] = {
          needsUpdate: true,
          latestUpdateTime: latestUpdateTime,
          recordCount: recordCount
        };
      } else {
        // Data is up to date
        deltaData[dataType] = {
          needsUpdate: false,
          latestUpdateTime: latestUpdateTime,
          recordCount: recordCount
        };
      }
    }

    return {
      deltaData,
      needsFullSync
    };
  } catch (error) {
    console.error('❌ Error getting delta data:', error);
    throw error;
  }
};

// Static method to initialize sync tracking for a seller
syncTrackingSchema.statics.initializeForSeller = async function (sellerId) {
  try {
    const dataTypes = ['customers', 'products', 'productBatches', 'categories', 'orders', 'planOrders', 'refunds', 'transactions', 'customerTransactions', 'vendorOrders', 'expenses', 'achievements', 'staff', 'suppliers', 'supplierTransactions'];
    const now = new Date();

    const updateData = {};
    dataTypes.forEach(dataType => {
      updateData[`${dataType}LatestUpdateTime`] = now;
      updateData[`${dataType}RecordCount`] = 0;
      updateData[`${dataType}LastSyncTime`] = null;
    });

    const result = await this.findOneAndUpdate(
      { sellerId },
      updateData,
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      }
    );

    //(`✅ Initialized sync tracking for seller ${sellerId}`);
    return result;
  } catch (error) {
    console.error('❌ Error initializing sync tracking for seller:', error);
    throw error;
  }
};

// Static method to update last fetch time for a data type
syncTrackingSchema.statics.updateLastFetchTime = async function (sellerId, dataType, lastFetchTime = new Date()) {
  try {
    const updateData = {
      [`${dataType}LastSyncTime`]: lastFetchTime,
      updatedAt: new Date()
    };

    const result = await this.findOneAndUpdate(
      { sellerId },
      updateData,
      {
        upsert: true,
        new: true
      }
    );

    return result;
  } catch (error) {
    console.error(`❌ Error updating last sync time for ${dataType}:`, error);
    throw error;
  }
};

module.exports = mongoose.model('SyncTracking', syncTrackingSchema);
