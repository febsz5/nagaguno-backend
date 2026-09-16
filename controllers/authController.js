// controllers/authController.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { query, queryAsUser, withTransaction } = require('../config/database');
const { sendEmail } = require('../utils/emailService');
const { sendSMS } = require('../utils/smsService');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

const generateTokens = (userId, role) => {
  const accessToken = jwt.sign(
    { sub: userId, role },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m' }
  );
  const refreshToken = jwt.sign(
    { sub: userId, role },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );
  return { accessToken, refreshToken };
};

const storeRefreshToken = async (client, userId, refreshToken, req) => {
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await client.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_info, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, tokenHash, req.headers['user-agent']?.slice(0, 255), req.ip, expiresAt]
  );
};

const setAuthCookies = (res, accessToken, refreshToken) => {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    maxAge: 15 * 60 * 1000,
  });
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
};

const createProfile = async (client, userId, role) => {
  if (role === 'farmer') {
    await client.query(
      'INSERT INTO farmer_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
      [userId]
    );
  } else if (role === 'vendor') {
    await client.query(
      'INSERT INTO vendor_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
      [userId]
    );
  } else if (role === 'buyer') {
    await client.query(
      'INSERT INTO buyer_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
      [userId]
    );
  }
};

const generateOTP = () =>
  crypto.randomInt(100000, 1000000).toString();

// ──────────────────────────────────────────────
// REGISTER
// ──────────────────────────────────────────────

exports.register = async (req, res) => {
  // Real bug found and fixed: barangay was already correctly defined
  // and validated in the Joi schema above, but this handler never
  // actually destructured or inserted it -- meaning every
  // registration's barangay was silently dropped at this exact step
  // the whole time, despite the mobile app correctly sending it.
  // street_address is new, added alongside this fix.
  const { full_name, email, phone_number, password, role, barangay, street_address } = req.validatedBody;

  try {
    if (role === 'admin') {
      return res.status(400).json({ success: false, message: 'Invalid role selection.' });
    }

    await withTransaction(async (client) => {
      if (email) {
        const dup = await client.query('SELECT id FROM users WHERE email = $1', [email]);
        if (dup.rows.length)
          throw { status: 409, message: 'An account with this email already exists' };
      }
      if (phone_number) {
        const dup = await client.query('SELECT id FROM users WHERE phone_number = $1', [phone_number]);
        if (dup.rows.length)
          throw { status: 409, message: 'An account with this phone number already exists' };
      }

      const passwordHash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_SALT_ROUNDS || '12'));

      const result = await client.query(
        `INSERT INTO users (full_name, email, phone_number, password_hash, role, auth_provider, account_status, barangay, street_address)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending_verification', $7, $8)
         RETURNING id, full_name, email, phone_number, role, account_status, created_at`,
        [full_name, email || null, phone_number || null, passwordHash, role, email ? 'email' : 'phone', barangay || null, street_address || null]
      );

      const user = result.rows[0];
      await createProfile(client, user.id, role);

      await client.query(
        `INSERT INTO audit_logs (user_id, action, table_name, record_id)
         VALUES ($1, 'user_register', 'users', $1)`,
        [user.id]
      );

      const { accessToken, refreshToken } = generateTokens(user.id, role);
      await storeRefreshToken(client, user.id, refreshToken, req);
      setAuthCookies(res, accessToken, refreshToken);

      return res.status(201).json({
        success: true,
        message: 'Account created successfully! Welcome to NagaGuno.',
        data: {
          user: {
            id: user.id,
            full_name: user.full_name,
            email: user.email,
            phone_number: user.phone_number,
            role: user.role,
            account_status: user.account_status,
          },
          access_token: accessToken,
          refresh_token: refreshToken,
        },
      });
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    console.error('Register error:', err);
    res.status(500).json({ success: false, message: 'Registration failed. Please try again.' });
  }
};

// ──────────────────────────────────────────────
// ADMIN LOGIN
// ──────────────────────────────────────────────

exports.adminLogin = async (req, res) => {
  const { email, password } = req.validatedBody;

  try {
    const result = await query(
      `SELECT id, full_name, email, password_hash, role, account_status
       FROM users WHERE email = $1 AND role = 'admin'`,
      [email]
    );

    if (!result.rows.length) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    if (user.account_status === 'blocked') {
      return res.status(403).json({ success: false, message: 'Access restricted.' });
    }

    const { accessToken, refreshToken } = generateTokens(user.id, 'admin');

    await withTransaction(async (client) => {
      await storeRefreshToken(client, user.id, refreshToken, req);
      await client.query(
        `INSERT INTO audit_logs (user_id, action, table_name, record_id, ip_address)
         VALUES ($1, 'admin_login', 'users', $1, $2)`,
        [user.id, req.ip]
      );
    });

    setAuthCookies(res, accessToken, refreshToken);

    return res.json({
      success: true,
      message: 'Admin authentication successful.',
      data: {
        user: { id: user.id, full_name: user.full_name, role: 'admin', account_status: user.account_status },
        access_token: accessToken,
        refresh_token: refreshToken,
      },
    });
  } catch (err) {
    console.error('Admin Login error:', err);
    res.status(500).json({ success: false, message: 'Authentication failed.' });
  }
};

// ──────────────────────────────────────────────
// LOGIN
// ──────────────────────────────────────────────

exports.login = async (req, res) => {
  const { email, phone_number, password } = req.validatedBody;

  try {
    let userResult;
    if (email) {
      userResult = await query(
        `SELECT id, full_name, email, phone_number, password_hash, role, account_status, auth_provider
         FROM users WHERE email = $1`,
        [email]
      );
    } else {
      userResult = await query(
        `SELECT id, full_name, email, phone_number, password_hash, role, account_status, auth_provider
         FROM users WHERE phone_number = $1`,
        [phone_number]
      );
    }

    if (!userResult.rows.length) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials. Please check your login details.',
      });
    }

    const user = userResult.rows[0];

    if (user.account_status === 'blocked') {
      return res.status(403).json({
        success: false,
        message: 'Your account has been blocked. Contact support.',
      });
    }

    if (user.auth_provider === 'google') {
      return res.status(400).json({
        success: false,
        message: 'This account uses Google Sign-In. Please login with Google.',
      });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials. Please check your login details.',
      });
    }

    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    const { accessToken, refreshToken } = generateTokens(user.id, user.role);

    await withTransaction(async (client) => {
      await storeRefreshToken(client, user.id, refreshToken, req);
      await client.query(
        `INSERT INTO audit_logs (user_id, action, table_name, record_id, ip_address)
         VALUES ($1, 'user_login', 'users', $1, $2)`,
        [user.id, req.ip]
      );
    });

    setAuthCookies(res, accessToken, refreshToken);

    return res.json({
      success: true,
      message: `Welcome back, ${user.full_name.split(' ')[0]}!`,
      data: {
        user: {
          id: user.id,
          full_name: user.full_name,
          email: user.email,
          phone_number: user.phone_number,
          role: user.role,
          account_status: user.account_status,
        },
        access_token: accessToken,
        refresh_token: refreshToken,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
};

// ──────────────────────────────────────────────
// GOOGLE SSO
// ──────────────────────────────────────────────

exports.googleAuth = async (req, res) => {
  const { id_token, role } = req.validatedBody;

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, email_verified } = payload;

    let user;

    await withTransaction(async (client) => {
      const existing = await client.query(
        'SELECT id, full_name, email, role, account_status FROM users WHERE google_id = $1 OR email = $2',
        [googleId, email]
      );

      if (existing.rows.length) {
        user = existing.rows[0];

        if (user.account_status === 'blocked') {
          throw { status: 403, message: 'Your account has been blocked.' };
        }

        await client.query(
          'UPDATE users SET google_id = $1, last_login_at = NOW(), is_email_verified = true WHERE id = $2',
          [googleId, user.id]
        );
      } else {
        if (!role || role === 'admin') throw { status: 400, message: 'Invalid role selection.' };

        const result = await client.query(
          `INSERT INTO users (full_name, email, google_id, role, auth_provider, is_email_verified, account_status)
            VALUES ($1, $2, $3, $4, 'google', $5, 'pending_verification')
            RETURNING id, full_name, email, role, account_status`,
          [name, email, googleId, role, email_verified ? true : false]
        );
        user = result.rows[0];
        await createProfile(client, user.id, role);

        await client.query(
          `INSERT INTO audit_logs (user_id, action, table_name, record_id)
            VALUES ($1, 'user_register_google', 'users', $1)`,
          [user.id]
        );
      }

      const { accessToken, refreshToken } = generateTokens(user.id, user.role);
      await storeRefreshToken(client, user.id, refreshToken, req);
      setAuthCookies(res, accessToken, refreshToken);

      return res.json({
        success: true,
        message: `Welcome, ${user.full_name.split(' ')[0]}!`,
        data: {
          user: { id: user.id, full_name: user.full_name, email: user.email, role: user.role, account_status: user.account_status },
          access_token: accessToken,
          refresh_token: refreshToken,
        },
      });
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error('Google auth error:', err);
    res.status(500).json({ success: false, message: 'Google authentication failed.' });
  }
};

// ──────────────────────────────────────────────
// REFRESH ACCESS TOKEN
// ──────────────────────────────────────────────

exports.refresh = async (req, res) => {
  const refreshToken = req.cookies?.refresh_token || req.body?.refresh_token;

  if (!refreshToken) {
    return res.status(401).json({ success: false, message: 'Refresh token required.' });
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    const { rows } = await query(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at,
              u.role, u.account_status
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1`,
      [tokenHash]
    );

    if (!rows.length) {
      return res.status(401).json({ success: false, message: 'Invalid session. Please login again.' });
    }

    const stored = rows[0];

    if (stored.revoked_at) {
      return res.status(401).json({ success: false, message: 'This session has been revoked. Please login again.' });
    }
    if (new Date(stored.expires_at) < new Date()) {
      return res.status(401).json({ success: false, message: 'Session expired. Please login again.' });
    }
    if (stored.account_status === 'blocked') {
      return res.status(403).json({ success: false, message: 'Your account has been blocked. Contact support.' });
    }

    const { accessToken, refreshToken: newRefreshToken } = generateTokens(stored.user_id, stored.role);

    await withTransaction(async (client) => {
      // Rotate: revoke the token that was just used, issue a fresh pair.
      // Prevents replay of a stolen-but-already-used refresh token.
      await client.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1', [stored.id]);
      await storeRefreshToken(client, stored.user_id, newRefreshToken, req);
    });

    setAuthCookies(res, accessToken, newRefreshToken);

    return res.json({
      success: true,
      data: { access_token: accessToken, refresh_token: newRefreshToken },
    });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ success: false, message: 'Failed to refresh session.' });
  }
};

// ──────────────────────────────────────────────
// LOGOUT
// ──────────────────────────────────────────────

exports.logout = async (req, res) => {
  try {
    const refreshToken = req.cookies?.refresh_token || req.body?.refresh_token;
    if (refreshToken) {
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1', [tokenHash]);
    }

    res.clearCookie('access_token');
    res.clearCookie('refresh_token');

    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ success: false, message: 'Logout failed.' });
  }
};

// ──────────────────────────────────────────────
// FORGOT PASSWORD
// ──────────────────────────────────────────────

exports.forgotPassword = async (req, res) => {
  const { email, phone_number } = req.validatedBody;

  try {
    let userResult;
    if (email) {
      userResult = await query('SELECT id, full_name, email, phone_number FROM users WHERE email = $1', [email]);
    } else {
      userResult = await query('SELECT id, full_name, email, phone_number FROM users WHERE phone_number = $1', [phone_number]);
    }

    if (!userResult.rows.length) {
      return res.json({
        success: true,
        message: 'If this account exists, you will receive a reset code shortly.',
      });
    }

    const user = userResult.rows[0];
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + parseInt(process.env.OTP_EXPIRES_MINUTES || '10') * 60 * 1000);

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE otp_tokens SET used_at = NOW()
          WHERE user_id = $1 AND purpose = 'password_reset' AND used_at IS NULL`,
        [user.id]
      );
      await client.query(
        `INSERT INTO otp_tokens (user_id, token, purpose, expires_at)
          VALUES ($1, $2, 'password_reset', $3)`,
        [user.id, otp, expiresAt]
      );
    });

    if (email && user.email) {
      await sendEmail({
        to: user.email,
        subject: 'NagaGuno — Password Reset Code',
        html: `
           <h2>Password Reset</h2>
           <p>Hi ${user.full_name},</p>
           <p>Your password reset code is: <strong style="font-size:24px;letter-spacing:4px">${otp}</strong></p>
           <p>This code expires in ${process.env.OTP_EXPIRES_MINUTES || 10} minutes.</p>
         `,
      });
    } else if (phone_number && user.phone_number) {
      await sendSMS({
        to: user.phone_number,
        body: `NagaGuno: Your password reset code is ${otp}.`,
      });
    }

    res.json({
      success: true,
      message: 'If this account exists, you will receive a reset code shortly.',
      data: { user_id: user.id },
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    if (err.code === 'EMAIL_DELIVERY_FAILED') {
      return res.status(503).json({ success: false, message: 'Password reset email could not be sent. Please try again later or contact support.' });
    }
    if (err.code === 'SMS_DELIVERY_FAILED') {
      return res.status(503).json({ success: false, message: 'Password reset SMS could not be sent. Please try again later or use your registered email.' });
    }
    res.status(500).json({ success: false, message: 'Failed to process request.' });
  }
};

// ──────────────────────────────────────────────
// RESET PASSWORD
// ──────────────────────────────────────────────

exports.resetPassword = async (req, res) => {
  const { user_id, otp, new_password } = req.validatedBody;

  try {
    await withTransaction(async (client) => {
      const tokenResult = await client.query(
        `SELECT id FROM otp_tokens
          WHERE user_id = $1 AND token = $2 AND purpose = 'password_reset'
            AND expires_at > NOW() AND used_at IS NULL`,
        [user_id, otp]
      );

      if (!tokenResult.rows.length) {
        throw { status: 400, message: 'Invalid or expired reset code.' };
      }

      const passwordHash = await bcrypt.hash(new_password, parseInt(process.env.BCRYPT_SALT_ROUNDS || '12'));

      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, user_id]);
      await client.query('UPDATE otp_tokens SET used_at = NOW() WHERE id = $1', [tokenResult.rows[0].id]);
      await client.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1', [user_id]);
    });

    res.clearCookie('access_token');
    res.clearCookie('refresh_token');

    res.json({
      success: true,
      message: 'Password reset successfully. Please login again.',
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error('Reset password error:', err);
    res.status(500).json({ success: false, message: 'Failed to reset password.' });
  }
};

// ──────────────────────────────────────────────
// GET CURRENT USER
// ──────────────────────────────────────────────

exports.getMe = async (req, res) => {
  try {
    const result = await queryAsUser(req.user,
      `SELECT u.id, u.full_name, u.email, u.phone_number, u.barangay, u.street_address, u.role, u.auth_provider,
              u.is_email_verified, u.account_status, u.created_at,
              fp.farm_name,
              vp.business_name,
              bp.saved_farmers_count
       FROM users u
       LEFT JOIN farmer_profiles fp ON fp.user_id = u.id
       LEFT JOIN vendor_profiles  vp ON vp.user_id = u.id
       LEFT JOIN buyer_profiles   bp ON bp.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );

    if (!result.rows.length)
      return res.status(404).json({ success: false, message: 'User not found' });

    res.json({ success: true, data: { user: result.rows[0] } });
  } catch (err) {
    console.error('getMe error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch user data.' });
  }
};
