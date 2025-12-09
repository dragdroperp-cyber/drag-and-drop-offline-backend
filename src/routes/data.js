const express = require('express');
const router = express.Router();
const { verifySeller } = require('../middleware/auth');
const dataController = require('../controllers/data');

// Plans endpoint - public (no authentication required)
router.get('/plans', dataController.getPlans);

// All other data routes require authentication
router.use(verifySeller);

// GET endpoints
router.get('/customers', dataController.getCustomers);
router.get('/products', dataController.getProducts);
router.get('/product-batches', dataController.getProductBatches);
router.get('/orders', dataController.getOrders);
router.get('/transactions', dataController.getTransactions);
router.get('/vendor-orders', dataController.getVendorOrders);
router.get('/categories', dataController.getCategories);
router.post('/all', dataController.getAllData);
router.get('/current-plan', dataController.getCurrentPlan);
router.get('/sync-tracking', dataController.getSyncTracking);

// Product batch operations
router.put('/product-batches/:id', dataController.updateProductBatch);
router.delete('/product-batches/:id', dataController.deleteProductBatch);

// Seller settings
router.get('/seller/profile', dataController.getSellerProfile);
router.put('/seller/settings', dataController.updateSellerSettings);

// POST endpoints
router.post('/product-batches', dataController.createProductBatch);
router.post('/plans/upgrade', dataController.upgradePlan);
router.post('/plans/create-razorpay-order', dataController.createRazorpayOrder);
router.post('/plans/verify-razorpay-payment', dataController.verifyRazorpayPayment);
router.post('/delta-sync', dataController.getDeltaSync);
router.post('/latest-fetch', dataController.getLatestData);
router.get('/fetch-latest', dataController.fetchLatestData);

// GET endpoints
router.get('/plan-orders', dataController.getPlanOrders);

module.exports = router;

