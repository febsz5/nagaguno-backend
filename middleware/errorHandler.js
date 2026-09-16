// phase1/backend/middleware/errorHandler.js
// Centralized error handling — mount LAST in server.js

const logger = require('../utils/logger');

/**
 * Map known error types to HTTP status codes and user-friendly messages
 */
const ERROR_MAP = {
  // PostgreSQL error codes
  '23505': { status: 409, message: 'A record with this value already exists.' },         // unique_violation
  '23503': { status: 400, message: 'Related record not found.' },                         // foreign_key_violation
  '23502': { status: 400, message: 'Required field is missing.' },                        // not_null_violation
  '22P02': { status: 400, message: 'Invalid data format provided.' },                     // invalid_text_representation
  '42P01': { status: 500, message: 'Database configuration error. Contact support.' },    // undefined_table
  // JWT errors
  TokenExpiredError:   { status: 401, message: 'Session expired. Please login again.', code: 'TOKEN_EXPIRED' },
  JsonWebTokenError:   { status: 401, message: 'Invalid authentication token.' },
  NotBeforeError:      { status: 401, message: 'Token not yet valid.' },
  // Multer errors
  LIMIT_FILE_SIZE:     { status: 400, message: 'File is too large. Maximum size is 5MB.' },
  LIMIT_FILE_COUNT:    { status: 400, message: 'Too many files uploaded at once.' },
  LIMIT_UNEXPECTED_FILE: { status: 400, message: 'Unexpected file field name.' },
};

/**
 * Global error handler middleware
 * Usage: app.use(errorHandler) — after all routes
 */
const errorHandler = (err, req, res, next) => {
  // Log the error (with stack in dev)
  logger.error('Unhandled error', {
    message:  err.message,
    code:     err.code || err.name,
    path:     req.path,
    method:   req.method,
    userId:   req.user?.id,
    stack:     process.env.NODE_ENV !== 'production' ? err.stack : undefined,
  });

  // Look up error mapping
  const mapped = ERROR_MAP[err.code] || ERROR_MAP[err.name] || ERROR_MAP[err.type];

  if (mapped) {
    return res.status(mapped.status).json({
      success: false,
      message: mapped.message,
      ...(mapped.code && { code: mapped.code }),
    });
  }

  // Custom app errors (thrown with err.status)
  if (err.status && err.status < 500) {
    return res.status(err.status).json({
      success: false,
      message: err.message || 'Request failed',
      ...(err.errors && { errors: err.errors }),
    });
  }

  // Validation errors from Joi (passed through validate middleware)
  if (err.isJoi) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: err.details.reduce((acc, d) => {
        const key = d.path.join('.');
        
        // Humanize technical keys (e.g., full_name -> Full Name)
        const humanLabel = key
          .split('_')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');

        // Clean up the Joi message to use the human-friendly label
        const cleanMessage = d.message.replace(`"${key}"`, `"${humanLabel}"`);

        acc[key] = cleanMessage;
        return acc;
      }, {}),
    });
  }

  // Fallback 500
  res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === 'production'
      ? 'An internal server error occurred. Please try again later.'
      : err.message,
  });
};

/**
 * 404 handler — mount before errorHandler but after all routes
 */
const notFoundHandler = (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.path} not found`,
  });
};

/**
 * Async wrapper — eliminates try/catch in route handlers
 * Usage: router.get('/', asyncHandler(ctrl.list))
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { errorHandler, notFoundHandler, asyncHandler };