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

    isDeleted: {

        type: Boolean,

        default: false

    }

}, { timestamps: true });

module.exports = mongoose.model("ProductBatch", ProductBatchSchema);
