const express = require('express');
const router = express.Router();
const { setTarget, getTargets, getTodayTarget } = require('../controllers/targetController');
const { verifySeller, verifySession } = require('../middleware/auth');

// All routes are protected and session-validated
router.use(verifySeller);
router.use(verifySession);

router.post('/', setTarget);
router.get('/', getTargets);
router.get('/today', getTodayTarget);

module.exports = router;
