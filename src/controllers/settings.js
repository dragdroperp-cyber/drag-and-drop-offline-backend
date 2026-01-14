const SellerSettings = require('../models/SellerSettings');
const Seller = require('../models/Seller');

// Get settings for the authenticated seller
exports.getSettings = async (req, res) => {
    try {
        const sellerId = req.sellerId; // Assumes middleware sets this

        let settings = await SellerSettings.findOne({ sellerId });

        // If no settings exist, return defaults WITHOUT saving to DB
        if (!settings) {
            settings = {
                sellerId,
                billSettings: {
                    showHeader: true,
                    showFooter: true,
                    showLogo: true,
                    billFormat: 'A4',
                    accentColor: '#000000',
                    template: 'standard',
                    footerMessage: "Thank you, visit again"
                },
                reportSettings: {
                    includeCharts: true,
                    defaultDateRange: 'month',
                    exportFormat: 'pdf'
                },
                emailSettings: {
                    enableLowStockAlerts: true,
                    enableDailySummary: false,
                    alertThreshold: 10
                }
            };
        }

        res.status(200).json(settings);
    } catch (error) {
        console.error('Error fetching settings:', error);
        res.status(500).json({ message: 'Error fetching settings' });
    }
};

// Update settings
exports.updateSettings = async (req, res) => {
    try {
        const sellerId = req.sellerId;
        const updates = req.body;

        // Use findOneAndUpdate with upsert option to handle race conditions or missing docs safely
        const settings = await SellerSettings.findOneAndUpdate(
            { sellerId },
            {
                ...updates,
                sellerId, // Ensure sellerId is not overwritten
                updatedAt: new Date()
            },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );

        res.status(200).json(settings);
    } catch (error) {
        console.error('Error updating settings:', error);
        res.status(500).json({ message: 'Error updating settings' });
    }
};
