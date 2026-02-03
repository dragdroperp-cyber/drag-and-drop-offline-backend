const mongoose = require('mongoose');

const targetSchema = new mongoose.Schema({
    sellerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    date: {
        type: Date,
        required: true
    },
    targetAmount: {
        type: Number,
        required: true,
        min: 0
    },
    localId: {
        type: String
    },
    isDeleted: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true
});

// Ensure one target per day per seller
targetSchema.index({ sellerId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Target', targetSchema);
