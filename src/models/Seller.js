const mongoose = require("mongoose");

const SellerSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
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
  currentPlanId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "PlanOrder",
    default: null
  },
  lastActivityDate: {
    type: Date,
    default: Date.now
  },
  shopName: {
    type: String,
    default: null
  },
  businessType: {
    type: String,
    default: null
  },
  shopAddress: {
    type: String,
    default: null
  },
  phoneNumber: {
    type: String,
    default: null,
    unique: false
  },
  city: {
    type: String,
    default: null
  },
  state: {
    type: String,
    default: null
  },
  pincode: {
    type: String,
    default: null
  },
  gender: {
    type: String,
    default: null
  },
  upiId: {
    type: String,
    default: null
  },
  gstNumber: {
    type: String,
    default: null
  },
  businessCategory: {
    type: String,
    default: null
  },
  lowStockThreshold: {
    type: Number,
    default: 10
  },
  expiryDaysThreshold: {
    type: Number,
    default: 7
  },
  profileCompleted: {
    type: Boolean,
    default: false
  }
});

// Ensure unique indexes exist
SellerSchema.index({ email: 1 }, { unique: true });

module.exports = mongoose.model("Seller",SellerSchema);
