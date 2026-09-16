// backend/middleware/auth.js
const jwt      = require('jsonwebtoken');
const { query } = require('../config/database');
const Joi      = require('joi');

// NOTE: This app authenticates against its own `users` table with backend-
// issued JWTs (see `authenticate`/`authorize` below) — it does not use
// Supabase Auth. An earlier Supabase-token-based auth pair (requireAuth/
// requireRole, querying a `profiles` table that doesn't exist in this
// schema) lived here unused, and unconditionally created a Supabase client
// at module load — meaning the whole API would crash on boot if
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY were ever missing or misnamed,
// even though nothing called that code. Removed as dead weight + a real
// fragility risk. If Supabase Auth is intentionally wanted later, add it
// back deliberately with lazy client creation inside the middleware
// function, not at module scope.

// ═══════════════════════════════════════════════════════════════
// JWT AUTH (for routes using your own backend JWT tokens)
// ═══════════════════════════════════════════════════════════════

/**
 * Verify JWT access token (your backend-issued tokens)
 * Attaches req.user from your users table
 */
const authenticate = async (req, res, next) => {
  try {
    let token = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else if (req.cookies && req.cookies.access_token) {
      token = req.cookies.access_token;
    }

    if (!token) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    const result  = await query(
      `SELECT id, full_name, email, role, account_status FROM users WHERE id = $1`,
      [decoded.sub]
    );

    if (!result.rows.length) {
      return res.status(401).json({ success: false, message: 'User session invalid' });
    }

    const user = result.rows[0];
    if (user.account_status === 'blocked') {
      return res.status(403).json({ success: false, message: 'Account restricted.' });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired session.' });
  }
};

/**
 * Role-based access control (for your backend JWT routes)
 */
const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(404).json({ success: false, message: 'Route not found' });
  }
  next();
};

/**
 * Gates full-feature actions (listing a product, placing an order,
 * creating an agreement) behind KYC approval. Per the spec, users with
 * account_status = 'pending_verification' can browse freely (no gate on
 * any GET route) but cannot transact until an admin approves their KYC
 * submission and their status flips to 'active'. Call after authenticate.
 */
const requireVerified = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }
  if (req.user.account_status !== 'active') {
    return res.status(403).json({
      success: false,
      message: 'This action requires a verified account. Submit your identity verification and wait for admin approval to unlock buying, selling, and agreements.',
    });
  }
  next();
};

// ═══════════════════════════════════════════════════════════════
// JOI VALIDATORS
// ═══════════════════════════════════════════════════════════════

const validateRegistration = (req, res, next) => {
  const schema = Joi.object({
    full_name:    Joi.string().min(2).max(50).required()
      .messages({
        'string.empty': 'Full name is required.',
        'string.min':   'Full name must be at least 2 characters.',
        'string.max':   'Full name must not exceed 50 characters.',
      })
      .label('Full Name'),

    email:        Joi.string().email().required()
      .messages({
        'string.empty': 'Email address is required.',
        'string.email': 'Please enter a valid email address.',
      })
      .label('Email Address'),

    password:     Joi.string()
      .pattern(new RegExp('^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[@$!%*?&\\.])[A-Za-z\\d@$!%*?&\\.]{8,}$'))
      .required()
      .messages({
        'string.empty':        'Password is required.',
        'string.pattern.base': 'Password must be 8+ chars with Uppercase, Lowercase, Number, and Special Char (dots allowed).',
      })
      .label('Password'),

    phone_number: Joi.string().pattern(/^[0-9]{11}$/).required()
      .messages({
        'string.empty':        'Mobile number is required.',
        'string.pattern.base': 'Phone number must be exactly 11 digits (e.g. 09123456789).',
      })
      .label('Phone Number'),

    // Real fix: every field in this form is meant to be required --
    // these two were still marked optional server-side even after
    // the frontend was updated to require them. Making the frontend
    // alone required would have left a real gap: registering
    // directly against this API (bypassing the app's own form)
    // could still succeed with both left empty.
    barangay:     Joi.string().min(2).max(100).required()
      .messages({
        'string.empty': 'Barangay is required.',
        'string.min': 'Barangay must be at least 2 characters.',
        'string.max': 'Barangay must not exceed 100 characters.',
      })
      .label('Barangay'),

    street_address: Joi.string().min(1).max(200).required()
      .messages({
        'string.empty': 'Street / Zone / Landmark is required.',
        'string.max': 'Street address must not exceed 200 characters.',
      })
      .label('Street Address'),

    role:         Joi.string().valid('farmer', 'vendor', 'buyer').required()
      .messages({
        'any.only': 'Role must be farmer, vendor, or buyer.',
        'string.empty': 'Role is required.',
      })
      .label('Role'),
  });

  const { error, value } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    const errors = {};
    error.details.forEach(d => {
      const key = d.path[0];
      errors[key] = d.message;
    });
    return res.status(400).json({ success: false, message: error.details[0].message, errors });
  }
  req.validatedBody = value;
  next();
};

const validateLogin = (req, res, next) => {
  const schema = Joi.object({
    email:        Joi.string().email().optional().label('Email Address'),
    phone_number: Joi.string().pattern(/^[0-9+]{10,15}$/).optional().label('Phone Number'),
    password:     Joi.string().required().label('Password'),
  }).or('email', 'phone_number');

  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  req.validatedBody = value;
  next();
};

const validateAdminLogin = (req, res, next) => {
  const schema = Joi.object({
    email:    Joi.string().email().required().label('Email Address'),
    password: Joi.string().required().label('Password'),
  });

  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  req.validatedBody = value;
  next();
};

const validateGoogleAuth = (req, res, next) => {
  const schema = Joi.object({
    id_token: Joi.string().required().label('Google ID Token'),
    role:     Joi.string().valid('farmer', 'vendor', 'buyer').optional().label('Role'),
  });

  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  req.validatedBody = value;
  next();
};

const validateForgotPassword = (req, res, next) => {
  const schema = Joi.object({
    email:        Joi.string().email().optional().label('Email Address'),
    phone_number: Joi.string().pattern(/^[0-9+]{10,15}$/).optional().label('Phone Number'),
  }).or('email', 'phone_number');

  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  req.validatedBody = value;
  next();
};

const validateResetPassword = (req, res, next) => {
  const schema = Joi.object({
    user_id:      Joi.string().uuid().required().label('User ID'),
    otp:          Joi.string().length(6).required().label('Reset Code'),
    new_password: Joi.string()
      .pattern(new RegExp('^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[@$!%*?&\\.])[A-Za-z\\d@$!%*?&\\.]{8,}$'))
      .required()
      .messages({ 'string.pattern.base': 'Password must be 8+ chars with Uppercase, Lowercase, Number, and Special Char.' })
      .label('New Password'),
  });

  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  req.validatedBody = value;
  next();
};

const validateRoleSelection = (req, res, next) => {
  const { role } = req.body;
  const allowedPublicRoles = ['farmer', 'vendor', 'buyer'];
  if (role && !allowedPublicRoles.includes(role)) {
    return res.status(400).json({ success: false, message: 'Invalid role selection.' });
  }
  next();
};

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════
module.exports = {
  // Backend JWT auth
  authenticate,
  authorize,
  requireVerified,
  // Validators
  validateRoleSelection,
  validateRegistration,
  validateLogin,
  validateAdminLogin,
  validateGoogleAuth,
  validateForgotPassword,
  validateResetPassword,
};