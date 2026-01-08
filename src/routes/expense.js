const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expenseController');
const { verifySeller } = require('../middleware/auth');

// All routes are protected
router.use(verifySeller);

router.post('/', expenseController.addExpense);
router.get('/', expenseController.getExpenses);
router.delete('/:id', expenseController.deleteExpense);

module.exports = router;
