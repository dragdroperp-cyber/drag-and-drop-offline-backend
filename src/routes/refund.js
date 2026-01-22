const express = require('express');
const router = express.Router();
const { verifySeller } = require('../middleware/auth');
const refundController = require('../controllers/refund');
const validate = require('../middleware/validate');
const refundSchemas = require('../validations/refund.validation');

// All refund routes require authentication
router.use(verifySeller);

// Create refund
router.post('/create', validate(refundSchemas.createRefund), refundController.createRefund);

// Get all refunds
router.get('/', refundController.getRefunds);

// Get refunds for a specific order
router.get('/order/:orderId', refundController.getOrderRefunds);

module.exports = router;

