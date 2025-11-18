const mongoose = require('mongoose');
const Plan = require('../models/Plan');
const PlanOrder = require('../models/PlanOrder');
const Seller = require('../models/Seller');
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

  if (remainingMs <= 0) {
    planOrder.status = 'expired';
    planOrder.expiryDate = now;
    planOrder.lastActivatedAt = null;
    planOrder.accumulatedUsedMs = getPlanDurationMs(planDoc);
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

      // For mini plans with price > 0, create order with pending payment status
      // For free plans, create with completed payment status
      const paymentStatus = (targetPlanDoc.price && targetPlanDoc.price > 0 && targetPlanDoc.planType === 'mini') 
        ? 'pending' 
        : 'completed';

      // Mini plans are always created with 'paused' status (they don't activate automatically)
      // Other plans are created with 'paused' status and will be activated later
      const isMiniPlan = targetPlanDoc.planType === 'mini';
      
      targetPlanOrder = new PlanOrder({
        sellerId,
        planId: targetPlanDoc._id,
        expiryDate: initialExpiry,
        durationDays: targetPlanDoc.durationDays,
        price: targetPlanDoc.price || 0,
        status: 'paused', // Always start paused - mini plans stay paused, others activate later
        lastActivatedAt: null,
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
      refreshExpiryDate(targetPlanOrder, targetPlanDoc, remainingMs, now);
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
      refreshExpiryDate(order, planDoc, remainingMs, now);
      savePromises.push(order.save());
    }

    // For mini plans, don't activate - just create the order and keep it paused
    // Mini plans are top-ups that don't switch the current plan
    const planType = targetPlanDoc?.planType || targetPlanOrder?.planId?.planType;
    if (planType === 'mini') {
      // Mini plan: create order but keep it paused, don't activate, don't switch plans
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
      
      // Keep mini plan paused, don't activate it
      refreshExpiryDate(targetPlanOrder, targetPlanDoc, remainingMs, now);
      await targetPlanOrder.save();
      
      return {
        success: true,
        statusCode: 200,
        message: 'Mini plan top-up purchased successfully. Plan order created and ready to use.',
        data: {
          planOrderId: targetPlanOrder._id.toString(),
          planId: targetPlanDoc._id.toString(),
          planName: targetPlanDoc.name,
          status: targetPlanOrder.status, // Will be 'paused'
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
    refreshExpiryDate(targetPlanOrder, targetPlanDoc, remainingMsBeforeActivation, now);

    savePromises.push(targetPlanOrder.save());

    // Update currentPlanId for non-mini plans
    seller.currentPlanId = targetPlanOrder._id;
    savePromises.push(seller.save());

    await Promise.all(savePromises);

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
    console.error('Activate plan error:', error);
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
          refreshExpiryDate(planOrder, planDoc, 0, now);
          savePromises.push(planOrder.save());
        } else {
          refreshExpiryDate(planOrder, planDoc, remainingMs, now);
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
    console.error('Get remaining validity error:', error);
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
  getRemainingValidity,
  setActivePlanForSeller,
  usageSummary,
};

