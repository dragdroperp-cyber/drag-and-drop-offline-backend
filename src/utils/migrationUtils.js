const Seller = require('../models/Seller');
const SellerSettings = require('../models/SellerSettings');

/**
 * Backfills SellerSettings for all existing sellers who don't have one.
 */
exports.backfillSellerSettings = async () => {
    try {
        // console.log('🔄 Starting SellerSettings backfill...');

        // 1. Get all sellers
        const sellers = await Seller.find({}, '_id');
        // console.log(`📋 Found ${sellers.length} sellers in database.`);

        let createdCount = 0;
        let skippedCount = 0;

        // 2. Iterate and check/create settings
        for (const seller of sellers) {
            const existingSettings = await SellerSettings.findOne({ sellerId: seller._id });

            if (!existingSettings) {
                // Create default settings
                const newSettings = new SellerSettings({
                    sellerId: seller._id,
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
                        exportFormat: 'pdf',
                        chartType: 'bar',
                        themeColor: '#4F46E5',
                        density: 'comfortable'
                    },
                    emailSettings: {
                        enableLowStockAlerts: true,
                        enableDailySummary: false,
                        alertThreshold: 10
                    }
                });

                await newSettings.save();
                createdCount++;
                // console.log(`✅ Created settings for seller ${seller._id}`);
            } else {
                skippedCount++;
            }
        }

        // console.log(`🏁 Backfill complete. Created: ${createdCount}, Skipped: ${skippedCount}`);
    } catch (error) {
        console.error('❌ Error during SellerSettings backfill:', error);
    }
};
