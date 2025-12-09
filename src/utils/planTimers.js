const MS_IN_DAY = 24 * 60 * 60 * 1000;

/**
 * Convert plan validity (stored in days) to milliseconds.
 */
const getPlanDurationMs = (planDoc) => {
  if (!planDoc || typeof planDoc.durationDays !== 'number') {
    return 0;
  }
  return planDoc.durationDays * MS_IN_DAY;
};

/**
 * Calculate the remaining milliseconds for a user-plan association.
 * The calculation is entirely timestamp-based so it works even if the app
 * or server stayed offline for a while.
 */
const computeRemainingMs = (planOrder, planDoc, now = Date.now()) => {
  if (!planOrder || !planDoc) {
    return 0;
  }

  const durationMs = getPlanDurationMs(planDoc);
  if (durationMs <= 0) {
    return 0;
  }

  const consumedMs = planOrder.accumulatedUsedMs || 0;

  // Include real-time elapsed duration when the plan is currently active.
  let activeElapsed = 0;
  if (planOrder.status === 'active' && planOrder.lastActivatedAt) {
    activeElapsed = Math.max(0, now - planOrder.lastActivatedAt.getTime());
  }

  const totalConsumed = consumedMs + activeElapsed;
  const remaining = Math.max(0, durationMs - totalConsumed);

  if (planOrder.remainingMsOverride != null) {
    return Math.min(remaining, planOrder.remainingMsOverride);
  }

  return remaining;
};

/**
 * Format milliseconds into a human friendly breakdown.
 */
const formatRemaining = (remainingMs) => {
  const totalSeconds = Math.floor((remainingMs || 0) / 1000);
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
};

module.exports = {
  getPlanDurationMs,
  computeRemainingMs,
  formatRemaining,
};

