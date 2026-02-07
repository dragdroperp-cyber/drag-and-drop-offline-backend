const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema({
    sellerId: {
        type: String, // Storing as String to match other models' sellerId usage
        required: true,
        index: true
    },
    amount: {
        type: Number,
        required: true
    },
    category: {
        type: String,
        required: true,
        enum: ['Tea/Coffee', 'Cleaning', 'Utility', 'Transport', 'Maintenance', 'Salaries', 'Rent', 'Other'],
        default: 'Other'
    },
    description: {
        type: String,
        trim: true
    },
    date: {
        type: Date,
        default: Date.now,
        index: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    },
    localId: {
        type: String,
        required: false,
        index: true
    }
});

// Update timestamps on save
expenseSchema.pre('save', function (next) {
    this.updatedAt = Date.now();
    next();
});

const Expense = mongoose.model('Expense', expenseSchema);

module.exports = Expense;
