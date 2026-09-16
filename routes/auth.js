// routes/auth.js
const express = require('express');
const router = express.Router();

const {
  register,
  login,
  adminLogin,
  logout,
  getMe,
  refresh,
  forgotPassword,
  resetPassword,
  googleAuth,
} = require('../controllers/authController');

const {
  authenticate,
  validateRegistration,
  validateLogin,
  validateAdminLogin,
  validateGoogleAuth,
  validateForgotPassword,
  validateResetPassword,
} = require('../middleware/auth');

const { loginLimiter, registrationLimiter, resetPasswordLimiter } = require('../middleware/rateLimiters');

router.post('/register', registrationLimiter, validateRegistration, register);
router.post('/login', loginLimiter, validateLogin, login);
router.post('/admin/login', loginLimiter, validateAdminLogin, adminLogin);
router.post('/google', validateGoogleAuth, googleAuth);
router.post('/forgot-password', registrationLimiter, validateForgotPassword, forgotPassword);
router.post('/reset-password', resetPasswordLimiter, validateResetPassword, resetPassword);
router.post('/refresh', refresh);
router.post('/logout', authenticate, logout);
router.get('/me', authenticate, getMe);

module.exports = router;
