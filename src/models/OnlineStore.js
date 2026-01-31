const mongoose = require('mongoose');

const OnlineStoreSchema = new mongoose.Schema({
    sellerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Seller',
        required: true,
        unique: true
    },
    storeName: {
        type: String,
        required: true,
        trim: true
    },
    storeSlug: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true
    },
    primaryColor: {
        type: String,
        default: '#4F46E5'
    },
    layoutTheme: {
        type: String,
        enum: ['Modern Grid', 'Classic List', 'Compact List', 'Masonry'],
        default: 'Modern Grid'
    },
    font: {
        type: String,
        default: 'Inter'
    },
    cardStyle: {
        type: String,
        enum: ['shadow', 'border', 'flat'],
        default: 'shadow'
    },
    buttonStyle: {
        type: String,
        enum: ['rounded', 'pill', 'square'],
        default: 'rounded'
    },
    bannerStyle: {
        type: String,
        default: 'Minimalist'
    },
    onlineOrderingEnabled: {
        type: Boolean,
        default: false
    },
    pickupEnabled: {
        type: Boolean,
        default: false
    },
    bannerUrl: {
        type: String,
        default: ''
    },
    logoUrl: {
        type: String,
        default: ''
    },
    tagline: {
        type: String,
        default: ''
    },
    aboutStory: {
        type: String,
        default: ''
    },
    contactPhone: {
        type: String,
        default: ''
    },
    contactEmail: {
        type: String,
        default: ''
    },
    deliveryCharge: {
        type: Number,
        default: 0
    },
    deliveryRange: {
        type: Number,
        default: 0
    },
    minFreeDeliveryAmount: {
        type: Number,
        default: 0
    },
    minOrderAmount: {
        type: Number,
        default: 0
    },
    socialLinks: {
        instagram: { type: String, default: '' },
        facebook: { type: String, default: '' },
        twitter: { type: String, default: '' },
        youtube: { type: String, default: '' }
    },
    banners: [{
        imageUrl: { type: String, required: true },
        redirectUrl: { type: String, default: '' },
        active: { type: Boolean, default: true }
    }]
}, { timestamps: true });

module.exports = mongoose.model('OnlineStore', OnlineStoreSchema);
