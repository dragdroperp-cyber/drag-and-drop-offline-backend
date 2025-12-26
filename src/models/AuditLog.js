const mongoose = require('mongoose');

const AuditLogSchema = new mongoose.Schema({
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Seller',
    required: true,
    index: true
  },
  staffId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Staff',
    default: null,
    index: true
  },
  action: {
    type: String,
    required: true,
    enum: [
      'STAFF_INVITED',
      'STAFF_JOINED',
      'STAFF_PERMISSIONS_UPDATED',
      'STAFF_DEACTIVATED',
      'STAFF_REACTIVATED',
      'STAFF_RESIGNED',
      'SELLER_PROFILE_UPDATED',
      'PLAN_ASSIGNED',
      'PLAN_UPGRADED',
      'ACCOUNT_DELETED'
    ]
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

// Index for efficient queries
AuditLogSchema.index({ sellerId: 1, timestamp: -1 });
AuditLogSchema.index({ staffId: 1, timestamp: -1 });

module.exports = mongoose.model('AuditLog', AuditLogSchema);
