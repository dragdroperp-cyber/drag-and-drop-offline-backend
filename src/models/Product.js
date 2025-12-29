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