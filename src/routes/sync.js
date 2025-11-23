const express = require('express');
const router = express.Router();
const { verifySeller } = require('../middleware/auth');
const syncController = require('../controllers/sync');
const incrementalSyncController = require('../controllers/incrementalSync');

// All sync routes require authentication
router.use(verifySeller);

// Specific routes first (before dynamic route)
router.get('/status', syncController.getSyncStatus);

// Sync endpoints (for pushing data from frontend)
router.post('/customers', syncController.syncCustomers);
router.post('/products', syncController.syncProducts);
router.post('/orders', syncController.syncOrders);
router.post('/transactions', syncController.syncTransactions);
router.post('/vendor-orders', syncController.syncVendorOrders);
router.post('/categories', syncController.syncCategories);
router.post('/refunds', syncController.syncRefunds);


// Universal incremental sync endpoint (dynamic - must be last)
router.get('/:collection', incrementalSyncController.incrementalSync);

module.exports = router;

