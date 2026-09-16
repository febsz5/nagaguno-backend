// middleware/rateLimiters.js
// Per-endpoint rate limiters, sized to each route's actual abuse profile
// rather than one blanket rule for all of /api/auth. Fully skipped when
// NODE_ENV !== 'production' so local dev/demo work never self-locks-out;
// only enforced once the real deployment explicitly sets NODE_ENV=production.
const rateLimit = require('express-rate-limit');

const isDev = process.env.NODE_ENV !== 'production';

function limitHandler(req, res) {
  res.status(429).json({ success: false, message: 'Too many requests. Please wait a moment and try again.' });
}

// General API traffic — generous, just stops runaway clients/bots.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      isDev ? 10000 : 300,
  skip:     (req) => isDev || req.path === '/health',
  standardHeaders: true,
  legacyHeaders:   false,
  handler: limitHandler,
});

// Login — the actual brute-force target. Successful logins don't count
// against the limit, so a legitimate user retrying a wrong password a
// few times isn't treated the same as a credential-stuffing attempt.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      isDev ? 10000 : 10,
  skip:     () => isDev,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders:   false,
  handler: limitHandler,
  message: { success: false, message: 'Too many login attempts. Please wait 15 minutes and try again.' },
});

// Registration / password-reset-request — prevents mass account creation
// and reset-link spam. Looser window (1 hour), tighter count.
const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max:      isDev ? 10000 : 8,
  skip:     () => isDev,
  standardHeaders: true,
  legacyHeaders:   false,
  handler: limitHandler,
});

// Recovery-code guessing must be limited in demos as well as production.
const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
});
module.exports = { apiLimiter, loginLimiter, registrationLimiter, resetPasswordLimiter };
