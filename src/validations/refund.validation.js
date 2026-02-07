const Joi = require('joi');

const refundSchemas = {
    createRefund: Joi.object({
        orderId: Joi.string().required(),
        reason: Joi.string().allow('', null).trim(),
        items: Joi.array().items(Joi.object({
            productId: Joi.string().required(),
            qty: Joi.number().required().positive()
        })).min(1).required()
    })
};

module.exports = refundSchemas;
