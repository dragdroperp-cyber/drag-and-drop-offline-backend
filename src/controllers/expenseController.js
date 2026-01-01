const Expense = require('../models/Expense');
const SyncTracking = require('../models/SyncTracking');

// Add a new expense
exports.addExpense = async (req, res) => {
    try {
        const { amount, category, description, date } = req.body;
        const sellerId = req.sellerId;

        if (!amount) {
            return res.status(400).json({ success: false, message: 'Amount is required' });
        }

        const newExpense = new Expense({
            sellerId,
            amount,
            category,
            description,
            date: date || new Date()
        });

        await newExpense.save();

        // Update sync tracking
        try {
            await SyncTracking.updateLatestTime(sellerId, 'expenses');
        } catch (trackingError) {
            console.error('Error updating sync tracking for expenses:', trackingError);
        }

        res.status(201).json({
            success: true,
            data: newExpense,
            message: 'Expense added successfully'
        });
    } catch (error) {
        console.error('Error adding expense:', error);
        res.status(500).json({ success: false, message: 'Server error adding expense' });
    }
};

// Get expenses with optional date range filter
exports.getExpenses = async (req, res) => {
    try {
        const sellerId = req.sellerId;
        const { startDate, endDate } = req.query;

        let query = { sellerId };

        if (startDate && endDate) {
            query.date = {
                $gte: new Date(startDate),
                $lte: new Date(endDate)
            };
        }

        const expenses = await Expense.find(query).sort({ date: -1 });

        res.status(200).json({
            success: true,
            data: expenses
        });
    } catch (error) {
        console.error('Error fetching expenses:', error);
        res.status(500).json({ success: false, message: 'Server error fetching expenses' });
    }
};

// Delete an expense
exports.deleteExpense = async (req, res) => {
    try {
        const { id } = req.params;
        const sellerId = req.sellerId;

        const expense = await Expense.findOneAndDelete({ _id: id, sellerId });

        if (!expense) {
            return res.status(404).json({ success: false, message: 'Expense not found or unauthorized' });
        }

        // Update sync tracking
        try {
            await SyncTracking.updateLatestTime(sellerId, 'expenses');
        } catch (trackingError) {
            console.error('Error updating sync tracking for expenses:', trackingError);
        }

        res.status(200).json({
            success: true,
            message: 'Expense deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting expense:', error);
        res.status(500).json({ success: false, message: 'Server error deleting expense' });
    }
};
