const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settings');
const { verifySeller } = require('../middleware/auth'); // Assuming auth middleware exists

// All routes require authentication
router.use(verifySeller);

router.get('/', settingsController.getSettings);
router.put('/', settingsController.updateSettings);

module.exports = router;
