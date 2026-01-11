const Joi = require('joi');
const { logSecurityEvent } = require('../utils/securityLogger');

/**
 * Higher-order function to create a validation middleware
 * @param {Object} schema - Joi schema object
 * @param {String} property - Request property to validate (body, query, params)
 */
const validate = (schema, property = 'body') => {
    return (req, res, next) => {
        const { error } = schema.validate(req[property], {
            abortEarly: false,
            stripUnknown: true
        });

        if (error) {
            const { details } = error;
            const message = details.map(i => i.message).join(',');

            // Log security event (potential injection or malformed request)
            logSecurityEvent({
                sellerId: req.sellerId,
                event: 'MALICIOUS_INPUT',
                message: `Validation failed for ${req.originalUrl}: ${message}`,
                req,
                severity: 'MEDIUM',
                metadata: {
                    errors: details.map(d => ({ field: d.path[0], message: d.message })),
                    receivedInput: req[property]
                }
            });

            return res.status(400).json({
                success: false,
                message: 'Invalid input data',
                details: details.map(d => ({
                    field: d.path[0],
                    message: d.message
                }))
            });
        }
        next();
    };
};

module.exports = validate;
