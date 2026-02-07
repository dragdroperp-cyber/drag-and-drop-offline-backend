const express = require('express');
const router = express.Router();
const publicController = require('../controllers/publicController');

router.post('/bill/verify', publicController.verifyAndGetBill);

module.exports = router;
