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

  let modified = false;

  for (const mapping of mappings) {
    const currentValue = planOrder[mapping.orderField];
    const planValue = normalizeLimitValue(planDoc[mapping.planField]);

    // Apply if missing
    if (currentValue === undefined || currentValue === null) {
      planOrder[mapping.orderField] = planValue;
      modified = true;
    }
    // FIX: If current limit is 0 but Plan has a positive limit, update it (assumes 0 is error state for paid plans)
    else if (currentValue === 0 && typeof planValue === 'number' && planValue > 0) {
      planOrder[mapping.orderField] = planValue;
      modified = true;
    }

    if (planOrder[mapping.currentField] === undefined || planOrder[mapping.currentField] === null) {
      planOrder[mapping.currentField] = 0;
      modified = true;
    }
  }
  return modified;
};

// ... (bootstrapPlanForSeller remains same) ...

const getPlanUsageSummary = async (sellerId) => {
  const planEntries = await loadPlanOrdersWithPlans(sellerId, true); // Include expired plans for summary
  const summary = {
    customers: { limit: 0, used: 0, remaining: 0, isUnlimited: false },
    products: { limit: 0, used: 0, remaining: 0, isUnlimited: false },
    orders: { limit: 0, used: 0, remaining: 0, isUnlimited: false },
  };

  const planDetails = [];

  // Iterate properly to allow async saves
  for (const entry of planEntries) {
    const { order, plan, remainingMs, isExpired } = entry;
    let orderModified = ensurePlanLimitsApplied(order, plan);

    // For expired plans, ensure status is marked as expired
    if (isExpired && order.status === 'active') {
      order.status = 'expired';
      orderModified = true;
    }

    // Persist fixes to DB if needed
    if (orderModified) {
      try {
        await order.save();
      } catch (err) {
        console.error('Failed to save plan order updates:', err);
      }
    }

    const actualStatus = isExpired ? 'expired' : order.status;

    const detail = {
      planOrderId: order._id.toString(),
      planId: plan._id.toString(),
      planType: order.planType || plan.planType,
      planName: plan.name,
      expiryDate: order.expiryDate,
      status: actualStatus,
      remainingMs,
      remaining: formatRemaining(remainingMs),
      isExpired,
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: order.razorpayPaymentId,
      durationDays: order.durationDays,
      unlockedModules: order.unlockedModules,
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
  }

  // Separate active for summary calculation
  const activeEntries = planEntries.filter(({ isExpired }) => !isExpired);

  // 1. Process Limits (Active plans only)
  activeEntries.forEach(({ order, plan }) => {
    ensurePlanLimitsApplied(order, plan);

    const applyLimitToSummary = (type) => {
      const cfg = TYPE_CONFIG[type];
      const limitValue = order[cfg.limitField];

      if (limitValue === null || limitValue === undefined) {
        summary[type].isUnlimited = true;
      } else if (!summary[type].isUnlimited) {
        summary[type].limit += limitValue;
      }
    };

    applyLimitToSummary('customers');
    applyLimitToSummary('products');
    applyLimitToSummary('orders');
  });

  // 2. Process Usage (Active plans only)
  activeEntries.forEach(({ order, plan }) => {
    ensurePlanLimitsApplied(order, plan);

    const applyUsageToSummary = (type) => {
      const cfg = TYPE_CONFIG[type];
      const currentValue = order[cfg.currentField] || 0;
      summary[type].used += currentValue;
    };

    applyUsageToSummary('customers');
    applyUsageToSummary('products');
    applyUsageToSummary('orders');
  });

  ['customers', 'products', 'orders'].forEach((type) => {
    // If limit is 0, force used to 0 as well to avoid confusion
    if (!summary[type].isUnlimited && summary[type].limit === 0) {
      summary[type].used = 0;
    }

    if (summary[type].isUnlimited) {
      summary[type].remaining = null;
    } else {
      summary[type].remaining = Math.max(0, summary[type].limit - summary[type].used);
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
    // Error refreshing plan usage summary suppressed
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

