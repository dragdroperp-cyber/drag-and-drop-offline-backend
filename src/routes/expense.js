const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expenseController');
const { verifySeller, verifySession } = require('../middleware/auth');
const validate = require('../middleware/validate');
const expenseSchemas = require('../validations/expense.validation');

// All routes are protected and session-validated
router.use(verifySeller);
router.use(verifySession);

router.post('/', validate(expenseSchemas.createExpense), expenseController.addExpense);
router.get('/', validate(expenseSchemas.queryExpenses, 'query'), expenseController.getExpenses);
router.delete('/:id', expenseController.deleteExpense);

module.exports = router;
