const MS_IN_DAY = 24 * 60 * 60 * 1000;

/**
 * Convert plan validity (stored in days) to milliseconds.
 */
const getPlanDurationMs = (doc) => {
  if (!doc) {
    return 0;
  }

  // Prioritize durationDays if it exists on the document (handles both Template and Order)
  const durationDays = typeof doc.durationDays === 'number' ? doc.durationDays : 0;

  return durationDays * MS_IN_DAY;
};

/**
 * Calculate the remaining milliseconds for a user-plan association.
 * The calculation is entirely timestamp-based so it works even if the app
 * or server stayed offline for a while.
 */
const computeRemainingMs = (planOrder, planDoc, now = Date.now()) => {
  if (!planOrder) {
    return 0;
  }

  // CRITICAL: Prioritize the durationDays saved on the PlanOrder itself.
  // This ensures that if the 'Master Plan' (planDoc) duration changes,
  // existing orders are NOT affected.
  let durationDays = planOrder.durationDays;

  // Fallback to planDoc if durationDays is missing on the order (legacy support)
  if (typeof durationDays !== 'number' && planDoc) {
    durationDays = planDoc.durationDays;
  }

  if (typeof durationDays !== 'number' || durationDays <= 0) {
    return 0;
  }

  const durationMs = durationDays * MS_IN_DAY;
  const consumedMs = planOrder.accumulatedUsedMs || 0;

  // Include real-time elapsed duration when the plan is currently active.
  let activeElapsed = 0;
  if (planOrder.status === 'active' && planOrder.lastActivatedAt) {
    activeElapsed = Math.max(0, (now instanceof Date ? now.getTime() : now) - planOrder.lastActivatedAt.getTime());
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

