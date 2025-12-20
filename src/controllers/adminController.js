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

        res.json({
            success: true,
            token,
            admin: {
                id: admin._id,
                name: admin.name,
                email: admin.email
            }
        });
    } catch (error) {
        console.error('Admin login error:', error);
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
        console.error('Financial stats error:', error);
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
                console.error('Error fetching DB stats:', dbError);
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
