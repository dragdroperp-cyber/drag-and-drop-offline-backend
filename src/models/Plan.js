const mongoose = require("mongoose");

const PlanSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    description: {
        type: String,
        required: true
    },
    price: {
        type: Number,
        required: true
    },
    fakePrice: {
        type: Number,
        default: 0
    },
    isPopular: {
        type: Boolean,
        default: false
    },
    isBestValue: {
        type: Boolean,
        default: false
    },
    durationDays: {
        type: Number,
        required: true
    },
    unlockedModules: {
        type: [String],
        default: []
    },
    lockedModules: {
        type: [String],
        default: []
    },
    // Limits
    maxCustomers: {
        type: Number,
        default: null
    },
    maxProducts: {
        type: Number,
        default: null
    },
    maxOrders: {
        type: Number,
        default: null
    },
    isActive: {
        type: Boolean,
        default: true
    },
    totalSales: {
        type: Number,
        default: 0
    },
    totalRevenue: {
        type: Number,
        default: 0
    },
    planType: {
        type: String,
        enum: ['mini', 'standard', 'pro'],
        default: 'standard'
    },
    isDeleted: {
        type: Boolean,
        default: false,
        index: true
    }

}, { timestamps: true });

module.exports = mongoose.model("Plan", PlanSchema);