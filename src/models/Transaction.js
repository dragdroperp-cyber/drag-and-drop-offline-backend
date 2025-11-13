const mongoose = require("mongoose");

const TransactionSchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Seller",
    required: true
  },
  type: {
    type: String,
    enum: ["sale","purchase", "refund", "recharge", "plan_purchase"],
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  paymentMethod: {
    type: String,
    enum: ["cash", "card", "upi", "bank", "credit", "razorpay"],
    default: "cash"
  },
  description: {
    type: String
  },
  // Razorpay payment fields (for plan purchases)
  razorpayOrderId: {
    type: String,
    default: null
  },
  razorpayPaymentId: {
    type: String,
    default: null
  },
  planOrderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "PlanOrder",
    default: null
  },
  planId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Plan",
    default: null
  },
  date: {
    type: Date,
    default: Date.now
  },
},{timestamps:true});

module.exports = mongoose.model("Transaction", TransactionSchema);
