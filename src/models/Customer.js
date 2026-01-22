const mongoose = require("mongoose");
const CustomerSchema = new mongoose.Schema({
    sellerId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        ref: "Seller"
    },
    name: {
        type: String,
        required: true
    },
    dueAmount: {
        type: Number,
        default: 0
    },
    mobileNumber: {
        type: String,
    },
    email: {
        type: String,
    },
    gstNumber: {
        type: String,
        default: ''
    },
    isDeleted: {
        type: Boolean,
        default: false,
        index: true
    },
    localId: {
        type: String,
        required: false,
        index: true
    }

}, { timestamps: true });

// Ensure uniqueness of localId per seller to prevent race conditions
CustomerSchema.index({ sellerId: 1, localId: 1 }, {
    unique: true,
    partialFilterExpression: {
        localId: { $exists: true, $type: "string" } // Only index if localId exists and is a string
    }
});

module.exports = mongoose.model("Customer", CustomerSchema);