const mongoose = require('mongoose');

const requestLogSchema = new mongoose.Schema({
    method: {
        type: String,
        required: true,
        uppercase: true
    },
    path: {
        type: String,
        required: true
    },
    statusCode: {
        type: Number,
        required: true
    },
    duration: {
        type: Number, // in milliseconds
        required: true
    },
    ip: {
        type: String
    },
    userAgent: {
        type: String
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 60 * 60 * 24 * 7 // Automatically delete logs after 7 days to save space
    }
});

// Index for efficient querying by date
requestLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('RequestLog', requestLogSchema);
