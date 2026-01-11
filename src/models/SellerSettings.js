const mongoose = require('mongoose');

const SellerSettingsSchema = new mongoose.Schema({
    sellerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Seller',
        required: true,
        unique: true
    },
    billSettings: {
        showHeader: { type: Boolean, default: true },
        showFooter: { type: Boolean, default: true },
        showLogo: { type: Boolean, default: true },
        billFormat: { type: String, enum: ['A4', '80mm', '58mm'], default: 'A4' },
        accentColor: { type: String, default: '#000000' },
        template: { type: String, default: 'standard' },
        layout: { type: String, default: 'standard' },
        footerMessage: { type: String, default: 'Thank you, visit again' },
        termsAndConditions: { type: String, default: '' },
        showAddress: { type: Boolean, default: true },
        showStoreName: { type: Boolean, default: true }
    },
    reportSettings: {
        includeCharts: { type: Boolean, default: true },
        defaultDateRange: { type: String, default: 'month' }, // month, week, today
        exportFormat: { type: String, default: 'pdf' }, // pdf, csv
        chartType: { type: String, default: 'bar' }, // bar, line, pie
        themeColor: { type: String, default: '#4F46E5' },
        density: { type: String, default: 'comfortable' } // compact, comfortable
    },
    emailSettings: {
        enableLowStockAlerts: { type: Boolean, default: true },
        enableDailySummary: { type: Boolean, default: false },
        alertThreshold: { type: Number, default: 10 },
        alertFrequency: { type: String, default: 'daily' }, // immediate, daily, weekly
        recipients: [{ type: String }] // List of email addresses
    },
    isSynced: {
        type: Boolean,
        default: true
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

// Ensure one settings doc per seller is enforced at DB level
SellerSettingsSchema.index({ sellerId: 1 }, { unique: true });

module.exports = mongoose.model('SellerSettings', SellerSettingsSchema);
