const mongoose = require('mongoose');
const Plan = require('../models/Plan');
const PlanOrder = require('../models/PlanOrder');
const Seller = require('../models/Seller');
const SyncTracking = require('../models/SyncTracking');
const { computeRemainingMs, formatRemaining, getPlanDurationMs } = require('../utils/planTimers');
const { getPlanUsageSummary } = require('../utils/planUsage');
const applyPlanLimitsToOrder = (planOrder, planDoc) => {
  if (!planOrder || !planDoc) return false;
  let mutated = false;
  if (planOrder.customerLimit === undefined || planOrder.customerLimit === null) {
    planOrder.customerLimit = planDoc.maxCustomers ?? null;
    mutated = true;
  }
  if (planOrder.productLimit === undefined || planOrder.productLimit === null) {
    planOrder.productLimit = planDoc.maxProducts ?? null;
    mutated = true;
  }
  if (planOrder.orderLimit === undefined || planOrder.orderLimit === null) {
    planOrder.orderLimit = planDoc.maxOrders ?? null;
    mutated = true;
  }
  if (typeof planOrder.customerCurrentCount !== 'number') {
    planOrder.customerCurrentCount = 0;
    mutated = true;
  }
  if (typeof planOrder.productCurrentCount !== 'number') {
    planOrder.productCurrentCount = 0;
    mutated = true;
  }
  if (typeof planOrder.orderCurrentCount !== 'number') {
    planOrder.orderCurrentCount = 0;
    mutated = true;
  }
  return mutated;
};

/**
 * Ensure seller exists and return instance.
 */
const loadSeller = async (sellerId) => {
  if (!sellerId) {
    return null;
  }
  if (!mongoose.Types.ObjectId.isValid(sellerId)) {
    return null;
  }
  return Seller.findById(sellerId);
};

/**
 * Load all plan orders for the seller with plan populated.
 */
const loadSellerPlanOrders = (sellerId) => {
  return PlanOrder.find({ sellerId }).populate('planId');
};

/**
 * Pause an active plan order and accumulate elapsed duration.
 */
const pausePlanOrder = (planOrder, now) => {
  if (!planOrder) return;

  if (planOrder.status === 'active' && planOrder.lastActivatedAt) {
    const elapsed = now.getTime() - planOrder.lastActivatedAt.getTime();
    if (elapsed > 0) {
      planOrder.accumulatedUsedMs += elapsed;
    }
    planOrder.lastActivatedAt = null;
  }

  if (planOrder.status !== 'expired') {
    planOrder.status = 'paused';
  }
};

/**
 * Update expiryDate based on current remaining milliseconds.
 */
const refreshExpiryDate = (planOrder, planDoc, remainingMs, now) => {
  if (!planOrder || !planDoc) return;

  // CRITICAL: If the plan is already expired, do NOT touch its expiry date.
  // This prevents the expiry date from "creeping" forward every time a refresh happens.
  if (planOrder.status === 'expired') {
    return;
  }

  if (remainingMs <= 0) {
    planOrder.status = 'expired';
    // Only set expiryDate to 'now' if it wasn't already set to something in the past
    if (!planOrder.expiryDate || planOrder.expiryDate > now) {
      planOrder.expiryDate = now;
    }
    planOrder.lastActivatedAt = null;
    planOrder.accumulatedUsedMs = getPlanDurationMs(planOrder);
    return;
  }

  planOrder.expiryDate = new Date(now.getTime() + remainingMs);
};

/**
 * Core business logic for activating or switching plans.
 * Returns a structured result so it can be reused by other controllers.
 */
const setActivePlanForSeller = async ({ sellerId, planId, planOrderId, allowCreateOnMissing = true }) => {
  try {
    if (!sellerId) {
      return { success: false, statusCode: 401, message: 'Seller ID is required' };
    }

    const seller = await loadSeller(sellerId);
    if (!seller) {
      return { success: false, statusCode: 404, message: 'Seller not found' };
    }

    const now = new Date();
    const planOrders = await loadSellerPlanOrders(sellerId);

    let targetPlanOrder = null;
    let targetPlanDoc = null;

    if (planOrderId) {
      targetPlanOrder = planOrders.find((order) => order._id.equals(planOrderId));
      if (!targetPlanOrder) {
        return { success: false, statusCode: 404, message: 'Plan order not found for seller' };
      }
      targetPlanDoc = targetPlanOrder.planId || (await Plan.findById(targetPlanOrder.planId));
      targetPlanOrder.planId = targetPlanDoc;
    } else if (planId) {
      // First, get the plan document to check planType
      if (!targetPlanDoc) {
        targetPlanDoc = await Plan.findById(planId);
      }

      // For mini plans, always create a new order (allow multiple top-ups)
      // For other plans, try to find existing order
      if (targetPlanDoc && targetPlanDoc.planType === 'mini') {
        // Always create new order for mini plans to allow multiple top-ups
        targetPlanOrder = null;
      } else {
        targetPlanOrder = planOrders.find(
          (order) => order.planId && order.planId._id && order.planId._id.equals(planId)
        );

        if (targetPlanOrder) {
          targetPlanDoc = targetPlanOrder.planId || (await Plan.findById(targetPlanOrder.planId));

          const remainingForExisting = computeRemainingMs(targetPlanOrder, targetPlanDoc, now);
          if (remainingForExisting <= 0 && allowCreateOnMissing) {
            targetPlanOrder = null;
            targetPlanDoc = null;
          }
        } else {
          if (!allowCreateOnMissing) {
            return { success: false, statusCode: 404, message: 'Plan not assigned to seller' };
          }
        }
      }
    } else {
      return {
        success: false,
        statusCode: 400,
        message: 'Either planId or planOrderId must be provided',
      };
    }

    if (!targetPlanOrder) {
      if (!targetPlanDoc) {
        targetPlanDoc = await Plan.findById(planId || (planOrderId && targetPlanOrder && targetPlanOrder.planId));
      }

      if (!targetPlanDoc) {
        return { success: false, statusCode: 404, message: 'Plan not found' };
      }

      // For mini plans, allow creating new orders even if paid (to allow multiple top-ups)
      // For other plans, only allow creating free plans here
      if (targetPlanDoc.price && targetPlanDoc.price > 0 && targetPlanDoc.planType !== 'mini') {
        return {
          success: false,
          statusCode: 400,
          message: 'Payment required to activate this plan'
        };
      }

      const totalDurationMs = getPlanDurationMs(targetPlanDoc);
      const initialExpiry = new Date(now.getTime() + totalDurationMs);

      // Mini plans always require payment (even if price is 0)
      // Other plans: pending if price > 0, completed if free
      const paymentStatus = targetPlanDoc.planType === 'mini'
        ? 'pending'
        : (targetPlanDoc.price && targetPlanDoc.price > 0 ? 'pending' : 'completed');

      // Mini plans are now created with 'active' status (they activate immediately)
      // Other plans are created with 'paused' status and will be activated later
      const isMiniPlan = targetPlanDoc.planType === 'mini';

      targetPlanOrder = new PlanOrder({
        sellerId,
        planId: targetPlanDoc._id,
        planType: targetPlanDoc.planType || null,
        expiryDate: initialExpiry,
        durationDays: targetPlanDoc.durationDays,
        price: targetPlanDoc.price || 0,
        status: isMiniPlan ? 'active' : 'paused', // Mini plans start active, others start paused
        lastActivatedAt: isMiniPlan ? now : null,
        accumulatedUsedMs: 0,
        paymentStatus: paymentStatus,
        customerLimit: targetPlanDoc.maxCustomers ?? null,
        productLimit: targetPlanDoc.maxProducts ?? null,
        orderLimit: targetPlanDoc.maxOrders ?? null,
        customerCurrentCount: 0,
        productCurrentCount: 0,
        orderCurrentCount: 0,
      });

      planOrders.push(targetPlanOrder);
    }

    if (!targetPlanDoc) {
      targetPlanDoc = await Plan.findById(targetPlanOrder.planId);
      targetPlanOrder.planId = targetPlanDoc;
    }

    if (!targetPlanDoc) {
      return { success: false, statusCode: 404, message: 'Plan details not found' };
    }

    // For mini plans, allow creating orders with pending payment (for multiple top-ups)
    // For other plans, payment must be completed before activation
    const isMiniPlan = targetPlanDoc.planType === 'mini';
    if (targetPlanOrder.paymentStatus && targetPlanOrder.paymentStatus.toLowerCase() !== 'completed' && !isMiniPlan) {
      return {
        success: false,
        statusCode: 400,
        message: 'Payment not completed for this plan order'
      };
    }

    // For mini plans with pending payment, just create the order but don't activate it yet
    if (isMiniPlan && targetPlanOrder.paymentStatus && targetPlanOrder.paymentStatus.toLowerCase() !== 'completed') {
      await targetPlanOrder.save();

      // Update sync tracking for new plan order creation
      try {
        await SyncTracking.updateLatestTime(sellerId, 'planOrders');
      } catch (trackingError) {
        // Error updating sync tracking for mini plan order creation suppressed
      }

      return {
        success: true,
        statusCode: 200,
        message: 'Plan order created. Please complete payment to activate.',
        data: {
          planOrderId: targetPlanOrder._id.toString(),
          planId: targetPlanDoc._id.toString(),
          planName: targetPlanDoc.name,
          status: targetPlanOrder.status,
          paymentStatus: targetPlanOrder.paymentStatus,
          requiresPayment: true,
        },
      };
    }

    const limitsMutated = applyPlanLimitsToOrder(targetPlanOrder, targetPlanDoc);

    if (targetPlanOrder.status === 'active' && seller.currentPlanId && seller.currentPlanId.equals(targetPlanOrder._id)) {
      const remainingMs = computeRemainingMs(targetPlanOrder, targetPlanDoc, now);
      refreshExpiryDate(targetPlanOrder, targetPlanOrder, remainingMs, now);
      await targetPlanOrder.save();

      return {
        success: true,
        statusCode: 200,
        message: 'Plan already active',
        data: {
          planOrderId: targetPlanOrder._id.toString(),
          planId: targetPlanDoc._id.toString(),
          planName: targetPlanDoc.name,
          status: targetPlanOrder.status,
          remainingMs,
          remaining: formatRemaining(remainingMs),
          expiryDate: targetPlanOrder.expiryDate,
        },
      };
    }

    const savePromises = [];
    for (const order of planOrders) {
      if (!order._id || order._id.equals(targetPlanOrder._id)) {
        continue;
      }

      const planDoc = order.planId || (await Plan.findById(order.planId));
      if (!planDoc) {
        continue;
      }

      applyPlanLimitsToOrder(order, planDoc);
      pausePlanOrder(order, now);
      const remainingMs = computeRemainingMs(order, planDoc, now);
      refreshExpiryDate(order, order, remainingMs, now);
      savePromises.push(order.save());
    }

    // For mini plans, activate them normally - they are now fully active plans
    // Mini plans are top-ups that don't switch the current plan but are still active
    const planType = targetPlanDoc?.planType || (targetPlanOrder?.planId && typeof targetPlanOrder.planId === 'object' ? targetPlanOrder.planId.planType : null);
    if (planType === 'mini') {
      // Mini plan: activate it normally but don't switch current plan
      const remainingMs = computeRemainingMs(targetPlanOrder, targetPlanDoc, now);
      if (remainingMs <= 0) {
        refreshExpiryDate(targetPlanOrder, targetPlanDoc, 0, now);
        await targetPlanOrder.save();
        return {
          success: false,
          statusCode: 400,
          message: 'Plan validity has expired',
        };
      }

      // Activate mini plan normally
      targetPlanOrder.status = 'active';
      targetPlanOrder.lastActivatedAt = now;
      refreshExpiryDate(targetPlanOrder, targetPlanOrder, remainingMs, now);
      await targetPlanOrder.save();

      // Update sync tracking for mini plan activation
      try {
        await SyncTracking.updateLatestTime(sellerId, 'planOrders');
      } catch (trackingError) {
        // Error updating sync tracking for mini plan activation suppressed
      }

      return {
        success: true,
        statusCode: 200,
        message: 'Mini plan top-up purchased successfully. Plan order created and ready to use.',
        data: {
          planOrderId: targetPlanOrder._id.toString(),
          planId: targetPlanDoc._id.toString(),
          planName: targetPlanDoc.name,
          status: targetPlanOrder.status, // Will be 'active'
          remainingMs,
          remaining: formatRemaining(remainingMs),
          expiryDate: targetPlanOrder.expiryDate,
          isTopUp: true,
        },
      };
    }

    // For non-mini plans, proceed with normal activation
    const remainingMsBeforeActivation = computeRemainingMs(targetPlanOrder, targetPlanDoc, now);
    if (remainingMsBeforeActivation <= 0) {
      refreshExpiryDate(targetPlanOrder, targetPlanDoc, 0, now);
      await Promise.all([...savePromises, targetPlanOrder.save()]);
      return {
        success: false,
        statusCode: 400,
        message: 'Plan validity has expired',
      };
    }

    targetPlanOrder.status = 'active';
    targetPlanOrder.lastActivatedAt = now;
    refreshExpiryDate(targetPlanOrder, targetPlanOrder, remainingMsBeforeActivation, now);

    savePromises.push(targetPlanOrder.save());

    // For non-mini plans, update the seller's currentPlanId
    // Mini plans are top-ups and should NEVER be stored as the seller's currentPlanId
    if (planType && planType !== 'mini') {
      seller.currentPlanId = targetPlanOrder._id;
      savePromises.push(seller.save());
    }

    await Promise.all(savePromises);

    // Update sync tracking for plan activation
    try {
      await SyncTracking.updateLatestTime(sellerId, 'planOrders');
    } catch (trackingError) {
      // Error updating sync tracking for plan activation suppressed
    }

    const remainingMs = computeRemainingMs(targetPlanOrder, targetPlanDoc, now);

    return {
      success: true,
      statusCode: 200,
      message: 'Plan activated successfully',
      data: {
        planOrderId: targetPlanOrder._id.toString(),
        planId: targetPlanDoc._id.toString(),
        planName: targetPlanDoc.name,
        status: targetPlanOrder.status,
        remainingMs,
        remaining: formatRemaining(remainingMs),
        expiryDate: targetPlanOrder.expiryDate,
      },
    };
  } catch (error) {
    // Activate plan error suppressed
    return {
      success: false,
      statusCode: 500,
      message: 'Internal server error',
      error: error.message,
    };
  }
};

/**
 * Activate a plan (creating a plan order if needed).
 */
const activatePlan = async (req, res) => {
  const { planId, planOrderId } = req.body;
  const result = await setActivePlanForSeller({
    sellerId: req.sellerId,
    planId,
    planOrderId,
    allowCreateOnMissing: true,
  });

  if (!result.success) {
    return res.status(result.statusCode || 500).json({
      success: false,
      message: result.message,
      error: result.error,
    });
  }

  return res.status(result.statusCode || 200).json({
    success: true,
    message: result.message,
    data: result.data,
  });
};

/**
 * Automatically switch to a valid alternative plan if current plan is expired
 */
const switchToValidPlan = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    //(`🔄 switchToValidPlan called for seller: ${sellerId}`);

    if (!sellerId) {
      //('❌ switchToValidPlan: Seller ID is required');
      return res.status(401).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    const seller = await loadSeller(sellerId);
    if (!seller) {
      //('❌ switchToValidPlan: Seller not found');
      return res.status(404).json({
        success: false,
        message: 'Seller not found'
      });
    }

    //(`🔄 switchToValidPlan: Seller found: ${seller.name}, currentPlanId: ${seller.currentPlanId}`);

    const planOrders = await loadSellerPlanOrders(sellerId);
    //(`🔄 switchToValidPlan: Found ${planOrders.length} plan orders`);
    const now = new Date();

    // Check if current plan is expired
    let currentPlanExpired = true;
    if (seller.currentPlanId) {
      const currentPlanOrder = planOrders.find(order => order._id.equals(seller.currentPlanId));
      if (currentPlanOrder) {
        const remainingMs = computeRemainingMs(currentPlanOrder, currentPlanOrder.planId, now);
        //(`🔄 switchToValidPlan: Current plan ${currentPlanOrder._id} - status: ${currentPlanOrder.status}, remainingMs: ${remainingMs}`);
        if (remainingMs > 0 && currentPlanOrder.status !== 'expired') {
          currentPlanExpired = false;
        }
      } else {
        //(`🔄 switchToValidPlan: Current plan order ${seller.currentPlanId} not found in planOrders`);
      }
    } else {
      //(`🔄 switchToValidPlan: No currentPlanId set for seller`);
    }

    //(`🔄 switchToValidPlan: Current plan expired: ${currentPlanExpired}`);

    if (!currentPlanExpired) {
      //(`✅ switchToValidPlan: Current plan is still valid, no switching needed`);
      return res.status(400).json({
        success: false,
        message: 'Current plan is still valid'
      });
    }

    // Find valid alternative plans (active or paused with remaining time)
    // Include ALL plans except the current expired one, and check if they have any remaining time
    const validPlanOrders = planOrders.filter(order => {
      // Skip the current plan order since it's expired
      if (seller.currentPlanId && order._id.equals(seller.currentPlanId)) {
        //(`⏭️ switchToValidPlan: Skipping current expired plan ${order._id}`);
        return false;
      }

      const remainingMs = computeRemainingMs(order, order.planId, now);
      const isValid = remainingMs > 0 && order.status !== 'expired';
      //(`🔄 switchToValidPlan: Plan ${order._id} (${order.planId?.name || 'Unknown'}) - status: ${order.status}, remainingMs: ${remainingMs}, valid: ${isValid}`);
      return isValid;
    });

    //(`🔄 switchToValidPlan: Found ${validPlanOrders.length} valid alternative plans`);

    if (validPlanOrders.length === 0) {
      //(`❌ switchToValidPlan: No valid alternative plans found`);
      return res.status(404).json({
        success: false,
        message: 'No valid alternative plans found'
      });
    }

    // Sort by expiry date (most time remaining first) and pick the best one
    validPlanOrders.sort((a, b) => {
      const aRemaining = computeRemainingMs(a, a.planId, now);
      const bRemaining = computeRemainingMs(b, b.planId, now);
      return bRemaining - aRemaining;
    });

    const bestAlternative = validPlanOrders[0];
    //(`🔄 Switching expired current plan to valid alternative: ${bestAlternative.planId.name} for seller ${seller.name}`);

    // Use setActivePlanForSeller to properly switch plans
    const switchResult = await setActivePlanForSeller({
      sellerId: seller._id,
      planOrderId: bestAlternative._id.toString(),
      allowCreateOnMissing: false,
    });

    if (!switchResult.success) {
      return res.status(switchResult.statusCode || 500).json({
        success: false,
        message: `Failed to switch to alternative plan: ${switchResult.message}`,
        error: switchResult.error,
      });
    }

    //(`✅ Successfully switched to alternative plan: ${bestAlternative.planId.name} for seller ${seller.name}`);

    return res.status(200).json({
      success: true,
      message: `Successfully switched to ${bestAlternative.planId.name}`,
      data: switchResult.data,
    });

  } catch (error) {
    // Switch to valid plan error suppressed
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
};

/**
 * Reactivate the current plan if it's paused and still valid (non-expired)
 * This will activate the current plan and pause all other plans
 */
const reactivateCurrentPlan = async (req, res) => {
  try {
    const sellerId = req.sellerId;

    if (!sellerId) {
      return res.status(401).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    const seller = await loadSeller(sellerId);
    if (!seller) {
      return res.status(404).json({
        success: false,
        message: 'Seller not found'
      });
    }

    // Check if seller has a current plan
    if (!seller.currentPlanId) {
      return res.status(400).json({
        success: false,
        message: 'No current plan found'
      });
    }

    const planOrders = await loadSellerPlanOrders(sellerId);
    const currentPlanOrder = planOrders.find(order => order._id.equals(seller.currentPlanId));

    if (!currentPlanOrder) {
      return res.status(404).json({
        success: false,
        message: 'Current plan order not found'
      });
    }

    // Check if the current plan is already active
    if (currentPlanOrder.status === 'active') {
      return res.status(400).json({
        success: false,
        message: 'Current plan is already active'
      });
    }

    // Check if the current plan is paused
    if (currentPlanOrder.status !== 'paused') {
      return res.status(400).json({
        success: false,
        message: `Current plan status is ${currentPlanOrder.status}, cannot reactivate`
      });
    }

    const now = new Date();
    const planDoc = currentPlanOrder.planId || (await Plan.findById(currentPlanOrder.planId));

    if (!planDoc) {
      return res.status(404).json({
        success: false,
        message: 'Plan details not found'
      });
    }

    // Check if the plan is still valid (not expired)
    const remainingMs = computeRemainingMs(currentPlanOrder, planDoc, now);
    if (remainingMs <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Current plan has expired and cannot be reactivated'
      });
    }

    //(`🔄 Reactivating current plan: ${planDoc.name} for seller ${seller.name} (${seller.email})`);

    // Pause all other plan orders
    const savePromises = [];
    for (const order of planOrders) {
      if (!order._id || order._id.equals(currentPlanOrder._id)) {
        continue;
      }

      const otherPlanDoc = order.planId || (await Plan.findById(order.planId));
      if (!otherPlanDoc) {
        continue;
      }

      applyPlanLimitsToOrder(order, otherPlanDoc);
      pausePlanOrder(order, now);
      const otherRemainingMs = computeRemainingMs(order, otherPlanDoc, now);
      refreshExpiryDate(order, otherPlanDoc, otherRemainingMs, now);
      savePromises.push(order.save());
    }

    // Reactivate the current plan
    currentPlanOrder.status = 'active';
    currentPlanOrder.lastActivatedAt = now;
    refreshExpiryDate(currentPlanOrder, currentPlanOrder, remainingMs, now);
    savePromises.push(currentPlanOrder.save());

    await Promise.all(savePromises);

    // Update sync tracking
    try {
      await Promise.all([
        SyncTracking.updateLatestTime(sellerId, 'planOrders'),
        SyncTracking.updateLatestTime(sellerId, 'plans')
      ]);
      //(`🔄 Sync tracking updated: planOrders and plans for seller ${seller.name}`);
    } catch (trackingError) {
      // Error updating sync tracking for plan reactivation suppressed
    }

    //(`✅ Current plan reactivated: ${planDoc.name} is now active for seller ${seller.name}`);

    return res.status(200).json({
      success: true,
      message: `Successfully reactivated ${planDoc.name}`,
      data: {
        planOrderId: currentPlanOrder._id.toString(),
        planId: planDoc._id.toString(),
        planName: planDoc.name,
        status: currentPlanOrder.status,
        remainingMs,
        remaining: formatRemaining(remainingMs),
        expiryDate: currentPlanOrder.expiryDate,
      },
    });

  } catch (error) {
    // Reactivate current plan error suppressed
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
};

/**
 * Switch to an already assigned plan.
 */
const switchPlan = async (req, res) => {
  const { planId, planOrderId } = req.body;
  const result = await setActivePlanForSeller({
    sellerId: req.sellerId,
    planId,
    planOrderId,
    allowCreateOnMissing: false,
  });

  if (!result.success) {
    return res.status(result.statusCode || 500).json({
      success: false,
      message: result.message,
      error: result.error,
    });
  }

  return res.status(result.statusCode || 200).json({
    success: true,
    message: result.message,
    data: result.data,
  });
};

/**
 * Get remaining validity for all plans owned by the seller.
 */
const getRemainingValidity = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    if (!sellerId) {
      return res.status(401).json({ success: false, message: 'Seller ID is required' });
    }

    const planOrders = await loadSellerPlanOrders(sellerId);
    const now = new Date();
    const savePromises = [];

    const response = await Promise.all(
      planOrders.map(async (planOrder) => {
        const planDoc = planOrder.planId || (await Plan.findById(planOrder.planId));
        if (!planDoc) {
          return null;
        }

        const remainingMs = computeRemainingMs(planOrder, planDoc, now);

        if (remainingMs <= 0 && planOrder.status !== 'expired') {
          refreshExpiryDate(planOrder, planOrder, 0, now);
          savePromises.push(planOrder.save());
        } else {
          refreshExpiryDate(planOrder, planOrder, remainingMs, now);
          savePromises.push(planOrder.save());
        }

        return {
          planOrderId: planOrder._id.toString(),
          planId: planDoc._id.toString(),
          planName: planDoc.name,
          status: planOrder.status,
          remainingMs,
          remaining: formatRemaining(remainingMs),
          expiryDate: planOrder.expiryDate,
          paymentStatus: planOrder.paymentStatus,
        };
      })
    );

    if (savePromises.length > 0) {
      await Promise.all(savePromises);
    }

    return res.json({
      success: true,
      data: response.filter(Boolean),
    });
  } catch (error) {
    // Get remaining validity error suppressed
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
};

const usageSummary = async (req, res) => {
  try {
    const sellerId = req.sellerId;
    if (!sellerId) {
      return res.status(401).json({ success: false, message: 'Seller ID is required' });
    }

    const data = await getPlanUsageSummary(sellerId);
    return res.json({
      success: true,
      summary: data.summary,
      plans: data.planDetails,
    });
  } catch (error) {
    console.error('Plan usage summary error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
};

module.exports = {
  activatePlan,
  switchPlan,
  switchToValidPlan,
  reactivateCurrentPlan,
  getRemainingValidity,
  setActivePlanForSeller,
  usageSummary,
};

