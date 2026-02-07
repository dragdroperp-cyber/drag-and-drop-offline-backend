const express = require('express');
const router = express.Router();
const { verifySeller, verifySession } = require('../middleware/auth');
const syncController = require('../controllers/sync');
const incrementalSyncController = require('../controllers/incrementalSync');

// All sync routes require authentication and valid session
router.use(verifySeller);
router.use(verifySession);

const validate = require('../middleware/validate');
const syncSchemas = require('../validations/sync.validation');
const dataController = require('../controllers/data');

// Specific routes first (before dynamic route)
router.get('/status', syncController.getSyncStatus);

// Sync endpoints (for pushing data from frontend) - all require valid plan
router.post('/customers', validate(syncSchemas.syncWrapper), dataController.checkPlanForOperations, syncController.syncCustomers);
router.post('/suppliers', validate(syncSchemas.syncWrapper), dataController.checkPlanForOperations, syncController.syncSuppliers);
router.post('/products', validate(syncSchemas.syncWrapper), dataController.checkPlanForOperations, syncController.syncProducts);
router.post('/product-batches', validate(syncSchemas.syncWrapper), dataController.checkPlanForOperations, syncController.syncProductBatches);
router.post('/orders', validate(syncSchemas.syncWrapper), dataController.checkPlanForOperations, syncController.syncOrders);
router.post('/transactions', validate(syncSchemas.syncWrapper), dataController.checkPlanForOperations, syncController.syncTransactions);
router.post('/vendor-orders', validate(syncSchemas.syncWrapper), dataController.checkPlanForOperations, syncController.syncVendorOrders);
router.post('/categories', validate(syncSchemas.syncWrapper), dataController.checkPlanForOperations, syncController.syncCategories);
router.post('/refunds', validate(syncSchemas.syncWrapper), dataController.checkPlanForOperations, syncController.syncRefunds);
router.post('/expenses', validate(syncSchemas.syncWrapper), dataController.checkPlanForOperations, syncController.syncExpenses);
router.post('/settings', validate(syncSchemas.syncWrapper), syncController.syncSettings);
router.post('/d-products', validate(syncSchemas.syncWrapper), dataController.checkPlanForOperations, syncController.syncDProducts);
router.post('/targets', validate(syncSchemas.syncWrapper), dataController.checkPlanForOperations, syncController.syncTargets);


// Universal incremental sync endpoint (dynamic - must be last)
router.get('/:collection', incrementalSyncController.incrementalSync);

module.exports = router;

