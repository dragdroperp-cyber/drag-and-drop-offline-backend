const Product = require('../models/Product');
const ProductBatch = require('../models/ProductBatch');
const Seller = require('../models/Seller');
const { sendInventoryAlertEmail } = require('./emailService');
const mongoose = require('mongoose');

/**
 * Check for inventory alerts and send grouped emails if necessary
 * Grouped alerts for: Low Stock, Out of Stock, and Expiry
 */
const checkAndSendInventoryAlerts = async (sellerId) => {
    try {
        const seller = await Seller.findById(sellerId);
        if (!seller || !seller.email) return;

        const lowStockThreshold = seller.lowStockThreshold || 10;
        const expiryDaysThreshold = seller.expiryDaysThreshold || 7;

        // 1. Fetch all active products
        const products = await Product.find({ sellerId, isDeleted: false });

        // 2. Fetch all active batches to calculate total stock per product
        const batches = await ProductBatch.find({ sellerId, isDeleted: false });

        const productStockMap = {}; // productId -> totalStock
        batches.forEach(batch => {
            const pId = batch.productId.toString();
            productStockMap[pId] = (productStockMap[pId] || 0) + batch.quantity;
        });

        const lowStockProducts = [];
        const outOfStockProducts = [];
        const expiringBatches = [];

        const now = new Date();
        const expiryDateLimit = new Date();
        expiryDateLimit.setDate(expiryDateLimit.getDate() + expiryDaysThreshold);

        const updatePromises = [];

        for (const product of products) {
            const currentStock = productStockMap[product._id.toString()] || 0;
            const threshold = product.lowStockLevel || lowStockThreshold;
            let needsSave = false;

            // Check Out of Stock
            if (currentStock === 0) {
                if (!product.lastOutOfStockAlertSentAt) {
                    outOfStockProducts.push({
                        name: product.name,
                        currentStock: 0,
                        unit: product.unit || 'pcs'
                    });
                    product.lastOutOfStockAlertSentAt = now;
                    needsSave = true;
                }
            } else {
                // Reset out of stock alert if stock is now > 0
                if (product.lastOutOfStockAlertSentAt) {
                    product.lastOutOfStockAlertSentAt = null;
                    needsSave = true;
                }

                // Check Low Stock (only if not out of stock)
                if (currentStock <= threshold) {
                    if (!product.lastLowStockAlertSentAt) {
                        lowStockProducts.push({
                            name: product.name,
                            currentStock: currentStock,
                            unit: product.unit || 'pcs'
                        });
                        product.lastLowStockAlertSentAt = now;
                        needsSave = true;
                    }
                } else {
                    // Reset low stock alert if stock is now > threshold
                    if (product.lastLowStockAlertSentAt) {
                        product.lastLowStockAlertSentAt = null;
                        needsSave = true;
                    }
                }
            }

            if (needsSave) {
                updatePromises.push(product.save());
            }
        }

        // Check Expiry in batches
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        for (const batch of batches) {
            let needsSave = false;
            if (batch.expiry && batch.quantity > 0) {
                const expiryDate = new Date(batch.expiry);
                expiryDate.setHours(0, 0, 0, 0);

                let currentStatus = 'safe';
                if (expiryDate < today) {
                    currentStatus = 'critical';
                } else if (expiryDate <= expiryDateLimit) {
                    currentStatus = 'warning';
                }

                const prevStatus = batch.lastAlertStatus || 'safe';

                // Trigger ONLY on state change (OK -> Soon, Soon -> Expired, etc.)
                if (currentStatus !== prevStatus && currentStatus !== 'safe') {
                    const product = products.find(p => p._id.equals(batch.productId));

                    const daysLeft = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
                    const statusText = currentStatus === 'critical' ? 'Expired' : 'Expiring Soon';
                    const relativeTime = daysLeft > 0 ? `${daysLeft} days left` : `${Math.abs(daysLeft)} days overdue`;

                    expiringBatches.push({
                        name: product ? product.name : 'Unknown Product',
                        batchNumber: batch.batchNumber ? `${batch.batchNumber} (${statusText})` : statusText,
                        expiryDate: batch.expiry,
                        currentStock: relativeTime,
                        unit: ''
                    });

                    batch.lastAlertStatus = currentStatus;
                    batch.lastExpiryAlertSentAt = now;
                    needsSave = true;
                } else if (currentStatus === 'safe' && prevStatus !== 'safe') {
                    // Update status if it became safe (restocked)
                    batch.lastAlertStatus = 'safe';
                    needsSave = true;
                }
            }
            if (needsSave) {
                updatePromises.push(batch.save());
            }
        }

        // 3. Send grouped emails
        if (outOfStockProducts.length > 0) {
            await sendInventoryAlertEmail(seller.email, seller.name, 'out_of_stock', outOfStockProducts)
                .catch(err => console.error('Error sending out_of_stock email:', err));
        }

        if (lowStockProducts.length > 0) {
            await sendInventoryAlertEmail(seller.email, seller.name, 'low_stock', lowStockProducts)
                .catch(err => console.error('Error sending low_stock email:', err));
        }

        if (expiringBatches.length > 0) {
            await sendInventoryAlertEmail(seller.email, seller.name, 'expiry', expiringBatches)
                .catch(err => console.error('Error sending expiry email:', err));
        }

        // Save all model updates (now guaranteed only one save per document)
        if (updatePromises.length > 0) {
            await Promise.all(updatePromises);
        }

        return {
            success: true,
            alertsSent: {
                outOfStock: outOfStockProducts.length,
                lowStock: lowStockProducts.length,
                expiry: expiringBatches.length
            }
        };

    } catch (error) {
        console.error('Error in checkAndSendInventoryAlerts:', error);
        return { success: false, error: error.message };
    }
};

module.exports = {
    checkAndSendInventoryAlerts
};
