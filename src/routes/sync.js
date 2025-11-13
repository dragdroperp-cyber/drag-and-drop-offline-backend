const express = require('express');
const router = express.Router();
const { verifySeller } = require('../middleware/auth');
const syncController = require('../controllers/sync');

// All sync routes require authentication
router.use(verifySeller);

// Sync endpoints
router.post('/customers', syncController.syncCustomers);
router.post('/products', syncController.syncProducts);
router.post('/orders', syncController.syncOrders);
router.post('/transactions', syncController.syncTransactions);
router.post('/vendor-orders', syncController.syncVendorOrders);
router.post('/categories', syncController.syncCategories);

// Batch sync endpoint
router.post('/batch', syncController.batchSync);

// Get sync status
router.get('/status', syncController.getSyncStatus);

module.exports = router;

