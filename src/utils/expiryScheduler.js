const cron = require('node-cron');
const mongoose = require('mongoose');
const Seller = require('../models/Seller');
const Product = require('../models/Product');
const ProductBatch = require('../models/ProductBatch');
const { sendInventoryAlertEmail } = require('./emailService');

/**
 * Core logic to check expiry for all sellers and send grouped emails
 */
const runExpiryCheck = async () => {
    console.log('🕒 Starting background expiry check job...');
    const startTime = Date.now();

    try {
        // 1. Fetch all active sellers
        const sellers = await Seller.find({ isActive: true });
        console.log(`🔍 Checking ${sellers.length} active sellers...`);

        for (const seller of sellers) {
            try {
                await checkSellersExpiry(seller);
            } catch (err) {
                console.error(`❌ Error checking expiry for seller ${seller.email}:`, err);
            }
        }

        const duration = (Date.now() - startTime) / 1000;
        console.log(`✅ Background expiry check completed in ${duration}s`);
    } catch (error) {
        console.error('❌ Critical error in expiry check job:', error);
    }
};

/**
 * Check a specific seller's batches for expiry transitions
 */
const checkSellersExpiry = async (seller) => {
    const threshold = seller.expiryDaysThreshold || 7;
    const now = new Date();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const warningLimit = new Date(today);
    warningLimit.setDate(warningLimit.getDate() + threshold);

    // Optimized Query: quantity > 0, not deleted, and expiry is either passed or coming soon
    const batches = await ProductBatch.find({
        sellerId: seller._id,
        isDeleted: false,
        quantity: { $gt: 0 },
        expiry: { $lte: warningLimit } // Already critical or soon to be warning
    });

    if (batches.length === 0) return;

    // Group batches by product to minimize product queries
    const toAlertByProduct = {}; // productId -> { product, batches: [] }
    const batchUpdates = [];

    for (const batch of batches) {
        const expiryDate = new Date(batch.expiry);
        expiryDate.setHours(0, 0, 0, 0);

        let currentStatus = 'safe';
        if (expiryDate < today) {
            currentStatus = 'critical';
        } else if (expiryDate <= warningLimit) {
            currentStatus = 'warning';
        }

        const prevStatus = batch.lastAlertStatus || 'safe';

        // Requirement: Trigger ONLY on state change (OK -> Soon, Soon -> Expired, etc.)
        // We only care about transitions to 'warning' or 'critical'
        if (currentStatus !== prevStatus && currentStatus !== 'safe') {

            // Add to grouping for email
            if (!toAlertByProduct[batch.productId]) {
                const product = await Product.findById(batch.productId);
                if (product && !product.isDeleted) {
                    toAlertByProduct[batch.productId] = {
                        name: product.name,
                        unit: product.unit || 'pcs',
                        batches: []
                    };
                } else {
                    continue; // Skip if product is deleted or not found
                }
            }

            toAlertByProduct[batch.productId].batches.push({
                batchNumber: batch.batchNumber,
                expiryDate: batch.expiry,
                status: currentStatus === 'critical' ? 'Expired' : 'Expiring Soon',
                daysLeft: Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24))
            });

            // Update state to prevent duplicates
            batch.lastAlertStatus = currentStatus;
            batch.lastExpiryAlertSentAt = now;
            batchUpdates.push(batch.save());
        } else if (currentStatus === 'safe' && prevStatus !== 'safe') {
            // Silently update status if it became safe again (restocked with new expiry)
            batch.lastAlertStatus = 'safe';
            batchUpdates.push(batch.save());
        }
    }

    // If we have items to alert, send one email per product as requested
    for (const [productId, productData] of Object.entries(toAlertByProduct)) {
        const alertData = productData.batches.map(b => ({
            name: productData.name,
            batchNumber: b.batchNumber ? `${b.batchNumber} (${b.status})` : b.status,
            expiryDate: b.expiryDate,
            currentStock: b.daysLeft > 0 ? `${b.daysLeft} days left` : `${Math.abs(b.daysLeft)} days overdue`,
            unit: ''
        }));

        await sendInventoryAlertEmail(seller.email, seller.name, 'expiry', alertData);
    }

    // Save all progress
    if (batchUpdates.length > 0) {
        await Promise.all(batchUpdates);
    }
};

/**
 * Initialize the cron job
 */
const initExpiryScheduler = () => {
    // Run every day at 3:00 AM (off-peak hours)
    // '0 3 * * *'

    // Run every day at 3:00 AM (off-peak hours)
    cron.schedule('0 3 * * *', () => {
        runExpiryCheck();
    });

    console.log('✅ Expiry Alert Scheduler initialized (Runs daily at 3:00 AM)');

    // Optional: Run once on startup in development to verify
    if (process.env.NODE_ENV === 'development' && process.env.RUN_CRON_ON_START === 'true') {
        runExpiryCheck();
    }
};

module.exports = {
    initExpiryScheduler,
    runExpiryCheck
};
