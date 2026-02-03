const express = require('express');
const router = express.Router();
const { setTarget, getTargets, getTodayTarget } = require('../controllers/targetController');
const { verifySeller } = require('../middleware/auth');

// All routes are protected
router.use(verifySeller);

router.post('/', setTarget);
router.get('/', getTargets);
router.get('/today', getTodayTarget);

module.exports = router;
