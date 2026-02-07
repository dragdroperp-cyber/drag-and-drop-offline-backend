const express = require('express');
const router = express.Router();
const { verifySeller, verifySession } = require('../middleware/auth');
const dataController = require('../controllers/data');

// Plans endpoint - public (no authentication required)
// Plans endpoint - authenticated to include usage data
router.get('/plans', verifySeller, verifySession, dataController.getPlans);

// All other data routes require authentication and session validation
router.use(verifySeller);
router.use(verifySession);

// GET endpoints
router.get('/customers', dataController.getCustomers);
router.get('/suppliers', dataController.getSuppliers);
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
router.put('/product-batches/:id', dataController.checkPlanForOperations, dataController.updateProductBatch);
router.delete('/product-batches/:id', dataController.checkPlanForOperations, dataController.deleteProductBatch);

// Seller settings
router.get('/seller/profile', dataController.getSellerProfile);
router.put('/seller/settings', dataController.checkPlanForOperations, dataController.updateSellerSettings);

// POST endpoints
router.post('/product-batches', dataController.checkPlanForOperations, dataController.createProductBatch);
router.post('/plans/upgrade', dataController.upgradePlan);
router.post('/plans/create-razorpay-order', dataController.createRazorpayOrder);
router.post('/plans/verify-razorpay-payment', dataController.verifyRazorpayPayment);
router.post('/plans/validate-coupon', dataController.validateCoupon);
router.get('/plans/coupons', dataController.getCoupons);
router.post('/delta-sync', dataController.getDeltaSync);
router.post('/latest-fetch', dataController.getLatestData);
router.get('/fetch-latest', dataController.fetchLatestData);



module.exports = router;

