const mongoose = require("mongoose");
const OrderSchema = new mongoose.Schema({
    sellerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Seller",
        required: true
    },
    customerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Customer"
    },
    customerName: {
        type: String,
        default: ''
    },
    customerMobile: {
        type: String,
        default: ''
    },
    paymentMethod: {
        type: String,
        enum: ["cash", "card", "upi", "due", "credit", "split"],
        required: true,
        default: "cash"
    },
    splitPaymentDetails: {
        type: {
            type: String,
            default: null,
            validate: {
                validator: function (value) {
                    // Allow null/undefined values - they will be handled by pre-save hook
                    if (value === null || value === undefined) {
                        return true;
                    }
                    // Validate enum values
                    return ["cash_online", "online_due", "cash_due", "cash_online_due", "credit_due", "cash_credit", "online_credit", "cash_online_credit", "cash_credit_due", "online_credit_due", "cash_online_credit_due", "credit_only"].includes(value);
                },
                message: 'Type not supported'
            }
        },
        cashAmount: {
            type: Number,
            default: 0
        },
        onlineAmount: {
            type: Number,
            default: 0
        },
        creditAmount: {
            type: Number,
            default: 0
        },
        dueAmount: {
            type: Number,
            default: 0
        },
        _id: false
    },
    items: [
        {
            productId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "Product"
            },
            name: {
                type: String,
                required: true
            },
            sellingPrice: {
                type: Number,
                required: true
            },
            costPrice: {
                type: Number,
                required: true
            },
            quantity: {
                type: Number,
                required: true
            },
            unit: {
                type: String,
                required: true
            },
            hsnCode: {
                type: String,
                default: ''
            },
            gstPercent: {
                type: Number,
                default: 0
            },
            gstAmount: {
                type: Number,
                default: 0
            }

        }
    ],
    totalAmount: {
        type: Number,
        required: true
    },
    subtotal: {
        type: Number,
        default: 0
    },
    totalGstAmount: {
        type: Number,
        default: 0
    },
    discountPercent: {
        type: Number,
        default: 0
    },
    taxPercent: {
        type: Number,
        default: 0
    },
    invoiceNumber: {
        type: String,
        unique: true,
        sparse: true
    },
    isDeleted: {
        type: Boolean,
        default: false,
        index: true
    },
    allPaymentClear: {
        type: Boolean,
        default: true
    },
    localId: {
        type: String,
        required: false,
        index: true
    },
    stockDeducted: {
        type: Boolean,
        default: false
    },
    dueAdded: {
        type: Boolean,
        default: false
    }
}, { timestamps: true })

// Pre-save hook to handle splitPaymentDetails validation
// Remove splitPaymentDetails if it's null, undefined, or if payment method is not split
OrderSchema.pre('save', function (next) {
    // If splitPaymentDetails is null, undefined, or payment method is not split, remove it
    if (this.splitPaymentDetails === null ||
        this.splitPaymentDetails === undefined ||
        this.paymentMethod !== 'split') {
        this.splitPaymentDetails = undefined;
    }
    // If splitPaymentDetails exists but type is null or undefined, try to infer it instead of removing
    else if (this.splitPaymentDetails &&
        (this.splitPaymentDetails.type === null ||
            this.splitPaymentDetails.type === undefined)) {

        const cash = this.splitPaymentDetails.cashAmount || 0;
        const online = this.splitPaymentDetails.onlineAmount || 0;
        const credit = this.splitPaymentDetails.creditAmount || 0;
        const due = this.splitPaymentDetails.dueAmount || 0;

        if (cash > 0 && online > 0 && credit > 0 && due > 0) this.splitPaymentDetails.type = 'cash_online_credit_due';
        else if (cash > 0 && online > 0 && credit > 0) this.splitPaymentDetails.type = 'cash_online_credit';
        else if (cash > 0 && online > 0 && due > 0) this.splitPaymentDetails.type = 'cash_online_due';
        else if (cash > 0 && credit > 0 && due > 0) this.splitPaymentDetails.type = 'cash_credit_due';
        else if (online > 0 && credit > 0 && due > 0) this.splitPaymentDetails.type = 'online_credit_due';
        else if (cash > 0 && online > 0) this.splitPaymentDetails.type = 'cash_online';
        else if (cash > 0 && credit > 0) this.splitPaymentDetails.type = 'cash_credit';
        else if (cash > 0 && due > 0) this.splitPaymentDetails.type = 'cash_due';
        else if (online > 0 && credit > 0) this.splitPaymentDetails.type = 'online_credit';
        else if (online > 0 && due > 0) this.splitPaymentDetails.type = 'online_due';
        else if (credit > 0 && due > 0) this.splitPaymentDetails.type = 'credit_due';
        else if (cash > 0) { this.paymentMethod = 'cash'; this.splitPaymentDetails = undefined; }
        else if (online > 0) { this.paymentMethod = 'upi'; this.splitPaymentDetails = undefined; }
        else if (credit > 0) { this.paymentMethod = 'split'; this.splitPaymentDetails.type = 'credit_only'; } // Keep as split if only credit
        else if (due > 0) { this.paymentMethod = 'due'; this.splitPaymentDetails = undefined; }
        else { this.splitPaymentDetails = undefined; }
    }
    // If splitPaymentDetails exists but is an empty object, remove it
    else if (this.splitPaymentDetails &&
        typeof this.splitPaymentDetails === 'object' &&
        Object.keys(this.splitPaymentDetails).length === 0) {
        this.splitPaymentDetails = undefined;
    }

    next();
});


// Add index to prevent duplicate orders within short time window
// Index on sellerId, customerId, totalAmount, and createdAt for faster duplicate detection
OrderSchema.index({ sellerId: 1, customerId: 1, totalAmount: 1, createdAt: -1 });

module.exports = mongoose.model("Order", OrderSchema);