const nodemailer = require('nodemailer');

let cachedTransporter = null;

/**
 * Configure standard transporter using environment variables
 * If variables are not set, it will log a warning and return null
 */
const getTransporter = () => {
  if (cachedTransporter) return cachedTransporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.warn('⚠️  Email notification service skipped: Missing SMTP configuration in .env');
    return null;
  }

  cachedTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT),
    secure: parseInt(SMTP_PORT) === 465, // true for 465, false for other ports
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  // Verify connection once (asynchronous)
  cachedTransporter.verify((error, success) => {
    if (error) {
      console.error('❌ SMTP Connection Error:', error.message);
      console.error('🔴 Please check your SMTP_USER and SMTP_PASS in .env');
      cachedTransporter = null; // Reset cache so it tries again next time
    } else {
      console.log('✅ SMTP server is ready to take our messages');
    }
  });

  return cachedTransporter;
};

/**
 * Generate a professional HTML template for login notification
 */
const generateLoginTemplate = (userName, loginTime, loginIp, userAgent) => {
  const brandColor = '#4f46e5'; // Indigo
  const secondaryColor = '#f3f4f6';
  const textColor = '#1f2937';
  const lightTextColor = '#6b7280';

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Login Notification - Grocery Studio</title>
      <style>
        body { font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f9fafb; color: ${textColor}; }
        .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); }
        .header { background: ${brandColor}; padding: 30px 20px; text-align: center; }
        .header h1 { color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.025em; }
        .content { padding: 40px 30px; line-height: 1.6; }
        .greeting { font-size: 18px; font-weight: 600; margin-bottom: 16px; }
        .details-box { background: ${secondaryColor}; border-radius: 8px; padding: 20px; margin: 24px 0; border-left: 4px solid ${brandColor}; }
        .detail-row { display: flex; margin-bottom: 8px; }
        .detail-label { font-weight: 600; width: 100px; color: ${lightTextColor}; font-size: 14px; }
        .detail-value { flex: 1; font-size: 14px; }
        .footer { background: #f3f4f6; padding: 20px 30px; text-align: center; font-size: 12px; color: ${lightTextColor}; }
        .security-note { font-size: 13px; color: ${lightTextColor}; margin-top: 30px; border-top: 1px solid #e5e7eb; padding-top: 20px; }
        .btn { display: inline-block; padding: 12px 24px; background-color: ${brandColor}; color: #ffffff !important; text-decoration: none; border-radius: 6px; font-weight: 600; margin-top: 20px; }
        @media only screen and (max-width: 600px) {
          .container { margin: 0; border-radius: 0; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Grocery Studio</h1>
        </div>
        <div class="content">
          <div class="greeting">Hi ${userName},</div>
          <p>This is a security notification to let you know that your <strong>Grocery Studio</strong> account was just logged into from a new session.</p>
          
          <div class="details-box">
            <div class="detail-row">
              <span class="detail-label">Time:</span>
              <span class="detail-value">${loginTime}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">IP Address:</span>
              <span class="detail-value">${loginIp}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Device:</span>
              <span class="detail-value">${userAgent}</span>
            </div>
          </div>

          <div class="security-note">
            <strong>Not you?</strong> If you don't recognized this activity, please change your password immediately and contact our support team to secure your account.
          </div>
          
          <div style="text-align: center;">
            <a href="https://app.draganddrop.in" class="btn">Go to Dashboard</a>
          </div>
        </div>
        <div class="footer">
          &copy; ${new Date().getFullYear()} Grocery Studio. All rights reserved.<br>
          This is an automated security notification.
        </div>
      </div>
    </body>
    </html>
  `;
};

/**
 * Generate a professional HTML template for plan purchase confirmation
 */
const generatePlanPurchaseTemplate = (userName, planName, amount, expiryDate, transactionId) => {
  const brandColor = '#10b981'; // Emerald Green for success
  const secondaryColor = '#f3f4f6';
  const textColor = '#1f2937';
  const lightTextColor = '#6b7280';

  const formattedExpiry = new Date(expiryDate).toLocaleDateString('en-IN', {
    dateStyle: 'long'
  });

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Payment Successful - Grocery Studio</title>
      <style>
        body { font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f9fafb; color: ${textColor}; }
        .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); }
        .header { background: ${brandColor}; padding: 30px 20px; text-align: center; }
        .header h1 { color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.025em; }
        .content { padding: 40px 30px; line-height: 1.6; }
        .greeting { font-size: 18px; font-weight: 600; margin-bottom: 16px; }
        .success-banner { text-align: center; margin-bottom: 30px; }
        .success-icon { font-size: 48px; color: ${brandColor}; margin-bottom: 10px; }
        .details-box { background: ${secondaryColor}; border-radius: 8px; padding: 20px; margin: 24px 0; border-left: 4px solid ${brandColor}; }
        .detail-row { display: flex; margin-bottom: 12px; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; }
        .detail-row:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
        .detail-label { font-weight: 600; width: 140px; color: ${lightTextColor}; font-size: 14px; }
        .detail-value { flex: 1; font-size: 14px; font-weight: 500; }
        .footer { background: #f3f4f6; padding: 20px 30px; text-align: center; font-size: 12px; color: ${lightTextColor}; }
        .btn { display: inline-block; padding: 12px 24px; background-color: ${brandColor}; color: #ffffff !important; text-decoration: none; border-radius: 6px; font-weight: 600; margin-top: 20px; }
        @media only screen and (max-width: 600px) {
          .container { margin: 0; border-radius: 0; }
          .detail-label { width: 100px; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Grocery Studio</h1>
        </div>
        <div class="content">
          <div class="success-banner">
            <div class="success-icon">✅</div>
            <h2 style="margin: 0; color: ${brandColor};">Payment Successful!</h2>
          </div>
          
          <div class="greeting">Hi ${userName},</div>
          <p>Thank you for your purchase! Your plan has been successfully activated. You can now enjoy all the premium features included in your subscription.</p>
          
          <div class="details-box">
            <div class="detail-row">
              <span class="detail-label">Plan Name:</span>
              <span class="detail-value">${planName}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Amount Paid:</span>
              <span class="detail-value">₹${amount}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Valid Until:</span>
              <span class="detail-value">${formattedExpiry}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Transaction ID:</span>
              <span class="detail-value" style="font-family: monospace;">${transactionId}</span>
            </div>
          </div>

          <p>Your subscription is now active and your limits have been updated. You can view your current usage and plan details anytime in the billing section of your dashboard.</p>
          
          <div style="text-align: center;">
            <a href="https://app.draganddrop.in/billing" class="btn">View Subscription Details</a>
          </div>
        </div>
        <div class="footer">
          &copy; ${new Date().getFullYear()} Grocery Studio. All rights reserved.<br>
          This is an automated payment confirmation.
        </div>
      </div>
    </body>
    </html>
  `;
};

/**
 * Generate a professional HTML template for inventory alerts (Low Stock, Out of Stock, or Expiry)
 */
const generateInventoryAlertTemplate = (userName, alertType, products) => {
  const typeConfigs = {
    'low_stock': {
      title: 'Low Stock Alert',
      bannerColor: '#f59e0b', // Amber
      icon: '⚠️',
      message: 'The following products are running low on stock. Please consider restocking soon to avoid service interruptions.'
    },
    'out_of_stock': {
      title: 'Out of Stock Alert',
      bannerColor: '#ef4444', // Red
      icon: '🚫',
      message: 'The following products are officially OUT OF STOCK. These items cannot be sold until stock is added.'
    },
    'expiry': {
      title: 'Expiry Date Alert',
      bannerColor: '#6366f1', // Indigo
      icon: '⏰',
      message: 'The following product batches are approaching their expiry date. Please take necessary action to manage your inventory.'
    }
  };

  const config = typeConfigs[alertType] || typeConfigs['low_stock'];
  const brandColor = config.bannerColor;
  const secondaryColor = '#f3f4f6';
  const textColor = '#1f2937';
  const lightTextColor = '#6b7280';

  const productRows = products.map(p => `
        <tr>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; font-size: 14px;">
                <strong>${p.name}</strong>
                ${p.batchNumber ? `<br><span style="color: ${lightTextColor}; font-size: 12px;">Batch: ${p.batchNumber}</span>` : ''}
            </td>
            <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; font-size: 14px; text-align: right;">
                ${alertType === 'expiry' ?
      `<span style="color: ${brandColor}; font-weight: 600;">${new Date(p.expiryDate).toLocaleDateString('en-IN')}</span>` :
      `<span style="font-weight: 600;">${p.currentStock} ${p.unit}</span>`}
            </td>
        </tr>
    `).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${config.title} - Grocery Studio</title>
      <style>
        body { font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f9fafb; color: ${textColor}; }
        .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); }
        .header { background: ${brandColor}; padding: 30px 20px; text-align: center; }
        .header h1 { color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.025em; }
        .content { padding: 40px 30px; line-height: 1.6; }
        .greeting { font-size: 18px; font-weight: 600; margin-bottom: 16px; }
        .alert-banner { text-align: center; margin-bottom: 30px; }
        .alert-icon { font-size: 48px; margin-bottom: 10px; }
        .product-table { width: 100%; border-collapse: collapse; margin: 24px 0; background: ${secondaryColor}; border-radius: 8px; overflow: hidden; }
        .product-table th { background: #e5e7eb; padding: 12px; text-align: left; font-size: 13px; font-weight: 600; color: ${lightTextColor}; }
        .footer { background: #f3f4f6; padding: 20px 30px; text-align: center; font-size: 12px; color: ${lightTextColor}; }
        .btn { display: inline-block; padding: 12px 24px; background-color: ${brandColor}; color: #ffffff !important; text-decoration: none; border-radius: 6px; font-weight: 600; margin-top: 20px; }
        @media only screen and (max-width: 600px) {
          .container { margin: 0; border-radius: 0; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Grocery Studio</h1>
        </div>
        <div class="content">
          <div class="alert-banner">
            <div class="alert-icon">${config.icon}</div>
            <h2 style="margin: 0; color: ${brandColor};">${config.title}</h2>
          </div>
          
          <div class="greeting">Hi ${userName},</div>
          <p>${config.message}</p>
          
          <table class="product-table">
            <thead>
              <tr>
                <th style="padding: 12px; text-align: left;">Product</th>
                <th style="padding: 12px; text-align: right;">${alertType === 'expiry' ? 'Expiry Date' : 'Stock Status'}</th>
              </tr>
            </thead>
            <tbody>
              ${productRows}
            </tbody>
          </table>

          <p>Please log in to your dashboard to update stock levels or manage these items.</p>
          
          <div style="text-align: center;">
            <a href="https://app.draganddrop.in/inventory" class="btn">Manage Inventory</a>
          </div>
        </div>
        <div class="footer">
          &copy; ${new Date().getFullYear()} Grocery Studio. All rights reserved.<br>
          This is an automated inventory alert system.
        </div>
      </div>
    </body>
    </html>
  `;
};

/**
 * Send login notification email
 */
const sendLoginEmail = async (email, name, ip, userAgent) => {
  const transporter = getTransporter();
  if (!transporter) return;

  const loginTime = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'full',
    timeStyle: 'medium'
  });

  const mailOptions = {
    from: `"${process.env.EMAIL_FROM_NAME || 'Grocery Studio Security'}" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
    to: email,
    subject: 'New Login to Your Grocery Studio Account',
    html: generateLoginTemplate(name, loginTime, ip, userAgent),
  };

  try {
    console.log(`📡 Attempting to send login email to: ${email}...`);
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Login notification email sent successfully to ${email}`);
    console.log(`📧 Message ID: ${info.messageId}`);
    return info;
  } catch (error) {
    console.error(`❌ FAILED to send login email to ${email}`);
    console.error(`🔴 Error Details:`, error.message);
    if (error.code === 'EAUTH') {
      console.error('💡 TIP: This looks like an authentication error. Check your SMTP_USER and SMTP_PASS (App Password).');
    }
    return null;
  }
};

/**
 * Send plan purchase confirmation email
 */
const sendPlanPurchaseEmail = async (email, name, planName, amount, expiryDate, transactionId) => {
  const transporter = getTransporter();
  if (!transporter) return;

  const mailOptions = {
    from: `"${process.env.EMAIL_FROM_NAME || 'Grocery Studio'}" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
    to: email,
    subject: `Success! Your ${planName} Plan is Now Active`,
    html: generatePlanPurchaseTemplate(name, planName, amount, expiryDate, transactionId),
  };

  try {
    console.log(`📡 Attempting to send plan purchase email to: ${email}...`);
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Plan purchase confirmation email sent successfully to ${email}`);
    return info;
  } catch (error) {
    console.error(`❌ FAILED to send plan purchase email to ${email}`);
    console.error(`🔴 Error Details:`, error.message);
    return null;
  }
};

/**
 * Send grouped inventory alert email
 */
const sendInventoryAlertEmail = async (email, name, alertType, products) => {
  const transporter = getTransporter();
  if (!transporter) return;

  const subjects = {
    'low_stock': '⚠️ Low Stock Alert: Items need restocking',
    'out_of_stock': '🚫 Critical: Products are Out of Stock',
    'expiry': '⏰ Expiry Alert: Product batches expiring soon'
  };

  const mailOptions = {
    from: `"${process.env.EMAIL_FROM_NAME || 'Grocery Studio Inventory'}" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
    to: email,
    subject: subjects[alertType] || 'Inventory Alert',
    html: generateInventoryAlertTemplate(name, alertType, products),
  };

  try {
    console.log(`📡 Attempting to send ${alertType} alert email to: ${email}...`);
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ ${alertType} alert email sent successfully to ${email}`);
    return info;
  } catch (error) {
    console.error(`❌ FAILED to send ${alertType} alert email to ${email}`);
    console.error(`🔴 Error Details:`, error.message);
    return null;
  }
};

module.exports = {
  sendLoginEmail,
  sendPlanPurchaseEmail,
  sendInventoryAlertEmail
};
