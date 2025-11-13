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
router.get('/orders', dataController.getOrders);
router.get('/transactions', dataController.getTransactions);
router.get('/vendor-orders', dataController.getVendorOrders);
router.get('/categories', dataController.getCategories);
router.get('/all', dataController.getAllData);
router.get('/current-plan', dataController.getCurrentPlan);

// Seller settings
router.get('/seller/profile', dataController.getSellerProfile);
router.put('/seller/settings', dataController.updateSellerSettings);

// POST endpoints
router.post('/plans/upgrade', dataController.upgradePlan);
router.post('/plans/create-razorpay-order', dataController.createRazorpayOrder);
router.post('/plans/verify-razorpay-payment', dataController.verifyRazorpayPayment);

module.exports = router;

