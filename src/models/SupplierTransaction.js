const mongoose = require("mongoose");

const SupplierTransactionSchema = new mongoose.Schema({
    sellerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Seller",
        required: true,
        index: true
    },
    supplierId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Supplier",
        required: true,
        index: true
    },
    orderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "VendorOrder",
        default: null
    },
    type: {
        type: String,
        enum: ["payment", "due", "refund", "opening_balance", "settlement", "add_due", "remove_due", "credit_usage", "purchase_order", "cancel_purchase"],
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    previousBalance: {
        type: Number,
        default: 0
    },
    currentBalance: {
        type: Number,
        default: 0
    },
    date: {
        type: Date,
        default: Date.now
    },
    description: {
        type: String,
        default: ""
    },
    // For offline sync
    localId: {
        type: String,
        required: false,
        index: true
    },
    isDeleted: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

// Helper function to update supplier balance based on transaction history
const updateSupplierBalance = async (supplierId, sellerId) => {
    try {
        const Supplier = mongoose.model("Supplier");
        const transactions = await mongoose.model("SupplierTransaction").find({
            supplierId,
            sellerId,
            isDeleted: { $ne: true }
        });

        let totalDues = 0;
        let totalPayments = 0;

        transactions.forEach(t => {
            const isPayment = ['payment', 'cash', 'online', 'upi', 'card', 'remove_due', 'settlement', 'cancel_purchase'].includes(t.type);
            const isCredit = ['due', 'add_due', 'opening_balance', 'purchase_order', 'refund', 'credit_usage'].includes(t.type);

            if (isPayment) totalPayments += Number(t.amount || 0);
            else if (isCredit) totalDues += Number(t.amount || 0);
        });

        const calculatedBalance = parseFloat((totalDues - totalPayments).toFixed(2));

        await Supplier.findByIdAndUpdate(supplierId, {
            dueAmount: calculatedBalance
        });
    } catch (error) {
        console.error("Error updating supplier balance from transaction hook:", error);
    }
};

// Hook to update balance after saving a transaction
SupplierTransactionSchema.post("save", async function (doc) {
    if (doc.supplierId && doc.sellerId) {
        await updateSupplierBalance(doc.supplierId, doc.sellerId);
    }
});

// Hook to update balance after removing a transaction (if hard deleted)
SupplierTransactionSchema.post("findOneAndDelete", async function (doc) {
    if (doc && doc.supplierId && doc.sellerId) {
        await updateSupplierBalance(doc.supplierId, doc.sellerId);
    }
});

module.exports = mongoose.model("SupplierTransaction", SupplierTransactionSchema);
