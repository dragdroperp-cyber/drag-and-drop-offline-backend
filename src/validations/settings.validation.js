const Joi = require('joi');

const settingsSchemas = {
    updateSettings: Joi.object({
        billSettings: Joi.object({
            showHeader: Joi.boolean(),
            showFooter: Joi.boolean(),
            showLogo: Joi.boolean(),
            billFormat: Joi.string().valid('A4', '58mm', '80mm'),
            accentColor: Joi.string().regex(/^#[0-9A-Fa-f]{6}$/),
            template: Joi.string(),
            footerMessage: Joi.string().allow('', null)
        }),
        reportSettings: Joi.object({
            includeCharts: Joi.boolean(),
            defaultDateRange: Joi.string(),
            exportFormat: Joi.string().valid('pdf', 'csv', 'excel')
        }),
        emailSettings: Joi.object({
            enableLowStockAlerts: Joi.boolean(),
            enableDailySummary: Joi.boolean(),
            alertThreshold: Joi.number().min(0)
        })
    }).unknown(true)
};

module.exports = settingsSchemas;
