const Joi = require('joi');

const expenseSchemas = {
    createExpense: Joi.object({
        amount: Joi.number().required().positive(),
        category: Joi.string().required().trim(),
        description: Joi.string().allow('', null).trim(),
        date: Joi.date().allow(null)
    }),

    queryExpenses: Joi.object({
        startDate: Joi.date().iso(),
        endDate: Joi.date().iso().min(Joi.ref('startDate'))
    })
};

module.exports = expenseSchemas;
