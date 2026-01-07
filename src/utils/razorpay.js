const Razorpay = require('razorpay');
const crypto = require('crypto');

// Initialize Razorpay instance (only if keys are configured)
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
}

/**
 * Create a Razorpay order
 * @param {number} amount - Amount in paise (smallest currency unit)
 * @param {string} currency - Currency code (default: 'INR')
 * @param {Object} notes - Additional notes/metadata
 * @returns {Promise<Object>} - Razorpay order object
 */
const createOrder = async (amount, currency = 'INR', notes = {}) => {
  try {
    if (!razorpay) {
      throw new Error('Razorpay is not configured. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET environment variables.');
    }

    const options = {
      amount: amount, // Amount in paise
      currency: currency,
      receipt: `receipt_${Date.now()}`,
      notes: notes
    };

    const order = await razorpay.orders.create(options);
    return order;
  } catch (error) {
    // Error creating Razorpay order suppressed
    throw error;
  }
};

/**
 * Verify Razorpay payment signature
 * @param {string} razorpayOrderId - Razorpay order ID
 * @param {string} razorpayPaymentId - Razorpay payment ID
 * @param {string} razorpaySignature - Razorpay signature
 * @returns {boolean} - True if signature is valid
 */
const verifyPayment = (razorpayOrderId, razorpayPaymentId, razorpaySignature) => {
  try {
    if (!process.env.RAZORPAY_KEY_SECRET) {
      // Razorpay key secret missing suppressed
      return false;
    }

    const text = razorpayOrderId + '|' + razorpayPaymentId;
    const generatedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(text)
      .digest('hex');

    return generatedSignature === razorpaySignature;
  } catch (error) {
    // Error verifying Razorpay payment suppressed
    return false;
  }
};

/**
 * Convert amount from rupees to paise
 * @param {number} amountInRupees - Amount in rupees
 * @returns {number} - Amount in paise
 */
const convertToPaise = (amountInRupees) => {
  return Math.round(amountInRupees * 100);
};

/**
 * Convert amount from paise to rupees
 * @param {number} amountInPaise - Amount in paise
 * @returns {number} - Amount in rupees
 */
const convertToRupees = (amountInPaise) => {
  return amountInPaise / 100;
};

module.exports = {
  razorpay,
  createOrder,
  verifyPayment,
  convertToPaise,
  convertToRupees
};
