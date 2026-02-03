const mongoose = require("mongoose");
const ProductCategory = new mongoose.Schema({
    sellerId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        ref: "Seller"
    },
    name: {
        type: String,
        required: true
    },
    image: {
        type: String,
        default: ''
    },
    description: {
        type: String,
        default: ''
    },
    isActive: {
        type: Boolean,
        default: true
    },
    onlineSale: {
        type: Boolean,
        default: true
    },
    description: String,
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

module.exports = mongoose.model("ProductCategory", ProductCategory);