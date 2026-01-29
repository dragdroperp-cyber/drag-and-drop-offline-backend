const express = require('express');
const router = express.Router();

const { verifySeller } = require('../middleware/auth');
const planValidityController = require('../controllers/planValidity');

// Primary endpoints
router.post('/activate', verifySeller, planValidityController.activatePlan);
router.post('/switch', verifySeller, planValidityController.switchPlan);
router.post('/switch-to-valid', verifySeller, planValidityController.switchToValidPlan);
router.post('/reactivate-current', verifySeller, planValidityController.reactivateCurrentPlan);
router.get('/remaining', verifySeller, planValidityController.getRemainingValidity);
router.get('/usage', verifySeller, planValidityController.usageSummary);

// Convenience test endpoints (mirror primary ones)
router.post('/test/activate', verifySeller, planValidityController.activatePlan);
router.post('/test/switch', verifySeller, planValidityController.switchPlan);
router.post('/test/switch-to-valid', verifySeller, planValidityController.switchToValidPlan);
router.post('/test/reactivate-current', verifySeller, planValidityController.reactivateCurrentPlan);
router.get('/test/remaining', verifySeller, planValidityController.getRemainingValidity);
router.get('/test/usage', verifySeller, planValidityController.usageSummary);

module.exports = router;

