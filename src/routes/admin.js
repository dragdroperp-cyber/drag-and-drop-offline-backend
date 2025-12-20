const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const adminAuth = require('../middleware/adminAuth');

router.post('/login', adminController.login);
router.get('/dashboard', adminAuth, adminController.getDashboardStats);
router.get('/financial', adminAuth, adminController.getFinancialStats);
router.get('/system-status', adminAuth, adminController.getSystemStatus);
router.get('/sellers', adminAuth, adminController.getSellers);
router.get('/sellers/:id', adminAuth, adminController.getSellerDetails);

// Plans
router.get('/plans', adminAuth, adminController.getPlans);
router.post('/plans', adminAuth, adminController.createPlan);
router.put('/plans/:id', adminAuth, adminController.updatePlan);
router.delete('/plans/:id', adminAuth, adminController.deletePlan);

module.exports = router;
