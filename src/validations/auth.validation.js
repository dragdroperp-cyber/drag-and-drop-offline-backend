const Joi = require('joi');

const authSchemas = {
    // Seller registration/login schema
    sellerAuth: Joi.object({
        email: Joi.string().email().required().lowercase().trim(),
        uid: Joi.string().required(),
        displayName: Joi.string().allow('', null),
        photoURL: Joi.string().uri().allow('', null)
    }),

    // Profile update schema
    updateProfile: Joi.object({
        shopName: Joi.string().required().min(3).max(100).trim(),
        businessType: Joi.string().required().trim(),
        shopAddress: Joi.string().required().min(5).max(500).trim(),
        phoneNumber: Joi.string().regex(/^[0-9]{10}$/).required().messages({
            'string.pattern.base': 'Phone number must be exactly 10 digits'
        }),
        city: Joi.string().required().trim(),
        state: Joi.string().required().trim(),
        pincode: Joi.string().regex(/^[0-9]{6}$/).required().messages({
            'string.pattern.base': 'Pincode must be exactly 6 digits'
        }),
        upiId: Joi.string().required().trim(),
        gstNumber: Joi.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/).allow(null, '').messages({
            'string.pattern.base': 'Invalid GST number format'
        }),
        gender: Joi.string().required().trim(),
        whatsappLink: Joi.string().allow(null, '').trim(),
        logoUrl: Joi.string().allow(null, '').trim(),
        sellerId: Joi.string().allow(null, '').trim()
    }).unknown(true)
};

module.exports = authSchemas;
