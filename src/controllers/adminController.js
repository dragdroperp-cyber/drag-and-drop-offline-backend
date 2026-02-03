const SuperAdmin = require('../models/SuperAdmin');
const Seller = require('../models/Seller');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;
        const admin = await SuperAdmin.findOne({ email });

        if (!admin) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        const isMatch = await bcrypt.compare(password, admin.password);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        const token = jwt.sign({ id: admin._id }, process.env.JWT_SECRET || 'hariommodiisthekey', { expiresIn: '24h' });

        // Set HttpOnly Cookie
        res.cookie('adminToken', token, {
            httpOnly: true,
            secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
            sameSite: 'lax',
            path: '/',
            maxAge: 24 * 60 * 60 * 1000 // 24 hours
        });

        res.json({
            success: true,
            // token removed for security
            admin: {
                id: admin._id,
                name: admin.name,
                email: admin.email
            }
        });
    } catch (error) {
        // Admin login error suppressed
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.getFinancialStats = async (req, res) => {
    try {
        const PlanOrder = require('../models/PlanOrder');
        const Plan = require('../models/Plan');

        const { timeFilter } = req.query;
        let dateQuery = {};

        const now = new Date();
        if (timeFilter === 'today') {
            const startOfDay = new Date(now.setHours(0, 0, 0, 0));
            dateQuery = { createdAt: { $gte: startOfDay } };
        } else if (timeFilter === 'yesterday') {
            const startOfYesterday = new Date(now);
            startOfYesterday.setDate(startOfYesterday.getDate() - 1);
            startOfYesterday.setHours(0, 0, 0, 0);

            const endOfYesterday = new Date(now);
            endOfYesterday.setDate(endOfYesterday.getDate() - 1);
            endOfYesterday.setHours(23, 59, 59, 999);
            dateQuery = { createdAt: { $gte: startOfYesterday, $lte: endOfYesterday } };
        } else if (timeFilter === '7days') {
            const last7Days = new Date(now);
            last7Days.setDate(last7Days.getDate() - 7);
            dateQuery = { createdAt: { $gte: last7Days } };
        } else if (timeFilter === '30days') {
            const last30Days = new Date(now);
            last30Days.setDate(last30Days.getDate() - 30);
            dateQuery = { createdAt: { $gte: last30Days } };
        }

        // Total revenue from completed payments
        const revenueQuery = {
            paymentStatus: 'completed',
            ...dateQuery
        };

        const totalRevenue = await PlanOrder.aggregate([
            { $match: revenueQuery },
            { $group: { _id: null, total: { $sum: '$price' } } }
        ]);

        // Revenue by plan
        const revenueByPlan = await PlanOrder.aggregate([
            { $match: revenueQuery },
            {
                $group: {
                    _id: '$planId',
                    revenue: { $sum: '$price' },
                    count: { $sum: 1 }
                }
            },
            {
                $lookup: {
                    from: 'plans',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'planDetails'
                }
            },
            { $unwind: '$planDetails' },
            {
                $project: {
                    planId: '$_id',
                    planName: '$planDetails.name',
                    revenue: 1,
                    count: 1
                }
            },
            { $sort: { revenue: -1 } }
        ]);

        // Payment status breakdown
        const paymentStatusBreakdown = await PlanOrder.aggregate([
            { $match: dateQuery },
            {
                $group: {
                    _id: '$paymentStatus',
                    count: { $sum: 1 },
                    amount: { $sum: '$price' }
                }
            }
        ]);

        // Monthly revenue trend (last 6 months)
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

        const monthlyRevenue = await PlanOrder.aggregate([
            {
                $match: {
                    paymentStatus: 'completed',
                    createdAt: { $gte: sixMonthsAgo }
                }
            },
            {
                $group: {
                    _id: {
                        year: { $year: '$createdAt' },
                        month: { $month: '$createdAt' }
                    },
                    revenue: { $sum: '$price' },
                    count: { $sum: 1 }
                }
            },
            { $sort: { '_id.year': 1, '_id.month': 1 } }
        ]);

        // Active subscriptions count
        const activeSubscriptions = await PlanOrder.countDocuments({
            status: 'active',
            paymentStatus: 'completed'
        });

        // Average revenue per user
        const avgRevenuePerUser = totalRevenue.length > 0 && activeSubscriptions > 0
            ? (totalRevenue[0].total / activeSubscriptions).toFixed(2)
            : 0;

        res.json({
            success: true,
            financial: {
                totalRevenue: totalRevenue.length > 0 ? totalRevenue[0].total : 0,
                revenueByPlan,
                paymentStatusBreakdown,
                monthlyRevenue,
                activeSubscriptions,
                avgRevenuePerUser,
                timeFilter: timeFilter || 'all'
            }
        });
    } catch (error) {
        // Financial stats error suppressed
        res.status(500).json({ success: false, error: error.message });
    }
};

exports.getDashboardStats = async (req, res) => {
    try {
        const { timeFilter } = req.query;
        let dateQuery = {};

        const now = new Date();
        if (timeFilter === 'today') {
            const startOfDay = new Date(now.setHours(0, 0, 0, 0));
            dateQuery = { createdAt: { $gte: startOfDay } };
        } else if (timeFilter === 'yesterday') {
            const startOfYesterday = new Date(now); // Create a new Date object for yesterday's calculations
            startOfYesterday.setDate(startOfYesterday.getDate() - 1);
            startOfYesterday.setHours(0, 0, 0, 0);

            const endOfYesterday = new Date(now); // Create another new Date object for yesterday's end
            endOfYesterday.setDate(endOfYesterday.getDate() - 1);
            endOfYesterday.setHours(23, 59, 59, 999);
            dateQuery = { createdAt: { $gte: startOfYesterday, $lte: endOfYesterday } };
        } else if (timeFilter === '7days') {
            const last7Days = new Date(now); // Create a new Date object for 7 days ago
            last7Days.setDate(last7Days.getDate() - 7);
            dateQuery = { createdAt: { $gte: last7Days } };
        }

        // Stats based on filter (for registrations)
        const newRegistrations = await Seller.countDocuments(dateQuery);

        // Global stats (always total)
        const totalSellers = await Seller.countDocuments();
        const activeSellers = await Seller.countDocuments({ isActive: true });

        // Example: Get recent registrations (limit 5)
        const recentSellers = await Seller.find().sort({ createdAt: -1 }).limit(5).select('name email shopName createdAt');

        res.json({
            success: true,
            stats: {
                totalSellers,
                activeSellers,
                newRegistrations
            },
            recentSellers
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

exports.getSystemStatus = async (req, res) => {
    try {
        const mongoose = require('mongoose');
        const dbStatus = mongoose.connection.readyState === 1 ? 'operational' : 'disconnected';

        // Get database statistics
        let dbStats = null;
        let collections = [];

        if (mongoose.connection.readyState === 1) {
            try {
                // Get database stats
                const db = mongoose.connection.db;
                dbStats = await db.stats();

                // Get collection information
                const collectionsList = await db.listCollections().toArray();
                collections = await Promise.all(
                    collectionsList.map(async (col) => {
                        try {
                            const stats = await db.collection(col.name).stats();
                            return {
                                name: col.name,
                                count: stats.count || 0,
                                size: stats.size || 0,
                                storageSize: stats.storageSize || 0,
                                avgObjSize: stats.avgObjSize || 0
                            };
                        } catch (err) {
                            return {
                                name: col.name,
                                count: 0,
                                size: 0,
                                storageSize: 0,
                                avgObjSize: 0
                            };
                        }
                    })
                );
            } catch (dbError) {
                // Error fetching DB stats suppressed
            }
        }

        // Memory usage in MB
        const memUsage = process.memoryUsage();
        const formatMemory = (bytes) => (bytes / 1024 / 1024).toFixed(2);

        const metrics = {
            database: {
                status: dbStatus,
                host: mongoose.connection.host || 'N/A',
                name: mongoose.connection.name || 'N/A',
                readyState: mongoose.connection.readyState,
                stats: dbStats ? {
                    dataSize: dbStats.dataSize,
                    storageSize: dbStats.storageSize,
                    indexSize: dbStats.indexSize,
                    totalSize: dbStats.totalSize,
                    collections: dbStats.collections,
                    objects: dbStats.objects,
                    avgObjSize: dbStats.avgObjSize
                } : null,
                collections: collections
            },
            server: {
                status: 'running',
                uptime: Math.floor(process.uptime()),
                uptimeFormatted: formatUptime(process.uptime()),
                nodeVersion: process.version,
                platform: process.platform,
                memory: {
                    rss: formatMemory(memUsage.rss),
                    heapTotal: formatMemory(memUsage.heapTotal),
                    heapUsed: formatMemory(memUsage.heapUsed),
                    external: formatMemory(memUsage.external),
                    arrayBuffers: formatMemory(memUsage.arrayBuffers || 0)
                },
                cpu: {
                    user: process.cpuUsage().user,
                    system: process.cpuUsage().system
                },
                pid: process.pid
            },
            health: {
                overall: dbStatus === 'operational' ? 'healthy' : 'degraded',
                checks: {
                    database: dbStatus === 'operational',
                    memory: memUsage.heapUsed < memUsage.heapTotal * 0.9,
                    uptime: process.uptime() > 0
                }
            }
        };

        res.json({ success: true, system: metrics });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

// Helper function to format uptime
function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

    return parts.join(' ');
}

exports.getSellers = async (req, res) => {
    try {
        const sellers = await Seller.find().select('-password').sort({ createdAt: -1 });
        res.json({ success: true, sellers });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

exports.toggleSellerStatus = async (req, res) => {
    try {
        const seller = await Seller.findById(req.params.id);
        if (!seller) {
            return res.status(404).json({ success: false, message: 'Seller not found' });
        }

        seller.isActive = !seller.isActive;
        await seller.save();

        res.json({ success: true, message: `Seller ${seller.isActive ? 'activated' : 'blocked'} successfully`, isActive: seller.isActive });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

const Plan = require('../models/Plan');

/*** PLANS MANAGEMENT ***/

exports.getPlans = async (req, res) => {
    try {
        const plans = await Plan.find({ isDeleted: { $ne: true } }).sort({ price: 1 });
        res.json({ success: true, plans });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

exports.createPlan = async (req, res) => {
    try {
        const newPlan = new Plan(req.body);
        await newPlan.save();
        res.json({ success: true, plan: newPlan });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

exports.updatePlan = async (req, res) => {
    try {
        const plan = await Plan.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json({ success: true, plan });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

exports.deletePlan = async (req, res) => {
    try {
        // Soft delete
        const plan = await Plan.findByIdAndUpdate(req.params.id, { isDeleted: true }, { new: true });
        res.json({ success: true, message: 'Plan deleted' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

exports.getSellerDetails = async (req, res) => {
    try {
        const seller = await Seller.findById(req.params.id)
            .select('-password')
            .populate({
                path: 'currentPlanId',
                populate: { path: 'planId' }
            });

        if (!seller) return res.status(404).json({ success: false, message: 'Seller not found' });

        res.json({ success: true, seller });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

const Coupon = require('../models/Coupon');

/*** COUPONS MANAGEMENT ***/

exports.getCoupons = async (req, res) => {
    try {
        const coupons = await Coupon.find().sort({ createdAt: -1 });
        res.json({ success: true, coupons });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

exports.createCoupon = async (req, res) => {
    try {
        const newCoupon = new Coupon(req.body);
        await newCoupon.save();
        res.json({ success: true, coupon: newCoupon });
    } catch (error) {
        // Handle duplicate key error
        if (error.code === 11000) {
            return res.status(400).json({ success: false, message: 'Coupon code already exists' });
        }
        res.status(500).json({ success: false, error: error.message });
    }
};

exports.updateCoupon = async (req, res) => {
    try {
        const coupon = await Coupon.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json({ success: true, coupon });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

exports.deleteCoupon = async (req, res) => {
    try {
        await Coupon.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'Coupon deleted' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

const OnlineStore = require('../models/OnlineStore');

exports.getShops = async (req, res) => {
    try {
        const shops = await OnlineStore.find()
            .populate('sellerId', 'name email isActive')
            .sort({ createdAt: -1 });
        res.json({ success: true, shops });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

exports.getRequestStats = async (req, res) => {
    try {
        const RequestLog = require('../models/RequestLog');
        const { timeRange = '24h' } = req.query;

        const now = new Date();
        let startTime = new Date();
        let groupBy = {};

        switch (timeRange) {
            case '1h':
                startTime.setHours(startTime.getHours() - 1);
                // Group by minute
                groupBy = {
                    year: { $year: "$createdAt" },
                    month: { $month: "$createdAt" },
                    day: { $dayOfMonth: "$createdAt" },
                    hour: { $hour: "$createdAt" },
                    minute: { $minute: "$createdAt" }
                };
                break;
            case '6h':
                startTime.setHours(startTime.getHours() - 6);
                groupBy = {
                    year: { $year: "$createdAt" },
                    month: { $month: "$createdAt" },
                    day: { $dayOfMonth: "$createdAt" },
                    hour: { $hour: "$createdAt" }
                };
                break;
            case '7d':
                startTime.setDate(startTime.getDate() - 7);
                groupBy = {
                    year: { $year: "$createdAt" },
                    month: { $month: "$createdAt" },
                    day: { $dayOfMonth: "$createdAt" }
                };
                break;
            case '24h':
            default:
                startTime.setHours(startTime.getHours() - 24);
                groupBy = {
                    year: { $year: "$createdAt" },
                    month: { $month: "$createdAt" },
                    day: { $dayOfMonth: "$createdAt" },
                    hour: { $hour: "$createdAt" }
                };
                break;
        }

        const stats = await RequestLog.aggregate([
            { $match: { createdAt: { $gte: startTime } } },
            {
                $group: {
                    _id: groupBy,
                    count: { $sum: 1 },
                    avgDuration: { $avg: "$duration" },
                    errors: {
                        $sum: {
                            $cond: [{ $gte: ["$statusCode", 400] }, 1, 0]
                        }
                    }
                }
            },
            { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1, "_id.hour": 1, "_id.minute": 1 } }
        ]);

        // Format for frontend
        // Initialize empty buckets map
        const bucketMap = new Map();

        // Helper to zero-pad
        const pad = (n) => n < 10 ? '0' + n : n;

        // Generate all time slots based on range
        const iterateTime = new Date(startTime);
        const endTime = new Date(); // now

        if (timeRange === '1h') {
            while (iterateTime <= endTime) {
                const key = `${iterateTime.getFullYear()}-${pad(iterateTime.getMonth() + 1)}-${pad(iterateTime.getDate())}-${pad(iterateTime.getHours())}-${pad(iterateTime.getMinutes())}`;
                bucketMap.set(key, {
                    timestamp: new Date(iterateTime).toISOString(),
                    label: `${iterateTime.getHours()}:${pad(iterateTime.getMinutes())}`,
                    count: 0,
                    avgDuration: 0,
                    errors: 0
                });
                iterateTime.setMinutes(iterateTime.getMinutes() + 1);
            }
        } else if (timeRange === '7d') {
            // Normalize start time to beginning of day to align buckets
            const s = new Date(startTime); s.setHours(0, 0, 0, 0);
            const e = new Date(endTime); e.setHours(23, 59, 59, 999);

            // We iterate day by day
            const iter = new Date(s);
            while (iter <= e) {
                const key = `${iter.getFullYear()}-${pad(iter.getMonth() + 1)}-${pad(iter.getDate())}`; // Daily key
                bucketMap.set(key, {
                    timestamp: new Date(iter).toISOString(),
                    label: `${iter.getDate()}/${pad(iter.getMonth() + 1)}`,
                    count: 0,
                    avgDuration: 0,
                    errors: 0
                });
                iter.setDate(iter.getDate() + 1);
            }
        } else {
            // 6h or 24h -> Hourly buckets
            // Normalize to start of hour
            const iter = new Date(startTime); iter.setMinutes(0, 0, 0);
            while (iter <= endTime) {
                const key = `${iter.getFullYear()}-${pad(iter.getMonth() + 1)}-${pad(iter.getDate())}-${pad(iter.getHours())}`;
                bucketMap.set(key, {
                    timestamp: new Date(iter).toISOString(),
                    label: `${iter.getHours()}:00`,
                    count: 0,
                    avgDuration: 0,
                    errors: 0
                });
                iter.setHours(iter.getHours() + 1);
            }
        }

        // Merge db stats into bucket map
        stats.forEach(item => {
            const id = item._id;
            let key = '';
            if (timeRange === '1h') {
                key = `${id.year}-${pad(id.month)}-${pad(id.day)}-${pad(id.hour)}-${pad(id.minute)}`;
            } else if (timeRange === '7d') {
                key = `${id.year}-${pad(id.month)}-${pad(id.day)}`;
            } else {
                key = `${id.year}-${pad(id.month)}-${pad(id.day)}-${pad(id.hour)}`;
            }

            if (bucketMap.has(key)) {
                const bucket = bucketMap.get(key);
                bucket.count = item.count;
                bucket.avgDuration = Math.round(item.avgDuration);
                bucket.errors = item.errors;
            } else {
                // If aggregation returns a key not in our expected range (possible due to slight clock diffs), ignore or add?
                // Usually ignore is safe if we strictly generated the range, or we can add it. 
                // Let's just update if it exists to be safe.
            }
        });

        const formattedStats = Array.from(bucketMap.values());

        const totalRequests = formattedStats.reduce((acc, curr) => acc + curr.count, 0);
        const totalErrors = formattedStats.reduce((acc, curr) => acc + curr.errors, 0);

        res.json({
            success: true,
            data: formattedStats,
            summary: {
                totalRequests,
                totalErrors,
                errorRate: totalRequests ? ((totalErrors / totalRequests) * 100).toFixed(2) : 0
            }
        });

    } catch (error) {
        // Request stats error suppressed
        res.status(500).json({ success: false, error: error.message });
    }
};
