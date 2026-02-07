const mongoose = require("mongoose");

const EcomCustomerSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },
    email: {
        type: String,
        required: true,
        unique: true,
    },
    phoneNumber: {
        type: String,
        required: false,
        default: null
    },
    defaultAddress: {
        type: String,
        required: false,
        default: null
    },
    password: {
        type: String,
        required: false,
        default: null
    },
    profilePicture: {
        type: String,
        required: false,
        default: null
    },
    isActive: {
        type: Boolean,
        default: true
    },
    firebaseUid: {
        type: String,
        required: false,
        default: null
    },
    sellerCustomers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "Seller"
    }],
    lastActivityDate: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

EcomCustomerSchema.index({ email: 1 }, { unique: true });

module.exports = mongoose.model("EcomCustomer", EcomCustomerSchema);
