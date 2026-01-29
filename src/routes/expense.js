const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expenseController');
const { verifySeller } = require('../middleware/auth');
const validate = require('../middleware/validate');
const expenseSchemas = require('../validations/expense.validation');

// All routes are protected
router.use(verifySeller);

router.post('/', validate(expenseSchemas.createExpense), expenseController.addExpense);
router.get('/', validate(expenseSchemas.queryExpenses, 'query'), expenseController.getExpenses);
router.delete('/:id', expenseController.deleteExpense);

module.exports = router;
