const mongoose = require('mongoose');

const CouponSchema = new mongoose.Schema({
    code: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true
    },
    discountType: {
        type: String,
        enum: ['percentage', 'flat'],
        required: true
    },
    discountValue: {
        type: Number,
        required: true
    },
    minPurchaseAmount: {
        type: Number,
        default: 0
    },
    maxDiscountAmount: {
        type: Number,
        default: null
    },
    expiryDate: {
        type: Date,
        required: true
    },
    usageLimit: {
        type: Number,
        default: null // null means unlimited
    },
    usedCount: {
        type: Number,
        default: 0
    },
    limitPerUser: {
        type: Number,
        default: 1 // default to 1 use per user
    },
    isActive: {
        type: Boolean,
        default: true
    },
    description: {
        type: String
    }
}, { timestamps: true });

// Method to check if coupon is valid
CouponSchema.methods.isValid = function (amount) {
    const now = new Date();

    if (!this.isActive) return { valid: false, message: 'Coupon is inactive' };
    if (this.expiryDate < now) return { valid: false, message: 'Coupon has expired' };
    if (this.usageLimit !== null && this.usedCount >= this.usageLimit) {
        return { valid: false, message: 'Coupon usage limit reached' };
    }
    if (amount < this.minPurchaseAmount) {
        return { valid: false, message: `Minimum purchase amount of ${this.minPurchaseAmount} required` };
    }

    return { valid: true };
};

// Method to calculate discount
CouponSchema.methods.calculateDiscount = function (amount) {
    let discount = 0;
    if (this.discountType === 'percentage') {
        discount = (amount * this.discountValue) / 100;
        if (this.maxDiscountAmount !== null && discount > this.maxDiscountAmount) {
            discount = this.maxDiscountAmount;
        }
    } else {
        discount = this.discountValue;
    }

    // Discount cannot be more than the amount
    return Math.min(discount, amount);
};

module.exports = mongoose.model('Coupon', CouponSchema);
