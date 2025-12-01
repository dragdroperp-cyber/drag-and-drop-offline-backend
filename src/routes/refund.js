const express = require('express');
const router = express.Router();
const { verifySeller } = require('../middleware/auth');
const refundController = require('../controllers/refund');

// All refund routes require authentication
router.use(verifySeller);

// Create refund
router.post('/create', refundController.createRefund);

// Get all refunds
router.get('/', refundController.getRefunds);

// Get refunds for a specific order
router.get('/order/:orderId', refundController.getOrderRefunds);

module.exports = router;

