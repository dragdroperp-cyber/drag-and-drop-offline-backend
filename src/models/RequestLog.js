const mongoose = require('mongoose');

const requestLogSchema = new mongoose.Schema({
    method: {
        type: String,
        required: true
    },
    path: {
        type: String,
        required: true
    },
    statusCode: {
        type: Number,
        required: true
    },
    responseTime: {
        type: Number, // in ms
        required: true
    },
    userId: {
        type: String,
        index: true
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: '7d' // Auto-delete after 7 days
    }
});

// Index for frequent queries
requestLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('RequestLog', requestLogSchema);
