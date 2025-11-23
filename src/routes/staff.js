const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Staff = require('../models/Staff');
const InviteToken = require('../models/InviteToken');
const Seller = require('../models/Seller');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const { verifySeller } = require('../middleware/auth');

// Helper function to serialize staff data
const serializeStaff = (staff) => ({
  _id: staff._id,
  name: staff.name,
  email: staff.email,
  profilePicture: staff.profilePicture,
  sellerId: staff.sellerId,
  invitedBy: staff.invitedBy ? {
    _id: staff.invitedBy._id,
    name: staff.invitedBy.name,
    email: staff.invitedBy.email
  } : null,
  inviteToken: staff.inviteToken,
  permissions: staff.permissions || {},
  isActive: staff.isActive,
  isSuspend: staff.isSuspend,
  lastActivityDate: staff.lastActivityDate,
  resignedAt: staff.resignedAt,
  accessRevoked: staff.accessRevoked,
  resignationReason: staff.resignationReason,
  createdAt: staff.createdAt,
  updatedAt: staff.updatedAt
});

// Helper function to serialize invite token (without sensitive data)
const serializeInviteToken = (token) => ({
  _id: token._id,
  token: token.token,
  permissions: token.permissions,
  expiryTime: token.expiryTime,
  used: token.used,
  usedAt: token.usedAt,
  createdAt: token.createdAt
});

/**
 * Get all staff for a seller
 */
router.get('/', verifySeller, async (req, res) => {
  try {
    console.log('Staff GET request - sellerId from middleware:', req.sellerId);
    console.log('Staff GET request - headers:', req.headers);

    const sellerId = req.sellerId;

    if (!sellerId) {
      console.log('No sellerId found in request');
      return res.status(400).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    const staff = await Staff.find({
      sellerId: sellerId.toString() // Ensure string comparison
    }).populate('invitedBy', 'name email').sort({ isActive: -1, createdAt: -1 }); // Active staff first, then inactive

    const serializedStaff = staff.map(serializeStaff);

    res.json({
      success: true,
      data: serializedStaff
    });
  } catch (error) {
    console.error('Error fetching staff:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching staff',
      error: error.message
    });
  }
});

/**
 * Create a new staff invite
 */
router.post('/invite', verifySeller, async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const { permissions } = req.body;

    if (!sellerId) {
      return res.status(400).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    if (!permissions || typeof permissions !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'Permissions object is required'
      });
    }

    // Generate unique token
    const token = InviteToken.generateToken();

    // Set expiry time (24 hours from now)
    const expiryTime = new Date();
    expiryTime.setHours(expiryTime.getHours() + 24);

    // Create invite token
    const inviteToken = new InviteToken({
      token,
      sellerId,
      permissions,
      expiryTime,
      createdBy: sellerId
    });

    await inviteToken.save();

    // Generate invite URL - use FRONTEND_URL if set, otherwise try to infer from request
    let baseUrl = process.env.FRONTEND_URL;

    if (!baseUrl) {
      // Try to infer from the request headers (replace backend port with frontend port)
      const host = req.get('host');
      const protocol = req.protocol;
      // If host includes port (like localhost:5000), replace with frontend port (3000)
      const hostWithoutPort = host.split(':')[0];
      baseUrl = `${protocol}://${hostWithoutPort}:3000`;
    }

    const inviteUrl = `${baseUrl}/staff/signup?token=${token}`;

    res.json({
      success: true,
      data: {
        token: serializeInviteToken(inviteToken),
        inviteUrl
      }
    });
  } catch (error) {
    console.error('Error creating staff invite:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating staff invite',
      error: error.message
    });
  }
});

/**
 * Get all active invites for a seller
 */
router.get('/invites', verifySeller, async (req, res) => {
  try {
    const sellerId = req.sellerId;

    if (!sellerId) {
      return res.status(400).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    const invites = await InviteToken.find({
      sellerId: sellerId,
      used: false,
      expiryTime: { $gt: new Date() }
    }).sort({ createdAt: -1 });

    const serializedInvites = invites.map(serializeInviteToken);

    res.json({
      success: true,
      data: serializedInvites
    });
  } catch (error) {
    console.error('Error fetching invites:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching invites',
      error: error.message
    });
  }
});

/**
 * Get invite history for a seller (all invites: pending, accepted, expired, revoked)
 */
router.get('/invite-history', verifySeller, async (req, res) => {
  try {
    const sellerId = req.sellerId;

    if (!sellerId) {
      return res.status(400).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    console.log('🔍 Fetching invite history for seller:', sellerId);

    // Get all invites for this seller
    const invites = await InviteToken.find({
      sellerId: sellerId
    }).populate('sellerId', 'name email shopName')
      .populate('usedBy', 'name email profilePicture')
      .sort({ createdAt: -1 }); // Most recent first

    console.log('📋 Found invites:', invites.length);

    // Serialize invites with full details
    const serializedInvites = invites.map(invite => {
      // Determine status
      let status = 'pending';
      let isRevoked = false;

      // Check for various revocation indicators
      if (invite.revokedAt || invite.isRevoked || invite.revoked || invite.deletedAt) {
        status = 'revoked';
        isRevoked = true;
      } else if (invite.used) {
        status = 'accepted';
      } else if (invite.isExpired()) {
        status = 'expired';
      }

      // For accepted invites, check if usedBy/usedAt are missing (indicates revocation)
      if (status === 'accepted' && (!invite.usedBy || !invite.usedAt)) {
        status = 'revoked';
        isRevoked = true;
      }

      return {
        _id: invite._id,
        token: invite.token,
        permissions: invite.permissions || {},
        status: status,
        email: invite.email || null, // Some invites might not have email if created without one
        createdAt: invite.createdAt,
        expiryTime: invite.expiryTime,
        used: invite.used,
        usedAt: invite.usedAt,
        usedBy: invite.usedBy ? {
          _id: invite.usedBy._id,
          name: invite.usedBy.name,
          email: invite.usedBy.email,
          profilePicture: invite.usedBy.profilePicture
        } : null,
        sellerId: invite.sellerId,
        revokedAt: invite.revokedAt,
        isRevoked: invite.isRevoked || isRevoked,
        revoked: invite.revoked,
        deletedAt: invite.deletedAt
      };
    });

    // Calculate stats
    const stats = {
      total: serializedInvites.length,
      pending: serializedInvites.filter(invite => invite.status === 'pending').length,
      accepted: serializedInvites.filter(invite => invite.status === 'accepted').length,
      expired: serializedInvites.filter(invite => invite.status === 'expired').length,
      revoked: serializedInvites.filter(invite => invite.status === 'revoked').length
    };

    console.log('📊 Invite stats:', stats);

    res.json({
      success: true,
      data: serializedInvites,
      stats: stats
    });

  } catch (error) {
    console.error('❌ Error fetching invite history:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching invite history',
      error: error.message
    });
  }
});

/**
 * Revoke an invite token
 */
router.delete('/invites/:tokenId', verifySeller, async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const { tokenId } = req.params;

    if (!sellerId) {
      return res.status(400).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    const invite = await InviteToken.findOne({
      _id: tokenId,
      sellerId: sellerId,
      used: false
    });

    if (!invite) {
      return res.status(404).json({
        success: false,
        message: 'Invite not found or already used'
      });
    }

    // Soft delete by marking as used (or we could add a revoked field)
    invite.used = true;
    await invite.save();

    res.json({
      success: true,
      message: 'Invite revoked successfully'
    });
  } catch (error) {
    console.error('Error revoking invite:', error);
    res.status(500).json({
      success: false,
      message: 'Error revoking invite',
      error: error.message
    });
  }
});

/**
 * Update staff permissions
 */
router.put('/:staffId/permissions', verifySeller, async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const { staffId } = req.params;
    const { permissions } = req.body;

    if (!sellerId) {
      return res.status(400).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    if (!permissions || typeof permissions !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'Permissions object is required'
      });
    }

    const staff = await Staff.findOne({
      _id: staffId,
      sellerId: sellerId
    });

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff member not found'
      });
    }

    await staff.setPermissions(permissions);

    res.json({
      success: true,
      data: serializeStaff(staff),
      message: 'Staff permissions updated successfully'
    });
  } catch (error) {
    console.error('Error updating staff permissions:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating staff permissions',
      error: error.message
    });
  }
});

/**
 * Disable/enable staff member
 */
router.put('/:staffId/status', verifySeller, async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const { staffId } = req.params;
    const { isActive } = req.body;

    if (!sellerId) {
      return res.status(400).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isActive must be a boolean value'
      });
    }

    const staff = await Staff.findOne({
      _id: staffId,
      sellerId: sellerId
    });

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff member not found'
      });
    }

    staff.isActive = isActive;
    staff.updatedAt = new Date();
    await staff.save();

    res.json({
      success: true,
      data: serializeStaff(staff),
      message: `Staff member ${isActive ? 'enabled' : 'disabled'} successfully`
    });
  } catch (error) {
    console.error('Error updating staff status:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating staff status',
      error: error.message
    });
  }
});

/**
 * Suspend/unsuspend staff member
 */
router.put('/:staffId/suspend', verifySeller, async (req, res) => {
  try {
    const sellerId = req.sellerId;
    const { staffId } = req.params;
    const { isSuspend } = req.body;

    if (!sellerId) {
      return res.status(400).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    if (typeof isSuspend !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isSuspend must be a boolean value'
      });
    }

    const staff = await Staff.findOne({
      _id: staffId,
      sellerId: sellerId
    });

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff member not found'
      });
    }

    staff.isSuspend = isSuspend;
    staff.isActive = !isSuspend; // When suspending, set inactive; when unsuspending, set active
    if (isSuspend) {
      staff.permissions = {}; // Clear all permissions when suspending
    }
    staff.updatedAt = new Date();
    await staff.save();

    res.json({
      success: true,
      data: serializeStaff(staff),
      message: `Staff member ${isSuspend ? 'suspended' : 'unsuspended'} successfully`
    });
  } catch (error) {
    console.error('Error updating staff suspension status:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating staff suspension status',
      error: error.message
    });
  }
});

/**
 * Validate invite token (used by staff signup)
 */
router.get('/invite/:token', async (req, res) => {
  try {
    const { token } = req.params;

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Token is required'
      });
    }

    const inviteToken = await InviteToken.findOne({ token })
      .populate('sellerId', 'name shopName email');

    console.log('Invite validation - token lookup result:', inviteToken ? {
      id: inviteToken._id,
      used: inviteToken.used,
      expired: inviteToken.isExpired(),
      sellerId: inviteToken.sellerId._id
    } : 'Token not found');

    if (!inviteToken) {
      return res.status(404).json({
        success: false,
        message: 'Invalid invite token'
      });
    }

    if (inviteToken.used) {
      return res.status(400).json({
        success: false,
        message: 'This invite has already been used'
      });
    }

    if (inviteToken.isExpired()) {
      return res.status(400).json({
        success: false,
        message: 'This invite has expired'
      });
    }

    res.json({
      success: true,
      data: {
        token: inviteToken.token,
        permissions: inviteToken.permissions,
        seller: {
          _id: inviteToken.sellerId._id,
          name: inviteToken.sellerId.name,
          shopName: inviteToken.sellerId.shopName,
          email: inviteToken.sellerId.email
        },
        expiryTime: inviteToken.expiryTime
      }
    });
  } catch (error) {
    console.error('Error validating invite token:', error);
    res.status(500).json({
      success: false,
      message: 'Error validating invite token',
      error: error.message
    });
  }
});

/**
 * Staff signup using invite token
 */
router.post('/signup', async (req, res) => {
  try {
    const { token, email, uid, displayName, photoURL } = req.body;

    console.log('Staff signup request:', { token: token.substring(0, 10) + '...', email });

    if (!token || !email) {
      return res.status(400).json({
        success: false,
        message: 'Token and email are required'
      });
    }

    // Find and validate token
    const inviteToken = await InviteToken.findOne({ token });
    console.log('Found invite token:', inviteToken ? { id: inviteToken._id, used: inviteToken.used, expired: inviteToken.isExpired() } : 'null');

    if (!inviteToken) {
      return res.status(400).json({
        success: false,
        message: 'Invalid invite token'
      });
    }

    if (inviteToken.used) {
      return res.status(400).json({
        success: false,
        message: 'This invite has already been used'
      });
    }

    if (inviteToken.isExpired()) {
      return res.status(400).json({
        success: false,
        message: 'This invite has expired'
      });
    }

    // Check if staff with this email already exists for this seller
    const existingStaff = await Staff.findOne({
      email: email,
      sellerId: inviteToken.sellerId
    });

    if (existingStaff) {
      return res.status(400).json({
        success: false,
        message: 'A staff member with this email already exists for this seller'
      });
    }

    // Create new staff member
    const staffName = displayName || email.split('@')[0];
    const staff = new Staff({
      name: staffName,
      email: email,
      profilePicture: photoURL || null,
      sellerId: inviteToken.sellerId.toString(), // Ensure string
      invitedBy: inviteToken.createdBy.toString(), // Ensure string
      inviteToken: inviteToken.token,
      permissions: inviteToken.permissions,
      isActive: true,
      lastActivityDate: new Date()
    });

    await staff.save();

    // Mark token as used
    await inviteToken.markAsUsed(staff._id);

    const serializedStaff = serializeStaff(staff);

    res.json({
      success: true,
      staff: serializedStaff,
      message: 'Staff account created successfully'
    });
  } catch (error) {
    console.error('Error in staff signup:', error);

    // Handle duplicate email error
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'A staff member with this email already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error creating staff account',
      error: error.message
    });
  }
});

/**
 * Authenticate staff member (similar to seller auth but for staff)
 */
router.post('/auth', async (req, res) => {
  try {
    const { email, uid, displayName, photoURL } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    console.log('🔐 STAFF AUTHENTICATION STARTED');
    console.log('📧 Email:', email);
    console.log('🆔 UID:', uid);

    // Find staff by email
    console.log('🔍 Looking for active staff account...');
    const staff = await Staff.findOne({ email, isActive: true })
      .populate('sellerId', 'name shopName isActive currentPlanId');

    if (staff) {
      console.log('✅ STAFF VERIFIED - Active staff account found');
      console.log('👤 Staff Details:', {
        id: staff._id,
        name: staff.name,
        email: staff.email,
        isActive: staff.isActive,
        permissions: staff.permissions,
        sellerId: staff.sellerId?._id,
        lastActivity: staff.lastActivityDate
      });

      // Check if staff account is inactive (resigned)
      if (!staff.isActive) {
        console.log('❌ STAFF INACTIVE - Account has been deactivated');
        return res.status(403).json({
          success: false,
          message: 'Your account is inactive. You can no longer access this system.'
        });
      }

      // Check seller verification
      if (staff.sellerId?.isActive) {
        console.log('✅ SELLER VERIFIED - Associated seller account is active');
        console.log('🏪 Seller Details:', {
          id: staff.sellerId._id,
          name: staff.sellerId.name,
          shopName: staff.sellerId.shopName,
          isActive: staff.sellerId.isActive,
          currentPlan: staff.sellerId.currentPlanId
        });
      } else {
        console.log('❌ SELLER NOT VERIFIED - Associated seller account is inactive or not found');
        console.log('🚫 Seller Status:', {
          sellerId: staff.sellerId?._id,
          isActive: staff.sellerId?.isActive,
          reason: staff.sellerId ? 'Seller account deactivated' : 'Seller account not found'
        });
        return res.status(403).json({
          success: false,
          message: 'Your seller account has been deactivated. Please contact your seller or administrator.'
        });
      }
    } else {
      console.log('❌ STAFF NOT VERIFIED - No active staff account found');
      // Also check if there's an inactive staff account
      const inactiveStaff = await Staff.findOne({ email, isActive: false });
      if (inactiveStaff) {
        console.log('ℹ️  Found inactive staff account - needs reactivation');
        console.log('👤 Inactive Staff Details:', {
          id: inactiveStaff._id,
          name: inactiveStaff.name,
          email: inactiveStaff.email,
          isActive: false,
          sellerId: inactiveStaff.sellerId
        });
        return res.status(403).json({
          success: false,
          message: 'Staff account found but is inactive. Please contact your seller.'
        });
      }
      console.log('❌ No staff account exists for this email');
      return res.status(404).json({
        success: false,
        message: 'Staff account not found. Please ensure you have signed up using the invite link from your seller.'
      });
    }

    console.log('🎉 AUTHENTICATION SUCCESSFUL - Staff and Seller both verified');
    console.log('✅ Proceeding with login for staff:', email);

    // Update staff info and last activity
    let updated = false;
    if (displayName && staff.name !== displayName) {
      staff.name = displayName;
      updated = true;
    }
    if (photoURL && staff.profilePicture !== photoURL) {
      staff.profilePicture = photoURL;
      updated = true;
    }
    staff.lastActivityDate = new Date();

    if (updated) {
      await staff.save();
    } else {
      await staff.save(); // Still save to update lastActivityDate
    }

    const serializedStaff = serializeStaff(staff);

    console.log('📤 STAFF AUTH RESPONSE - permissions:', serializedStaff.permissions);

    res.json({
      success: true,
      staff: serializedStaff,
      seller: {
        _id: staff.sellerId._id,
        name: staff.sellerId.name,
        shopName: staff.sellerId.shopName
      }
    });
  } catch (error) {
    console.error('Error authenticating staff:', error);
    res.status(500).json({
      success: false,
      message: 'Error authenticating staff',
      error: error.message
    });
  }
});

/**
 * Staff resignation endpoint
 */
router.patch('/:staffId/resign', async (req, res) => {
  try {
    const { staffId } = req.params;
    const { reason } = req.body;

    if (!staffId) {
      return res.status(400).json({
        success: false,
        message: 'Staff ID is required'
      });
    }

    const staff = await Staff.findById(staffId);
    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Staff member not found'
      });
    }

    if (!staff.isActive) {
      return res.status(400).json({
        success: false,
        message: 'Staff account is already inactive'
      });
    }

    // Update staff status
    staff.isActive = false;
    staff.accessRevoked = true;
    staff.resignedAt = new Date();
    staff.resignationReason = reason || null;
    staff.permissions = {}; // Clear all permissions
    staff.lastActivityDate = new Date();

    await staff.save();

    // Create audit log
    await AuditLog.create({
      sellerId: staff.sellerId,
      staffId: staff._id,
      action: 'STAFF_RESIGNED',
      details: {
        staffName: staff.name,
        staffEmail: staff.email,
        resignationReason: reason,
        resignedAt: staff.resignedAt
      }
    });

    // Create notification for seller
    await Notification.create({
      recipientId: staff.sellerId,
      recipientType: 'Seller',
      senderId: staff._id,
      senderType: 'Staff',
      type: 'STAFF_RESIGNED',
      message: `Staff member ${staff.name} has resigned from their position.`,
      link: '/staff'
    });

    res.json({
      success: true,
      message: 'Staff resignation processed successfully. Account has been deactivated.',
      staff: serializeStaff(staff)
    });
  } catch (error) {
    console.error('Error processing staff resignation:', error);
    res.status(500).json({
      success: false,
      message: 'Error processing staff resignation',
      error: error.message
    });
  }
});

/**
 * Get resigned staff for a seller
 */
router.get('/resigned', verifySeller, async (req, res) => {
  try {
    const sellerId = req.sellerId;

    if (!sellerId) {
      return res.status(400).json({
        success: false,
        message: 'Seller ID is required'
      });
    }

    const resignedStaff = await Staff.find({
      sellerId: sellerId.toString(),
      isActive: false,
      resignedAt: { $ne: null }
    }).populate('invitedBy', 'name email').sort({ resignedAt: -1 });

    const serializedStaff = resignedStaff.map(serializeStaff);

    res.json({
      success: true,
      data: serializedStaff
    });
  } catch (error) {
    console.error('Error fetching resigned staff:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching resigned staff',
      error: error.message
    });
  }
});

module.exports = router;
