const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settings');
const { verifySeller, verifySession } = require('../middleware/auth');
const validate = require('../middleware/validate');
const settingsSchemas = require('../validations/settings.validation');

// All routes require authentication and valid session
router.use(verifySeller);
router.use(verifySession);

router.get('/', settingsController.getSettings);
router.put('/', validate(settingsSchemas.updateSettings), settingsController.updateSettings);

module.exports = router;
