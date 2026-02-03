const mongoose = require("mongoose");

const CustomerTransactionSchema = new mongoose.Schema({
    sellerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Seller",
        required: true,
        index: true
    },
    customerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Customer",
        required: true,
        index: true
    },
    orderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Order",
        default: null
    },
    type: {
        type: String,
        enum: ["payment", "due", "refund", "opening_balance", "settlement", "add_due", "remove_due", "credit_usage"],
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
    // Stable ID references
    customerLocalId: {
        type: String,
        required: false,
        index: true
    },
    customerMongoId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Customer",
        required: false
    },
    orderLocalId: {
        type: String,
        required: false
    },
    orderMongoId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Order",
        required: false
    },
    isDeleted: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

// Helper function to update customer balance based on transaction history
const updateCustomerBalance = async (customerId, sellerId) => {
    try {
        const Customer = mongoose.model("Customer");
        const transactions = await mongoose.model("CustomerTransaction").find({
            customerId,
            sellerId,
            isDeleted: { $ne: true }
        });

        let totalDues = 0;
        let totalPayments = 0;

        transactions.forEach(t => {
            const isPayment = ['payment', 'cash', 'online', 'upi', 'card', 'refund', 'remove_due'].includes(t.type);
            const isCredit = ['credit', 'due', 'add_due', 'credit_usage', 'opening_balance', 'settlement'].includes(t.type);

            if (isPayment) totalPayments += Number(t.amount || 0);
            else if (isCredit) totalDues += Number(t.amount || 0);
        });

        const calculatedBalance = parseFloat((totalDues - totalPayments).toFixed(2));

        await Customer.findByIdAndUpdate(customerId, {
            dueAmount: calculatedBalance,
            balanceDue: calculatedBalance // Update both fields for consistency
        });
    } catch (error) {
        console.error("Error updating customer balance from transaction hook:", error);
    }
};

// Hook to update balance after saving a transaction
CustomerTransactionSchema.post("save", async function (doc) {
    if (doc.customerId && doc.sellerId) {
        await updateCustomerBalance(doc.customerId, doc.sellerId);
    }
});

// Hook to update balance after removing a transaction (if hard deleted)
CustomerTransactionSchema.post("findOneAndDelete", async function (doc) {
    if (doc && doc.customerId && doc.sellerId) {
        await updateCustomerBalance(doc.customerId, doc.sellerId);
    }
});

module.exports = mongoose.model("CustomerTransaction", CustomerTransactionSchema);
