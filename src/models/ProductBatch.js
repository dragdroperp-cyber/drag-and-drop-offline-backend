const mongoose = require("mongoose");

const ProductBatchSchema = new mongoose.Schema({

    sellerId: {

        type: mongoose.Schema.Types.ObjectId,

        ref: "Seller",

        required: true

    },

    productId: {

        type: mongoose.Schema.Types.ObjectId,

        ref: "Product",

        required: true

    },

    batchNumber: {

        type: String,

        required: false,

        default: ""

    },

    mfg: {

        type: Date,

        required: false

    },

    expiry: {

        type: Date,

        required: false

    },

    quantity: {                 // MAIN field

        type: Number,

        required: true

    },

    costPrice: {

        type: Number,

        required: true

    },

    sellingUnitPrice: {
        type: Number,
        required: true
    },
    productLocalId: {
        type: String,
        required: false
    },
    productMongoId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
        required: false
    },
    wholesalePrice: {
        type: Number,
        default: 0
    },
    wholesaleMOQ: {
        type: Number,
        default: 1
    },


    isDeleted: {

        type: Boolean,

        default: false

    },

    localId: {

        type: String,

        required: false,

        index: true

    },
    lastExpiryAlertSentAt: {
        type: Date,
        default: null
    },
    lastAlertStatus: {
        type: String,
        enum: ['safe', 'warning', 'critical'],
        default: 'safe'
    }

}, { timestamps: true });

// Optimized indexes for expiry alerts and general queries
ProductBatchSchema.index({ sellerId: 1, isDeleted: 1 });
ProductBatchSchema.index({ expiry: 1, quantity: 1 });
ProductBatchSchema.index({ sellerId: 1, productId: 1 });

module.exports = mongoose.model("ProductBatch", ProductBatchSchema);
