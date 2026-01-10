const Joi = require('joi');

const syncSchemas = {
    // Wrapper for all sync endpoints that expect { items: [...] }
    syncWrapper: Joi.object({
        items: Joi.array().required()
    }),

    // Individual item schemas for validation within the array
    customer: Joi.object({
        id: Joi.string().allow('', null),
        _id: Joi.string().allow('', null),
        name: Joi.string().required().trim(),
        mobileNumber: Joi.string().allow('', null),
        phone: Joi.string().allow('', null),
        email: Joi.string().email().allow('', null),
        address: Joi.string().allow('', null),
        dueAmount: Joi.number().default(0),
        isDeleted: Joi.boolean()
    }).unknown(true),

    product: Joi.object({
        id: Joi.string().allow('', null),
        _id: Joi.string().allow('', null),
        name: Joi.string().required().trim(),
        barcode: Joi.string().allow('', null),
        category: Joi.string().allow('', null),
        categoryId: Joi.string().allow('', null),
        unit: Joi.string().allow('', null),
        costPrice: Joi.number().min(0),
        sellingUnitPrice: Joi.number().min(0),
        trackExpiry: Joi.boolean(),
        isActive: Joi.boolean(),
        isDeleted: Joi.boolean()
    }).unknown(true),

    order: Joi.object({
        id: Joi.string().required(),
        _id: Joi.string().allow('', null),
        customerId: Joi.string().allow('', null),
        items: Joi.array().items(Joi.object({
            productId: Joi.string().required(),
            quantity: Joi.number().required().positive(),
            sellingPrice: Joi.number().required().min(0)
        }).unknown(true)).required(),
        totalAmount: Joi.number().required().min(0),
        paymentMethod: Joi.string().required(),
        isDeleted: Joi.boolean()
    }).unknown(true)
};

module.exports = syncSchemas;
