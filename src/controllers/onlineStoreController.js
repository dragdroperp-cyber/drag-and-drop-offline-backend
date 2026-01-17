const OnlineStore = require('../models/OnlineStore');
const Order = require('../models/Order');
const Product = require('../models/Product');
const ProductBatch = require('../models/ProductBatch');
const Customer = require('../models/Customer');
const EcomCustomer = require('../models/EcomCustomer');
const SyncTracking = require('../models/SyncTracking');
const mongoose = require('mongoose');

/**
 * Get online store settings for the authenticated seller
 */
exports.getStoreSettings = async (req, res) => {
    try {
        const sellerId = req.sellerId;

        let store = await OnlineStore.findOne({ sellerId });

        if (!store) {
            // Return default structure if not found, frontend will allow creation on save
            return res.status(200).json({
                sellerId,
                storeName: '',
                storeSlug: '',
                onlineOrderingEnabled: false,
                primaryColor: '#4F46E5',
                layoutTheme: 'Modern Grid',
                font: 'Inter',
                cardStyle: 'shadow',
                buttonStyle: 'rounded',
                bannerStyle: 'Minimalist',
                exists: false
            });
        }

        res.status(200).json({
            ...store.toObject(),
            exists: true
        });
    } catch (error) {
        console.error('Error fetching online store settings:', error);
        res.status(500).json({ message: 'Error fetching store settings' });
    }
};

/**
 * Update (or create) online store settings
 */
exports.updateStoreSettings = async (req, res) => {
    try {
        const sellerId = req.sellerId;
        const updates = req.body;

        // Check for slug uniqueness if it's being updated
        if (updates.storeSlug) {
            const existingSlug = await OnlineStore.findOne({
                storeSlug: updates.storeSlug,
                sellerId: { $ne: sellerId }
            });
            if (existingSlug) {
                return res.status(400).json({ message: 'Store URL is already taken. Please choose another.' });
            }
        }

        const store = await OnlineStore.findOneAndUpdate(
            { sellerId },
            {
                ...updates,
                sellerId,
                updatedAt: new Date()
            },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );

        // Update sync tracking
        try {
            await SyncTracking.updateLatestTime(sellerId, 'settings');
        } catch (trackingError) {
            console.error('Error updating sync tracking for settings update:', trackingError);
        }

        res.status(200).json({
            ...store.toObject(),
            exists: true,
            message: 'Store settings updated successfully'
        });
    } catch (error) {
        console.error('Error updating online store settings:', error);
        res.status(500).json({ message: 'Error updating store settings' });
    }
};

/**
 * Get online orders for the seller
 */
exports.getOnlineOrders = async (req, res) => {
    try {
        const sellerId = req.sellerId;
        const { status, limit = 50, page = 1 } = req.query;

        const query = {
            sellerId,
            orderSource: 'online',
            isDeleted: false
        };

        if (status && status !== 'All') {
            query.orderStatus = status;
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const orders = await Order.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));

        const total = await Order.countDocuments(query);

        res.status(200).json({
            success: true,
            data: orders,
            pagination: {
                total,
                page: parseInt(page),
                pages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('Error fetching online orders:', error);
        res.status(500).json({ message: 'Error fetching online orders' });
    }
};

/**
 * Update online order status
 */
exports.updateOnlineOrderStatus = async (req, res) => {
    try {
        const sellerId = req.sellerId;
        const { orderId } = req.params;
        const { status } = req.body;

        if (!['Pending', 'Seller Confirmed', 'Processing', 'Out for Delivery', 'Delivered', 'Completed', 'Cancelled'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status' });
        }

        const order = await Order.findOne(
            { _id: orderId, sellerId }
        );

        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        // Check if we need to RESTOCK (Status changed TO Cancelled/Rejected from a non-cancelled state)
        if (status === 'Cancelled' && order.orderStatus !== 'Cancelled') {
            const items = order.items;
            for (const item of items) {
                // Find a suitable batch to return stock to (preferably one with furthest expiry or created most recently)
                const latestBatch = await ProductBatch.findOne({
                    sellerId,
                    productId: item.productId,
                    isDeleted: false
                }).sort({ expiry: -1, createdAt: -1 });

                if (latestBatch) {
                    latestBatch.quantity += item.quantity;
                    await latestBatch.save();
                } else {
                    // Fallback: Create a new batch or finding product failed (shouldn't happen)
                    // For now, logging error if no batch found to return stock to
                    console.error(`Could not return stock for product ${item.productId} - No active batch found.`);
                }
            }
            // Trigger sync update
            await SyncTracking.updateLatestTime(sellerId, 'productBatches');
            await SyncTracking.updateLatestTime(sellerId, 'products');
        }

        // If order from ecommerce website is Delivered/Completed, mark payment as Clear
        if ((status === 'Delivered' || status === 'Completed') && order.orderSource === 'online') {
            order.allPaymentClear = true;
        }

        // Now update the status
        order.orderStatus = status;
        order.updatedAt = new Date();
        await order.save();

        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        res.status(200).json({
            success: true,
            message: 'Order status updated',
            data: order
        });
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ message: 'Error updating order status' });
    }
};

/**
 * Verify delivery token and set status to Delivered
 */
exports.verifyDeliveryToken = async (req, res) => {
    try {
        const sellerId = req.sellerId;
        const { orderId } = req.params;
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({ success: false, message: 'Verification token is required' });
        }

        const order = await Order.findOne({ _id: orderId, sellerId });

        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        // Verify token
        // We check against deliveryConfirmationToken, or fallback to _id/invoiceNumber if token wasn't generated
        const isMatch = token === order.deliveryConfirmationToken ||
            token === order._id.toString() ||
            token === order.invoiceNumber;

        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Invalid verification QR code' });
        }

        // Update status to Delivered
        order.orderStatus = 'Delivered';
        order.isDeliveryVerified = true;

        // If order from ecommerce website, mark payment as Clear upon delivery verification
        if (order.orderSource === 'online') {
            order.allPaymentClear = true;
        }

        order.updatedAt = new Date();
        await order.save();

        // Update sync tracking for orders
        await SyncTracking.updateLatestTime(sellerId, 'orders');

        res.status(200).json({
            success: true,
            message: 'Delivery verified successfully',
            data: order
        });
    } catch (error) {
        console.error('Error verifying delivery token:', error);
        res.status(500).json({ success: false, message: 'Error verifying delivery' });
    }
};

/**
 * Get dashboard stats for online store
 */
exports.getDashboardStats = async (req, res) => {
    try {
        const sellerId = req.sellerId;

        // 1. Get Store Details 
        const store = await OnlineStore.findOne({ sellerId });

        // 2. Get Order Stats
        const orderStats = await Order.aggregate([
            {
                $match: {
                    $or: [
                        { sellerId: sellerId },
                        { sellerId: new mongoose.Types.ObjectId(sellerId) }
                    ],
                    orderSource: 'online',
                    isDeleted: false
                }
            },
            {
                $group: {
                    _id: null,
                    totalOrders: { $sum: 1 },
                    totalRevenue: {
                        $sum: {
                            $cond: [{ $ne: ['$orderStatus', 'Cancelled'] }, '$totalAmount', 0]
                        }
                    },
                    pendingOrders: {
                        $sum: { $cond: [{ $eq: ['$orderStatus', 'Pending'] }, 1, 0] }
                    }
                }
            }
        ]);

        const stats = orderStats[0] || { totalOrders: 0, totalRevenue: 0, pendingOrders: 0 };

        // 3. Get Recent Orders
        const recentOrders = await Order.find({
            sellerId: sellerId,
            orderSource: 'online',
            isDeleted: false
        })
            .sort({ createdAt: -1 })
            .limit(5);

        res.status(200).json({
            success: true,
            data: {
                totalOrders: stats.totalOrders,
                totalRevenue: stats.totalRevenue,
                pendingOrders: stats.pendingOrders,
                recentOrders
            }
        });

    } catch (error) {
        console.error('Error fetching dashboard stats:', error);
        res.status(500).json({ message: 'Error fetching stats' });
    }
};

/**
 * PUBLIC: Get store by slug (For customer facing site)
 */
exports.getPublicStore = async (req, res) => {
    try {
        const { slug } = req.params;

        // Get store and populate seller plan
        const storeDoc = await OnlineStore.findOne(
            { storeSlug: slug }
        ).populate({
            path: 'sellerId',
            select: 'currentPlanId phoneNumber',
            populate: {
                path: 'currentPlanId',
                model: 'PlanOrder',
                select: 'expiryDate status'
            }
        });

        if (!storeDoc) {
            return res.status(404).json({ message: 'Store not found' });
        }

        // Check for plan expiration
        let isPlanExpired = false;

        if (storeDoc.sellerId && storeDoc.sellerId.currentPlanId) {
            const plan = storeDoc.sellerId.currentPlanId;
            const status = plan.status ? plan.status.toLowerCase() : '';
            const now = new Date();
            const expiryDate = plan.expiryDate ? new Date(plan.expiryDate) : null;

            if (status === 'expired') {
                isPlanExpired = true;
            } else if (expiryDate && expiryDate < now) {
                isPlanExpired = true;
            } else if (status === 'paused') {
                // Treat paused plans as expired/locked
                isPlanExpired = true;
            }
        } else if (storeDoc.sellerId && !storeDoc.sellerId.currentPlanId) {
            // No plan assigned means no access
            isPlanExpired = true;
        }

        // Prepare response data
        const storeData = storeDoc.toObject();

        // Add phone number from seller if available and not set in store settings
        if (storeDoc.sellerId && storeDoc.sellerId.phoneNumber) {
            if (!storeData.contactPhone) {
                storeData.contactPhone = storeDoc.sellerId.phoneNumber;
            }
            // Also explicitly set phoneNumber for backward compatibility/direct access
            storeData.phoneNumber = storeDoc.sellerId.phoneNumber;
        }

        // Ensure sellerId is just the ID string for frontend compatibility
        if (storeData.sellerId && typeof storeData.sellerId === 'object') {
            storeData.sellerId = storeData.sellerId._id || storeData.sellerId;
        }

        storeData.isPlanExpired = isPlanExpired;

        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

        res.status(200).json({
            success: true,
            data: storeData
        });

    } catch (error) {
        console.error('Error fetching public store:', error);
        res.status(500).json({ message: 'Error fetching store' });
    }
};

/**
 * PUBLIC: Get products for a store slug
 */
exports.getPublicProducts = async (req, res) => {
    try {
        const { slug } = req.params;

        const store = await OnlineStore.findOne({ storeSlug: slug });
        if (!store) {
            return res.status(404).json({ message: 'Store not found' });
        }

        const sellerId = store.sellerId;

        // Fetch products and batches
        const allProducts = await Product.find({
            sellerId,
            isDeleted: false,
            isActive: true,
            onlineSale: { $ne: false }
        })
            .populate({
                path: 'categoryId',
                select: 'name image description onlineSale'
            })
            .lean();

        // Filter products where category exists and category.onlineSale is not false
        // Products without categoryId are kept (they are in 'Uncategorized')
        const products = allProducts.filter(product => {
            if (!product.categoryId) return true;
            return product.categoryId.onlineSale !== false;
        });

        const batches = await ProductBatch.find({ sellerId, isDeleted: false, quantity: { $gt: 0 } })
            .sort({ expiry: 1 })
            .lean();

        // Associate batches with products
        const productsWithBatches = products.map(product => {
            const productBatches = batches.filter(b =>
                b.productId.toString() === product._id.toString() ||
                b.productMongoId?.toString() === product._id.toString()
            );

            // Get standard price from latest batch or first batch
            const price = productBatches.length > 0 ? productBatches[0].sellingUnitPrice : 0;
            const totalStock = productBatches.reduce((sum, b) => sum + b.quantity, 0);

            return {
                ...product,
                price,
                totalStock,
                batches: productBatches
            };
        });

        res.status(200).json({
            success: true,
            data: productsWithBatches
        });

    } catch (error) {
        console.error('Error fetching public products:', error);
        res.status(500).json({ message: 'Error fetching products' });
    }
};

/**
 * PUBLIC: Create online order
 */
exports.createPublicOrder = async (req, res) => {
    try {
        const { slug } = req.params;
        const { customerInfo, items, totalAmount, deliveryCharge = 0, paymentMethod = 'COD', deliveryType = 'delivery', saveDetails } = req.body;

        const store = await OnlineStore.findOne({ storeSlug: slug });
        if (!store) {
            return res.status(404).json({ message: 'Store not found' });
        }

        // Check if online ordering is enabled
        if (store.onlineOrderingEnabled === false) {
            return res.status(400).json({
                success: false,
                message: 'This store is currently not accepting online orders.'
            });
        }

        const sellerId = store.sellerId;

        // Check for minimum order amount
        const cartSubtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        if (store.minOrderAmount > 0 && cartSubtotal < store.minOrderAmount) {
            return res.status(400).json({
                success: false,
                message: `Minimum order amount for this store is ₹${store.minOrderAmount}. Please add more items.`
            });
        }

        // Update EcomCustomer profile if requested
        if (saveDetails && req.customer) {
            try {
                await EcomCustomer.findByIdAndUpdate(req.customer._id, {
                    name: customerInfo.name,
                    phoneNumber: customerInfo.mobileNumber,
                    defaultAddress: customerInfo.address
                });
            } catch (err) {
                console.error("Failed to update customer profile:", err);
                // Don't fail the order if profile update fails
            }
        }

        // 1. Find or Create Customer (POS Customer for in-store logic compatibility)
        // SKIPPED: As per requirement, online orders do not create permanent customer records
        /*
        let customer = await Customer.findOne({
            sellerId,
            mobileNumber: customerInfo.mobileNumber
        });

        if (!customer) {
            customer = new Customer({
                sellerId,
                name: customerInfo.name,
                mobileNumber: customerInfo.mobileNumber,
                address: customerInfo.address,
                email: customerInfo.email || ''
            });
            await customer.save();
        }
        */

        // 2. Fetch Cost Price from Batches
        const productIds = items.map(item => item._id);
        const batches = await ProductBatch.find({
            sellerId,
            productId: { $in: productIds },
            isDeleted: false,
            quantity: { $gt: 0 }
        }).sort({ expiry: 1 }).lean();

        const orderItems = items.map(item => {
            const productBatches = batches.filter(b =>
                b.productId?.toString() === item._id ||
                b.productMongoId?.toString() === item._id
            );

            const cost = productBatches.length > 0 ? (productBatches[0].costPrice || 0) : 0;

            return {
                productId: item._id,
                name: item.name,
                quantity: item.quantity,
                unit: item.unit,
                sellingPrice: item.price,
                costPrice: cost,
                total: item.price * item.quantity
            };
        });

        // 2.5 Deduct Stock from Batches
        for (const item of items) {
            let quantityToDeduct = item.quantity;

            // Fetch mutable batches for this specific item
            const itemBatches = await ProductBatch.find({
                sellerId,
                productId: item._id,
                isDeleted: false,
                quantity: { $gt: 0 }
            }).sort({ expiry: 1 });

            for (const batch of itemBatches) {
                if (quantityToDeduct <= 0) break;

                if (batch.quantity >= quantityToDeduct) {
                    batch.quantity -= quantityToDeduct;
                    quantityToDeduct = 0;
                } else {
                    quantityToDeduct -= batch.quantity;
                    batch.quantity = 0;
                }
                await batch.save();
            }
        }

        // Update Sync Tracking so seller devices refresh their stock
        try {
            await SyncTracking.updateLatestTime(sellerId, 'productBatches');
            await SyncTracking.updateLatestTime(sellerId, 'products');
        } catch (err) {
            console.error('Error updating sync tracking for online order:', err);
        }

        // 3. Create Order
        const validPaymentMethod = (paymentMethod === 'COD' || paymentMethod === 'cod') ? 'cod' : paymentMethod;
        const confirmationToken = 'CONF-' + Math.random().toString(36).substring(2, 10).toUpperCase() + '-' + Date.now().toString(36).slice(-4).toUpperCase();

        // Generate Invoice Number for Online Order (same style as POS: INV-XXXXXXXX)
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let randomId = '';
        for (let i = 0; i < 8; i++) {
            randomId += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        const invoiceNumber = `INV-${randomId}`;

        const order = new Order({
            invoiceNumber,
            sellerId,
            customerId: null, // No persistent customer created
            customerLocalId: null,
            ecomCustomerId: req.customer ? req.customer._id : null,
            customerName: customerInfo.name,
            customerMobile: customerInfo.mobileNumber,
            deliveryAddress: customerInfo.address, // Store directly on order
            orderNotes: customerInfo.specialMessage, // Store special message
            items: orderItems,
            subtotal: cartSubtotal,
            totalAmount,
            deliveryCharge,
            deliveryType,
            paymentMethod: validPaymentMethod,
            orderStatus: 'Pending',
            orderSource: 'online',
            isSynced: true,
            allPaymentClear: false,
            deliveryConfirmationToken: confirmationToken
        });

        await order.save();

        res.status(201).json({
            success: true,
            message: 'Order placed successfully',
            data: order
        });

    } catch (error) {
        console.error('Error creating public order:', error);
        res.status(500).json({ message: 'Error placing order' });
    }
};

/**
 * Get orders for the authenticated e-commerce customer
 */
exports.getCustomerOrders = async (req, res) => {
    try {
        const customerId = req.customer._id;

        const orders = await Order.find({
            ecomCustomerId: customerId,
            isDeleted: false
        })
            .sort({ createdAt: -1 })
            .populate('sellerId', 'storeName logoUrl');

        res.json({
            success: true,
            data: orders
        });
    } catch (error) {
        console.error('Error fetching customer orders:', error);
        res.status(500).json({ message: 'Error fetching orders' });
    }
};

/**
 * Get order details for a specific order
 */
exports.getOrderDetail = async (req, res) => {
    try {
        const { orderId } = req.params;
        const customerId = req.customer._id;

        const order = await Order.findOne({
            _id: orderId,
            ecomCustomerId: customerId,
            isDeleted: false
        }).populate('sellerId', 'storeName logoUrl primaryColor');

        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        res.json({
            success: true,
            data: order
        });
    } catch (error) {
        console.error('Error fetching order detail:', error);
        res.status(500).json({ message: 'Error fetching order details' });
    }
};
/**
 * Generate a dynamic PWA manifest for the store
 */
exports.getManifest = async (req, res) => {
    try {
        const { slug } = req.params;
        const store = await OnlineStore.findOne({ storeSlug: slug });

        if (!store) {
            return res.status(404).json({ message: 'Store not found' });
        }

        const referer = req.headers.referer || '';
        let baseUrl = '';
        try {
            if (referer) {
                const refUrl = new URL(referer);
                baseUrl = refUrl.origin;
            }
        } catch (e) {
            console.error('Error parsing referer for manifest:', e);
        }

        const manifest = {
            name: store.storeName || 'Online Store',
            short_name: (store.storeName || 'Store').substring(0, 12),
            description: store.aboutStory || `Welcome to ${store.storeName}`,
            start_url: baseUrl ? `${baseUrl}/${slug}` : `/${slug}`,
            display: 'standalone',
            background_color: '#ffffff',
            theme_color: store.primaryColor || '#4F46E5',
            orientation: 'portrait',
            icons: [
                {
                    src: store.logoUrl || 'https://img.icons8.com/?size=192&id=VXQNQomZUcOU&format=png',
                    sizes: '192x192',
                    type: 'image/png',
                    purpose: 'any maskable'
                },
                {
                    src: store.logoUrl || 'https://img.icons8.com/?size=512&id=VXQNQomZUcOU&format=png',
                    sizes: '512x512',
                    type: 'image/png',
                    purpose: 'any maskable'
                }
            ]
        };

        res.setHeader('Content-Type', 'application/manifest+json');
        return res.json(manifest);
    } catch (error) {
        console.error('Error generating manifest:', error);
        res.status(500).json({ message: 'Error generating manifest' });
    }
};
