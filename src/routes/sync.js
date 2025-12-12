const express = require('express');
const router = express.Router();
const { verifySeller } = require('../middleware/auth');
const syncController = require('../controllers/sync');
const incrementalSyncController = require('../controllers/incrementalSync');

// All sync routes require authentication
router.use(verifySeller);

// Import plan validation middleware
const dataController = require('../controllers/data');

// Specific routes first (before dynamic route)
router.get('/status', syncController.getSyncStatus);

// Sync endpoints (for pushing data from frontend) - all require valid plan
router.post('/customers', dataController.checkPlanForOperations, syncController.syncCustomers);
router.post('/products', dataController.checkPlanForOperations, syncController.syncProducts);
router.post('/product-batches', dataController.checkPlanForOperations, syncController.syncProductBatches);
router.post('/orders', dataController.checkPlanForOperations, syncController.syncOrders);
router.post('/transactions', dataController.checkPlanForOperations, syncController.syncTransactions);
router.post('/vendor-orders', dataController.checkPlanForOperations, syncController.syncVendorOrders);
router.post('/categories', dataController.checkPlanForOperations, syncController.syncCategories);
router.post('/refunds', dataController.checkPlanForOperations, syncController.syncRefunds);


// Universal incremental sync endpoint (dynamic - must be last)
router.get('/:collection', incrementalSyncController.incrementalSync);

module.exports = router;

