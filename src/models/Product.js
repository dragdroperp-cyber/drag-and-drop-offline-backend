const mongoose = require("mongoose");
const ProductSchema = new mongoose.Schema({
    sellerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Seller",
        required: true
    },
    name: {
        type: String,
        required: true
    },
    barcode: {
        type: String,
        required: false,
        default: ''
    },
    categoryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ProductCategory",
    },
    categoryLocalId: {
        type: String,
        required: false
    },
    categoryMongoId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ProductCategory",
        required: false
    },
    unit: {
        type: String,
        required: true
    },
    lowStockLevel: {
        type: Number,
        default: 10
    },
    trackExpiry: {
        type: Boolean,
        default: false
    },
    description: {
        type: String,
        required: false,
        default: ''
    },
    isActive: {
        type: Boolean,
        default: false
    },
    isDeleted: {
        type: Boolean,
        default: false,
        index: true
    },
    // Store the original local/frontend generated ID for mapping product batches
    localId: {
        type: String,
        required: false,
        index: true
    },
    lastLowStockAlertSentAt: {
        type: Date,
        default: null
    },
    lastOutOfStockAlertSentAt: {
        type: Date,
        default: null
    },
    hsnCode: {
        type: String,
        default: ''
    },
    gstPercent: {
        type: Number,
        default: 0
    },
    isGstInclusive: {
        type: Boolean,
        default: true
    },
    wholesalePrice: {
        type: Number,
        default: 0
    },
    wholesaleMOQ: {
        type: Number,
        default: 1
    }



}, { timestamps: true });

// Ensure uniqueness of localId per seller to prevent race conditions
ProductSchema.index({ sellerId: 1, localId: 1 }, {
    unique: true,
    partialFilterExpression: {
        localId: { $exists: true, $type: "string" }
    }
});

module.exports = mongoose.model("Product", ProductSchema);