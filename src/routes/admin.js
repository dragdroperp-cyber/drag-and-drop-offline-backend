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
router.patch('/sellers/:id/status', adminAuth, adminController.toggleSellerStatus);
router.get('/requests', adminAuth, adminController.getRequestStats);
router.delete('/sellers/:id', adminAuth, adminController.deleteSeller);

// Plans
router.get('/plans', adminAuth, adminController.getPlans);
router.post('/plans', adminAuth, adminController.createPlan);
router.put('/plans/:id', adminAuth, adminController.updatePlan);
router.delete('/plans/:id', adminAuth, adminController.deletePlan);

// Coupons
router.get('/coupons', adminAuth, adminController.getCoupons);
router.post('/coupons', adminAuth, adminController.createCoupon);
router.put('/coupons/:id', adminAuth, adminController.updateCoupon);
router.delete('/coupons/:id', adminAuth, adminController.deleteCoupon);

// Shops
router.get('/shops', adminAuth, adminController.getShops);

module.exports = router;
