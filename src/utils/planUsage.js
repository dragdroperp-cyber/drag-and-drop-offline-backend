const PlanOrder = require('../models/PlanOrder');
const Seller = require('../models/Seller');
const Plan = require('../models/Plan');
const SyncTracking = require('../models/SyncTracking');
const { computeRemainingMs, getPlanDurationMs, formatRemaining } = require('./planTimers');

const TYPE_CONFIG = {
  customers: {
    limitField: 'customerLimit',
    currentField: 'customerCurrentCount',
    planField: 'maxCustomers',
  },
  products: {
    limitField: 'productLimit',
    currentField: 'productCurrentCount',
    planField: 'maxProducts',
  },
  orders: {
    limitField: 'orderLimit',
    currentField: 'orderCurrentCount',
    planField: 'maxOrders',
  },
};

const loadPlanOrdersWithPlans = async (sellerId, includeExpired = false) => {
  const planOrders = await PlanOrder.find({
    sellerId,
    paymentStatus: 'completed',
  }).populate('planId');

  const now = new Date();
  return planOrders
    .map((order) => {
      const planDoc = order.planId;
      const remainingMs = planDoc ? computeRemainingMs(order, planDoc, now) : 0;
      return {
        order,
        plan: planDoc,
        remainingMs,
        isExpired: remainingMs <= 0,
        now,
      };
    })
    .filter(({ plan }) => plan)
    .filter(({ remainingMs, isExpired }) => includeExpired ? true : remainingMs > 0);
};

const normalizeLimitValue = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (value < 0) return null;
    return value;
  }
  return null;
};

const ensurePlanLimitsApplied = (planOrder, planDoc) => {
  const mappings = [
    { orderField: 'customerLimit', planField: 'maxCustomers', currentField: 'customerCurrentCount' },
    { orderField: 'productLimit', planField: 'maxProducts', currentField: 'productCurrentCount' },
    { orderField: 'orderLimit', planField: 'maxOrders', currentField: 'orderCurrentCount' },
  ];

  for (const mapping of mappings) {
    if (planOrder[mapping.orderField] === undefined || planOrder[mapping.orderField] === null) {
      planOrder[mapping.orderField] = normalizeLimitValue(planDoc[mapping.planField]);
    }
    if (planOrder[mapping.currentField] === undefined || planOrder[mapping.currentField] === null) {
      planOrder[mapping.currentField] = 0;
    }
  }
};

const bootstrapPlanForSeller = async (sellerId) => {
  try {
    if (!sellerId) {
      return [];
    }

    const seller = await Seller.findById(sellerId);
    if (!seller) {
      return [];
    }

    const now = new Date();

    // Attempt to reuse the most recent completed plan order (even if expired)
    const existingOrder = await PlanOrder.findOne({
      sellerId,
      paymentStatus: 'completed',
    })
      .sort({ createdAt: -1 })
      .populate('planId');

    const revivePlanOrderIfPossible = async (planOrder, planDoc) => {
      ensurePlanLimitsApplied(planOrder, planDoc);
      planOrder.status = 'active';
      planOrder.lastActivatedAt = now;
      const totalDurationMs = getPlanDurationMs(planDoc) || (planOrder.durationDays || 30) * 24 * 60 * 60 * 1000;
      const newExpiry = new Date(now.getTime() + totalDurationMs);
      planOrder.expiryDate = newExpiry;
      await planOrder.save();

      if (!seller.currentPlanId || !seller.currentPlanId.equals(planOrder._id)) {
        seller.currentPlanId = planOrder._id;
        await seller.save();
      }

      const remainingMs = computeRemainingMs(planOrder, planDoc, now);
      return [{
        order: planOrder,
        plan: planDoc,
        remainingMs,
        now,
      }];
    };

    if (existingOrder && existingOrder.planId) {
      const planDoc = existingOrder.planId;
      return await revivePlanOrderIfPossible(existingOrder, planDoc);
    }

    // Create a default free plan order if none exists
    const defaultPlan = await Plan.findOne({ isActive: true, price: 0 }).sort({ durationDays: -1, createdAt: -1 });
    if (!defaultPlan) {
      return [];
    }

    const durationDays = defaultPlan.durationDays || 30;
    const expiryDate = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

    const planOrder = new PlanOrder({
      sellerId,
      planId: defaultPlan._id,
      expiryDate,
      durationDays,
      price: defaultPlan.price || 0,
      paymentStatus: 'completed',
      status: 'active',
      lastActivatedAt: now,
      accumulatedUsedMs: 0,
      customerLimit: defaultPlan.maxCustomers ?? null,
      productLimit: defaultPlan.maxProducts ?? null,
      orderLimit: defaultPlan.maxOrders ?? null,
      customerCurrentCount: 0,
      productCurrentCount: 0,
      orderCurrentCount: 0,
    });

    ensurePlanLimitsApplied(planOrder, defaultPlan);
    await planOrder.save();

    // Update sync tracking for automatic free plan assignment
    try {
      await SyncTracking.updateLatestTime(sellerId, 'planOrders');
      //(`🔄 Sync tracking updated: planOrders for automatic free plan assignment ${planOrder._id}`);
    } catch (trackingError) {
      console.error('Error updating sync tracking for automatic free plan assignment:', trackingError);
    }

    seller.currentPlanId = planOrder._id;
    await seller.save();

    const remainingMs = computeRemainingMs(planOrder, defaultPlan, now);

    return [{
      order: planOrder,
      plan: defaultPlan,
      remainingMs,
      now,
    }];
  } catch (error) {
    console.error('Error bootstrapping plan for seller:', error);
    return [];
  }
};

const getPlanUsageSummary = async (sellerId) => {
  const planEntries = await loadPlanOrdersWithPlans(sellerId, true); // Include expired plans for summary
  const summary = {
    customers: { limit: 0, used: 0, remaining: 0, isUnlimited: false },
    products: { limit: 0, used: 0, remaining: 0, isUnlimited: false },
    orders: { limit: 0, used: 0, remaining: 0, isUnlimited: false },
  };

  const planDetails = [];

  // Separate active and expired plans
  const activeEntries = planEntries.filter(({ isExpired }) => !isExpired);
  const expiredEntries = planEntries.filter(({ isExpired }) => isExpired);

  // Use active plans first, fall back to expired plans if no active plans exist
  const entriesToUse = activeEntries.length > 0 ? activeEntries : expiredEntries;

  planEntries.forEach(({ order, plan, remainingMs, isExpired }) => {
    ensurePlanLimitsApplied(order, plan);

    // For expired plans, ensure status is marked as expired
    const actualStatus = isExpired ? 'expired' : order.status;

    const detail = {
      planOrderId: order._id.toString(),
      planId: plan._id.toString(),
      planName: plan.name,
      expiryDate: order.expiryDate,
      status: actualStatus,
      remainingMs,
      remaining: formatRemaining(remainingMs),
      isExpired,
      limits: {
        customers: order.customerLimit,
        products: order.productLimit,
        orders: order.orderLimit,
      },
      usage: {
        customers: order.customerCurrentCount || 0,
        products: order.productCurrentCount || 0,
        orders: order.orderCurrentCount || 0,
      },
    };
    planDetails.push(detail);
  });

  // Calculate summary using active plans first, then expired plans as fallback
  entriesToUse.forEach(({ order, plan, remainingMs }) => {
    ensurePlanLimitsApplied(order, plan);

    const applyToSummary = (type) => {
      const cfg = TYPE_CONFIG[type];
      const limitValue = order[cfg.limitField];
      const currentValue = order[cfg.currentField] || 0;

      if (limitValue === null || limitValue === undefined) {
        summary[type].isUnlimited = true;
      } else if (!summary[type].isUnlimited) {
        summary[type].limit += limitValue;
      }

      summary[type].used += currentValue;
    };

    applyToSummary('customers');
    applyToSummary('products');
    applyToSummary('orders');
  });

  ['customers', 'products', 'orders'].forEach((type) => {
    if (summary[type].isUnlimited) {
      summary[type].remaining = null;
    } else {
      summary[type].remaining = summary[type].limit - summary[type].used;
    }
  });

  return { summary, planDetails };
};

const checkDistributedLimit = async (sellerId, type, count = 1) => {
  const config = TYPE_CONFIG[type];
  if (!config) {
    return { canAdd: false, message: `Unknown usage type: ${type}` };
  }

  const planEntries = await loadPlanOrdersWithPlans(sellerId);
  if (planEntries.length === 0) {
    return { canAdd: false, message: 'No active plans found. Please upgrade your plan.' };
  }

  planEntries.forEach(({ order, plan }) => ensurePlanLimitsApplied(order, plan));

  const { limitField, currentField } = config;
  let totalAvailableCapacity = 0;
  let hasUnlimitedPlan = false;

  // Calculate total available capacity across all valid plan orders
  for (const entry of planEntries) {
    const { order } = entry;
    const limit = order[limitField];
    const current = order[currentField] || 0;

    if (limit === null || limit === undefined) {
      // Unlimited plan
      hasUnlimitedPlan = true;
      totalAvailableCapacity = Infinity;
      break;
    } else {
      const capacity = limit - current;
      totalAvailableCapacity += Math.max(0, capacity);
    }
  }

  if (hasUnlimitedPlan) {
    return { canAdd: true, availableCapacity: Infinity, totalCapacity: Infinity };
  }

  const canAdd = totalAvailableCapacity >= count;
  const message = canAdd
    ? null
    : `You've reached the limit across all your plans. Total available capacity: ${totalAvailableCapacity}. Please upgrade your plan to add more ${type}.`;

  return {
    canAdd,
    availableCapacity: totalAvailableCapacity,
    totalCapacity: totalAvailableCapacity,
    message
  };
};

const adjustPlanUsage = async (sellerId, type, delta = 0) => {
  if (!delta || delta === 0) {
    return { success: true, deltaApplied: 0 };
  }
  const config = TYPE_CONFIG[type];
  if (!config) {
    return { success: false, message: `Unknown usage type: ${type}` };
  }

  let planEntries = await loadPlanOrdersWithPlans(sellerId);

  if (planEntries.length === 0 && delta > 0) {
    planEntries = await bootstrapPlanForSeller(sellerId);
  }

  if (planEntries.length === 0) {
    if (delta > 0) {
      return {
        success: false,
        message: 'No active plans found. Please upgrade your plan.',
        deltaApplied: 0,
      };
    }
    return { success: true, deltaApplied: 0 };
  }

  planEntries.forEach(({ order, plan }) => ensurePlanLimitsApplied(order, plan));

  // Sort plans: prioritize active plans, then by expiry date, then by creation date
  const comparePlans = (a, b) => {
    if (a.order.status === 'active' && b.order.status !== 'active') return -1;
    if (a.order.status !== 'active' && b.order.status === 'active') return 1;
    const aExpiry = a.order.expiryDate ? a.order.expiryDate.getTime() : Infinity;
    const bExpiry = b.order.expiryDate ? b.order.expiryDate.getTime() : Infinity;
    if (aExpiry !== bExpiry) return aExpiry - bExpiry;
    return a.order.createdAt.getTime() - b.order.createdAt.getTime();
  };

  planEntries.sort(comparePlans);

  const { limitField, currentField } = config;
  let remainingDelta = delta;
  const plansUpdated = new Set();

  if (delta > 0) {
    // For additions: distribute across plans with available capacity
    for (const entry of planEntries) {
      if (remainingDelta <= 0) break;
      const { order } = entry;
      const limit = order[limitField];
      const current = order[currentField] || 0;
      const capacity = limit === null ? Infinity : limit - current;
      if (capacity <= 0) continue;
      const increment = limit === null ? remainingDelta : Math.min(remainingDelta, capacity);
      order[currentField] = current + increment;
      plansUpdated.add(order);
      remainingDelta -= increment;
    }
  } else if (delta < 0) {
    // For deletions: reduce from plans (preferably recently used ones)
    for (const entry of planEntries.slice().reverse()) {
      if (remainingDelta >= 0) break;
      const { order } = entry;
      const current = order[currentField] || 0;
      if (current <= 0) continue;
      const decrement = Math.min(current, Math.abs(remainingDelta));
      order[currentField] = current - decrement;
      plansUpdated.add(order);
      remainingDelta += decrement;
    }
  }

  if (remainingDelta !== 0) {
    const limitCheck = await checkDistributedLimit(sellerId, type, Math.abs(remainingDelta));
    return {
      success: false,
      message: limitCheck.message || 'Upgrade your plan to increase limit.',
      deltaApplied: delta - remainingDelta,
      remainingDelta,
    };
  }

  await Promise.all(Array.from(plansUpdated).map((order) => order.save()));

  let updatedSummary = null;
  try {
    updatedSummary = await getPlanUsageSummary(sellerId);
  } catch (error) {
    console.error('Error refreshing plan usage summary:', error);
  }

  return {
    success: true,
    deltaApplied: delta,
    summary: updatedSummary ? updatedSummary.summary : null,
    planDetails: updatedSummary ? updatedSummary.planDetails : null,
  };
};

module.exports = {
  getPlanUsageSummary,
  adjustPlanUsage,
  checkDistributedLimit,
};

