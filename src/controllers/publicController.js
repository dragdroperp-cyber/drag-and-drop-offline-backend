const Order = require('../models/Order');
const SellerSettings = require('../models/SellerSettings');
const Seller = require('../models/Seller'); // Usually not needed for population if model name is string, but good practice

exports.verifyAndGetBill = async (req, res) => {
    try {
        const { invoiceNo, mobileNumber } = req.body;

        if (!invoiceNo || !mobileNumber) {
            return res.status(400).json({ success: false, message: 'Invoice number and mobile number are required.' });
        }

        const mongoose = require('mongoose');

        // Find order
        let query = { invoiceNumber: invoiceNo };
        if (!invoiceNo.startsWith('INV-') && mongoose.Types.ObjectId.isValid(invoiceNo)) {
            // Fallback to searching by ID if it looks like an ID
            query = { _id: invoiceNo };
        } else if (!invoiceNo.startsWith('INV-') && !mongoose.Types.ObjectId.isValid(invoiceNo)) {
            // If it's not INV- and not ObjectId, try internal ID or return not found
            query = { id: invoiceNo };
        }

        // Use findOne with the determined query
        let order = await Order.findOne(query)
            .populate({
                path: 'sellerId',
                select: 'shopName shopAddress city state pincode phone phoneNumber email gstNumber upiId profilePicture whatsappLink logoUrl'
            });

        if (!order && mongoose.Types.ObjectId.isValid(invoiceNo)) {
            // Second  attempt if original query failed and it might handle the edge case where order variable was null
            order = await Order.findById(invoiceNo).populate({
                path: 'sellerId',
                select: 'shopName shopAddress city state pincode phone phoneNumber email gstNumber upiId profilePicture whatsappLink logoUrl'
            });
        }

        if (!order) {
            return res.status(404).json({ success: false, message: 'Invoice not found.' });
        }

        // Clean mobile numbers for comparison (last 10 digits)
        const cleanInputMobile = mobileNumber.replace(/\D/g, '').slice(-10);
        const orderMobile = order.customerMobile ? order.customerMobile.replace(/\D/g, '').slice(-10) : '';

        if (!orderMobile) {
            return res.status(403).json({ success: false, message: 'No mobile number associated with this order. Cannot verify.' });
        }

        if (cleanInputMobile !== orderMobile) {
            return res.status(403).json({ success: false, message: 'Mobile number does not match our records.' });
        }

        // Fetch seller settings
        let sellerSettings = {};
        if (order.sellerId && order.sellerId._id) {
            sellerSettings = await SellerSettings.findOne({ sellerId: order.sellerId._id });
        }

        res.json({ success: true, order, sellerSettings });

    } catch (error) {
        console.error('Verify Bill Error:', error);
        res.status(500).json({ success: false, message: 'Server error verifying bill.' });
    }
};
