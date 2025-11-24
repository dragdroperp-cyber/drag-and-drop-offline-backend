const mongoose = require("mongoose");

const StaffSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  profilePicture: {
    type: String,
    default: null
  },
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Seller",
    required: true,
    index: true
  },
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Seller",
    required: true
  },
  inviteToken: {
    type: String,
    required: true
  },
  permissions: {
    type: Object,
    default: {},
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isSuspend: {
    type: Boolean,
    default: false
  },
  lastActivityDate: {
    type: Date,
    default: Date.now
  },
  resignedAt: {
    type: Date,
    default: null
  },
  accessRevoked: {
    type: Boolean,
    default: false
  },
  resignationReason: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Define available permissions
StaffSchema.statics.AVAILABLE_PERMISSIONS = {
  // Dashboard access
  dashboard: { type: Boolean, default: true },

  // Customer management
  customers: { type: Boolean, default: false },
  customers_view: { type: Boolean, default: false },
  customers_add: { type: Boolean, default: false },
  customers_edit: { type: Boolean, default: false },
  customers_delete: { type: Boolean, default: false },

  // Product management
  products: { type: Boolean, default: false },
  products_view: { type: Boolean, default: false },
  products_add: { type: Boolean, default: false },
  products_edit: { type: Boolean, default: false },
  products_delete: { type: Boolean, default: false },

  // Inventory management
  inventory: { type: Boolean, default: false },
  inventory_view: { type: Boolean, default: false },
  inventory_edit: { type: Boolean, default: false },

  // Billing/Sales
  billing: { type: Boolean, default: false },
  billing_view: { type: Boolean, default: false },
  billing_create: { type: Boolean, default: false },
  billing_edit: { type: Boolean, default: false },

  // Sales Order History
  salesOrderHistory: { type: Boolean, default: false },

  // Refunds
  refunds: { type: Boolean, default: false },
  refunds_view: { type: Boolean, default: false },
  refunds_process: { type: Boolean, default: false },

  // Purchase Orders
  purchase: { type: Boolean, default: false },
  purchase_view: { type: Boolean, default: false },
  purchase_create: { type: Boolean, default: false },

  // Financial reports
  financial: { type: Boolean, default: false },

  // Reports
  reports: { type: Boolean, default: false },

  // Settings (limited access)
  settings: { type: Boolean, default: false },
  settings_basic: { type: Boolean, default: false }
};

// Method to check if staff has a specific permission
StaffSchema.methods.hasPermission = function(permission) {
  return Boolean(this.permissions && this.permissions[permission]);
};

// Method to get all permissions for a staff member
StaffSchema.methods.getAllPermissions = function() {
  return this.permissions || {};
};

// Method to set permissions
StaffSchema.methods.setPermissions = function(newPermissions) {
  this.permissions = { ...newPermissions };
  this.updatedAt = new Date();
  return this.save();
};

// Pre-save middleware to update updatedAt
StaffSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Ensure unique indexes exist
StaffSchema.index({ email: 1 }, { unique: true });
StaffSchema.index({ sellerId: 1 });

module.exports = mongoose.model("Staff", StaffSchema);
