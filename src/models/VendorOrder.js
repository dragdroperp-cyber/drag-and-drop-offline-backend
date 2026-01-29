const mongoose = require("mongoose");

const VendorOrderSchema = new mongoose.Schema({
    sellerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Seller",
        required: true
    },
    supplierName: {
        type: String,
        required: true,
    },
    items: [
        {
            productId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "Product",
                default: null
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
            productName: {
                type: String,
                required: true,
                trim: true
            },
            quantity: {
                type: Number,
                required: true,
                min: 1
            },
            price: {
                type: Number,
                required: true,
                min: 0
            },
            unit: {
                type: String,
                required: true,
                enum: ["pcs", "kg", "g", "mg", "l", "ml", "box", "packet", "bottle", "dozen"],
                default: "pcs"
            },
            isCustomProduct: {
                type: Boolean,
                default: false
            },
            subtotal: {
                type: Number,
                required: true,
                min: 0
            }
        }
    ],
    total: {
        type: Number,
        required: true,
        min: 0
    },
    status: {
        type: String,
        enum: ["pending", "completed", "cancelled"],
        default: "pending",
        index: true
    },
    paymentMethod: {
        type: String,
        enum: ["cash", "online", "upi", "due"],
        default: "due"
    },
    amountPaid: {
        type: Number,
        default: 0,
        min: 0
    },
    balanceDue: {
        type: Number,
        default: 0,
        min: 0
    },
    paymentStatus: {
        type: String,
        enum: ["paid", "partial", "unpaid"],
        default: "unpaid"
    },
    notes: {
        type: String,
        trim: true,
        default: ""
    },
    // Additional metadata
    expectedDeliveryDate: {
        type: Date,
        default: null
    },
    actualDeliveryDate: {
        type: Date,
        default: null
    },
    cancelledAt: {
        type: Date,
        default: null
    },
    cancelledReason: {
        type: String,
        trim: true,
        default: ""
    },
    refundedAmount: {
        type: Number,
        default: 0,
        min: 0
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
    },
    // Add missing supplier ID references if applicable
    supplierLocalId: {
        type: String,
        required: false,
        index: true
    },
    supplierMongoId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Supplier",
        required: false
    }
}, { timestamps: true });

// Indexes for better query performance
VendorOrderSchema.index({ sellerId: 1, status: 1 });
VendorOrderSchema.index({ supplierName: 1 });
VendorOrderSchema.index({ createdAt: -1 });

// Virtual for order date (using createdAt from timestamps)
VendorOrderSchema.virtual('date').get(function () {
    return this.createdAt;
});

// Method to calculate total from items
VendorOrderSchema.methods.calculateTotal = function () {
    const total = this.items.reduce((sum, item) => {
        return sum + (item.price * item.quantity);
    }, 0);
    this.total = total;
    return total;
};

// Pre-save hook to calculate subtotals and total
VendorOrderSchema.pre('save', function (next) {
    // Calculate subtotal for each item
    this.items.forEach(item => {
        item.subtotal = item.price * item.quantity;
    });

    // Calculate total
    this.total = this.items.reduce((sum, item) => sum + item.subtotal, 0);

    // Set cancelledAt if status is cancelled
    if (this.status === 'cancelled' && !this.cancelledAt) {
        this.cancelledAt = new Date();
    }

    // Set actualDeliveryDate if status is completed
    if (this.status === 'completed' && !this.actualDeliveryDate) {
        this.actualDeliveryDate = new Date();
    }

    next();
});

module.exports = mongoose.model("VendorOrder", VendorOrderSchema);

