const mongoose = require("mongoose");

const RefundSchema = new mongoose.Schema({
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Order",
    required: true,
    index: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Customer",
    default: null
  },
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Seller",
    required: true,
    index: true
  },
  items: [
    {
      productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
        required: true
      },
      name: {
        type: String,
        required: true
      },
      qty: {
        type: Number,
        required: true,
        min: 0
      },
      rate: {
        type: Number,
        required: true,
        min: 0
      },
      lineTotal: {
        type: Number,
        required: true,
        min: 0
      },
      unit: {
        type: String,
        default: 'pcs'
      }
    }
  ],
  totalRefundAmount: {
    type: Number,
    required: true,
    min: 0
  },
  reason: {
    type: String,
    default: ''
  },
  refundedByUser: {
    type: String,
    default: ''
  },
  isDeleted: {
    type: Boolean,
    default: false,
    index: true
  }
}, { timestamps: true });

// Indexes for faster queries
RefundSchema.index({ sellerId: 1, createdAt: -1 });
RefundSchema.index({ orderId: 1 });
RefundSchema.index({ customerId: 1 });

module.exports = mongoose.model("Refund", RefundSchema);

