const express = require('express');
const router = express.Router();
const { verifySeller, verifyCustomer } = require('../middleware/auth');
const onlineStoreController = require('../controllers/onlineStoreController');

// Public routes for customer facing store
router.get('/public/:slug', onlineStoreController.getPublicStore);
router.get('/public/:slug/products', onlineStoreController.getPublicProducts);
router.get('/public/:slug/manifest.json', onlineStoreController.getManifest);

// Order creation requires customer authentication
router.post('/public/:slug/order', verifyCustomer, onlineStoreController.createPublicOrder);

// Customer specific routes (Authenticated)
router.get('/customer/orders', verifyCustomer, onlineStoreController.getCustomerOrders);
router.get('/customer/orders/:orderId', verifyCustomer, onlineStoreController.getOrderDetail);

// Protected routes for store management
router.use(verifySeller);

router.get('/settings', onlineStoreController.getStoreSettings);
router.put('/settings', onlineStoreController.updateStoreSettings);
router.get('/orders', onlineStoreController.getOnlineOrders);
router.put('/orders/:orderId/status', onlineStoreController.updateOnlineOrderStatus);
router.put('/orders/:orderId/verify-delivery', onlineStoreController.verifyDeliveryToken);
router.get('/dashboard-stats', onlineStoreController.getDashboardStats);

module.exports = router;
