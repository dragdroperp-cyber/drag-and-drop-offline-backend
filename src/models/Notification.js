const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  recipientId: { // Seller or Staff ID
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  recipientType: {
    type: String,
    required: true,
    enum: ['Seller', 'Staff']
  },
  senderId: { // Who triggered the notification (e.g., Staff ID, Seller ID, or System)
    type: mongoose.Schema.Types.ObjectId,
    default: null,
    refPath: 'senderType'
  },
  senderType: {
    type: String,
    enum: ['Seller', 'Staff', 'System'],
    default: 'System'
  },
  type: {
    type: String,
    required: true,
    enum: [
      'STAFF_RESIGNED',
      'STAFF_JOINED',
      'STAFF_DEACTIVATED',
      'PLAN_EXPIRED',
      'PLAN_UPGRADE_REMINDER',
      'SYSTEM_ALERT'
    ]
  },
  message: {
    type: String,
    required: true
  },
  read: {
    type: Boolean,
    default: false
  },
  link: { // Optional link to a relevant page
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

// Index for efficient queries
NotificationSchema.index({ recipientId: 1, createdAt: -1 });
NotificationSchema.index({ recipientId: 1, read: 1 });

module.exports = mongoose.model('Notification', NotificationSchema);
