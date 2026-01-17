const mongoose = require('mongoose');

const dProductSchema = new mongoose.Schema({
    sellerId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        ref: 'Seller',
        index: true
    },
    pCode: {
        type: String,
        required: true,
        trim: true
    },
    productName: {
        type: String,
        required: true,
        trim: true
    },
    unit: {
        type: String,
        required: true,
        default: 'PCS' // Default unit
    },
    taxPercentage: {
        type: Number,
        required: true,
        default: 0
    },
    isActive: {
        type: Boolean,
        default: true,
        index: true
    },
    localId: {
        type: String,
        index: true
    },
    isDeleted: {
        type: Boolean,
        default: false,
        index: true
    },
    isSynced: {
        type: Boolean,
        default: false,
        index: true
    }
}, {
    timestamps: true
});

// Compound index to ensure unique pCode per seller
dProductSchema.index({ sellerId: 1, pCode: 1 }, { unique: true });

const DProduct = mongoose.model('DProduct', dProductSchema);

module.exports = DProduct;
