const Target = require('../models/Target');
const Order = require('../models/Order');
const SyncTracking = require('../models/SyncTracking');

// Helper to normalize date to start of day UTC or matching the way dates are stored for queries
// We'll store dates as YYYY-MM-DD 00:00:00.000 Z to avoid timezone confusion for daily targets
const normalizeDate = (dateInfo) => {
    const d = new Date(dateInfo);
    d.setUTCHours(0, 0, 0, 0);
    return d;
};

// Set or Update Target for a specific date (defaults to today)
exports.setTarget = async (req, res) => {
    try {
        const { targetAmount, date } = req.body;
        const sellerId = req.sellerId; // From auth middleware

        console.log(`[Target] Setting target: Amount=${targetAmount}, Date=${date}, SellerId=${sellerId}`);

        if (targetAmount === undefined || targetAmount < 0) {
            console.warn('[Target] Invalid target amount');
            return res.status(400).json({ success: false, message: 'Invalid target amount' });
        }

        const targetDate = date ? normalizeDate(date) : normalizeDate(new Date());
        console.log(`[Target] Normalized Date: ${targetDate}`);

        const target = await Target.findOneAndUpdate(
            { sellerId, date: targetDate },
            {
                $set: { targetAmount },
                $setOnInsert: { sellerId, date: targetDate }
            },
            { new: true, upsert: true } // Create if not exists
        );

        // Update SyncTracking for delta sync
        await SyncTracking.updateLatestTime(sellerId, 'targets');

        console.log('[Target] Target saved successfully:', target);
        res.json({ success: true, data: target, message: 'Sales target set successfully' });
    } catch (error) {
        console.error('Error setting target:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
};

// Get Targets history with progress
exports.getTargets = async (req, res) => {
    try {
        const sellerId = req.sellerId;
        const { startDate, endDate } = req.query;

        let query = { sellerId };

        // Date Filtering
        if (startDate || endDate) {
            query.date = {};
            if (startDate) query.date.$gte = normalizeDate(startDate);
            if (endDate) query.date.$lte = normalizeDate(endDate);
        }

        // Limit to last 30 days if no range specified to avoid huge payloads
        if (!startDate && !endDate) {
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            query.date = { $gte: normalizeDate(thirtyDaysAgo) };
        }

        const targets = await Target.find(query).sort({ date: -1 });

        // Calculate achievement for each target
        // We need to aggregate orders for those days
        // This could be expensive. 
        // Optimization: If we just need the list of targets, we return targets.
        // If the frontend needs "progress", it might already have the orders in state (since it loads orders).
        // However, for "History" page, fetching all historical orders might not be optimal on frontend.
        // Let's do a simple aggregation here to get total sales per day for the requested range.

        // Find all orders for this seller in the date match range
        const orders = await Order.find({
            sellerId,
            createdAt: {
                $gte: query.date?.$gte || new Date(0),
                $lte: query.date?.$lte || new Date()
            },
            isDeleted: { $ne: true }
        }).select('totalAmount createdAt date');

        // Map orders to days
        const salesMap = {};
        orders.forEach(order => {
            const d = normalizeDate(order.createdAt || order.date).toISOString();
            salesMap[d] = (salesMap[d] || 0) + (order.totalAmount || 0);
        });

        const results = targets.map(t => {
            const dStr = t.date.toISOString();
            const achieved = salesMap[dStr] || 0;
            return {
                _id: t._id,
                date: t.date,
                targetAmount: t.targetAmount,
                achievedAmount: achieved,
                status: achieved >= t.targetAmount ? 'Met' : 'Pending', // Simple status
                percentage: t.targetAmount > 0 ? (achieved / t.targetAmount) * 100 : 0
            };
        });

        res.json({ success: true, data: results });
    } catch (error) {
        console.error('Error getting targets:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Get Today's Target specifically (fast endpoint)
exports.getTodayTarget = async (req, res) => {
    try {
        const sellerId = req.sellerId;
        const today = normalizeDate(new Date());

        const target = await Target.findOne({ sellerId, date: today });

        res.json({ success: true, data: target });
    } catch (error) {
        console.error('Error getting today target:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
}
