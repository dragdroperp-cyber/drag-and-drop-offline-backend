const mongoose = require('mongoose');

const securityLogSchema = new mongoose.Schema({
    sellerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Seller',
        required: false // Can be null for unauthenticated attempts
    },
    event: {
        type: String,
        required: true,
        enum: [
            'LOGIN_SUCCESS',
            'LOGIN_FAILED',
            'UNAUTHORIZED_ACCESS',
            'MALICIOUS_INPUT',
            'SENSITIVE_DATA_EXPORT',
            'PLAN_UPGRADE_ATTEMPT',
            'PAYMENT_VERIFIED',
            'ACCOUNT_DEACTIVATED'
        ]
    },
    message: {
        type: String,
        required: true
    },
    ipAddress: String,
    userAgent: String,
    path: String,
    method: String,
    severity: {
        type: String,
        enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
        default: 'LOW'
    },
    metadata: {
        type: Object,
        default: {}
    },
    timestamp: {
        type: Date,
        default: Date.now
    }
});

// Index for faster querying by seller and event type
securityLogSchema.index({ sellerId: 1, event: 1 });
securityLogSchema.index({ timestamp: -1 });

module.exports = mongoose.model('SecurityLog', securityLogSchema);
