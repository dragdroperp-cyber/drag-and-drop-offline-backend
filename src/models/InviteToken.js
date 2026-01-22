const mongoose = require("mongoose");

const InviteTokenSchema = new mongoose.Schema({
  token: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Seller",
    required: true,
    index: true
  },
  permissions: {
    type: Object,
    required: true
  },
  expiryTime: {
    type: Date,
    required: true,
    index: true
  },
  used: {
    type: Boolean,
    default: false,
    index: true
  },
  usedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Staff",
    default: null
  },
  usedAt: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Seller",
    required: true
  }
});

// Method to check if token is expired
InviteTokenSchema.methods.isExpired = function() {
  return new Date() > this.expiryTime;
};

// Method to check if token is valid
InviteTokenSchema.methods.isValid = function() {
  return !this.used && !this.isExpired();
};

// Method to mark token as used
InviteTokenSchema.methods.markAsUsed = function(staffId) {
  this.used = true;
  this.usedBy = staffId;
  this.usedAt = new Date();
  return this.save();
};

// Static method to generate a unique token
InviteTokenSchema.statics.generateToken = function() {
  return `invite_${Date.now()}_${Math.random().toString(36).substr(2, 9)}_${Math.random().toString(36).substr(2, 9)}`;
};

// Static method to clean up expired tokens (can be called periodically)
InviteTokenSchema.statics.cleanupExpired = async function() {
  const result = await this.deleteMany({
    expiryTime: { $lt: new Date() },
    used: false
  });
  return result.deletedCount;
};

// Ensure indexes exist
InviteTokenSchema.index({ token: 1 }, { unique: true });
InviteTokenSchema.index({ sellerId: 1 });
InviteTokenSchema.index({ expiryTime: 1 });
InviteTokenSchema.index({ used: 1 });

module.exports = mongoose.model("InviteToken", InviteTokenSchema);
