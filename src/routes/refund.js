const express = require('express');
const router = express.Router();
const { verifySeller, verifySession } = require('../middleware/auth');
const refundController = require('../controllers/refund');
const validate = require('../middleware/validate');
const refundSchemas = require('../validations/refund.validation');

// All refund routes require authentication and valid session
router.use(verifySeller);
router.use(verifySession);

// Create refund
router.post('/create', validate(refundSchemas.createRefund), refundController.createRefund);

// Get all refunds
router.get('/', refundController.getRefunds);

// Get refunds for a specific order
router.get('/order/:orderId', refundController.getOrderRefunds);

module.exports = router;

