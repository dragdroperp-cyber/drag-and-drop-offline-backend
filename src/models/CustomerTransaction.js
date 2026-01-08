const mongoose = require("mongoose");

const CustomerTransactionSchema = new mongoose.Schema({
    sellerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Seller",
        required: true,
        index: true
    },
    customerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Customer",
        required: true,
        index: true
    },
    orderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Order",
        default: null
    },
    type: {
        type: String,
        enum: ["payment", "due", "refund", "opening_balance", "settlement", "add_due", "remove_due", "credit_usage"],
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    date: {
        type: Date,
        default: Date.now
    },
    description: {
        type: String,
        default: ""
    },
    // For offline sync
    localId: {
        type: String,
        required: false,
        index: true
    },
    isDeleted: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

module.exports = mongoose.model("CustomerTransaction", CustomerTransactionSchema);
