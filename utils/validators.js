// utils/validators.js
const Joi = require('joi');

// Philippine phone regex: +63XXXXXXXXXX or 09XXXXXXXXX
const PH_PHONE_REGEX = /^(\+63|0)9\d{9}$/;
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

/**
 * Validation schemas
 */
const schemas = {
  register: Joi.object({
    full_name: Joi.string()
      .min(2)
      .max(150)
      .trim()
      .required()
      .messages({
        'string.min': 'Full name must be at least 2 characters',
        'string.max': 'Full name must not exceed 150 characters',
        'any.required': 'Full name is required',
      }),

    email: Joi.string()
      .email({ tlds: { allow: false } })
      .lowercase()
      .trim()
      .when('phone_number', {
        is: Joi.exist(),
        then: Joi.optional(),
        otherwise: Joi.required(),
      })
      .messages({
        'string.email': 'Please enter a valid email address',
        'any.required': 'Email is required when not using a phone number',
      }),

    phone_number: Joi.string()
      .pattern(PH_PHONE_REGEX)
      .optional()
      .messages({
        'string.pattern.base': 'Phone number must be a valid Philippine number (e.g. 09XXXXXXXXX or +639XXXXXXXXX)',
      }),

    password: Joi.string()
      .pattern(PASSWORD_REGEX)
      .required()
      .messages({
        'string.pattern.base':
          'Password must be at least 8 characters and include uppercase, lowercase, number, and special character (@$!%*?&)',
        'any.required': 'Password is required',
      }),

    role: Joi.string()
      .valid('farmer', 'vendor', 'buyer')
      .required()
      .messages({
        'any.only': 'Role must be one of: farmer, vendor, buyer',
        'any.required': 'Role is required',
      }),
  }).or('email', 'phone_number').messages({
    'object.missing': 'At least one of email or phone number is required',
  }),

  login: Joi.object({
    email: Joi.string()
      .email({ tlds: { allow: false } })
      .lowercase()
      .trim()
      .optional()
      .messages({ 'string.email': 'Please enter a valid email address' }),

    phone_number: Joi.string()
      .pattern(PH_PHONE_REGEX)
      .optional()
      .messages({
        'string.pattern.base': 'Phone number must be a valid Philippine number',
      }),

    password: Joi.string().required().messages({
      'any.required': 'Password is required',
    }),

    role: Joi.string()
      .valid('farmer', 'vendor', 'buyer', 'admin')
      .required()
      .messages({
        'any.only': 'Role must be valid',
        'any.required': 'Please select your role',
      }),
  }).or('email', 'phone_number'),

  googleAuth: Joi.object({
    id_token: Joi.string().required().messages({
      'any.required': 'Google ID token is required',
    }),
    role: Joi.string()
      .valid('farmer', 'vendor', 'buyer')
      .when('is_new_user', { is: true, then: Joi.required() })
      .messages({
        'any.required': 'Role is required for new accounts',
      }),
  }),

  forgotPassword: Joi.object({
    email: Joi.string()
      .email({ tlds: { allow: false } })
      .lowercase()
      .trim()
      .optional()
      .messages({ 'string.email': 'Please enter a valid email address' }),
    phone_number: Joi.string()
      .pattern(PH_PHONE_REGEX)
      .optional()
      .messages({ 'string.pattern.base': 'Please enter a valid Philippine phone number' }),
  }).or('email', 'phone_number'),

  verifyOtp: Joi.object({
    user_id: Joi.string().uuid().required(),
    otp: Joi.string().length(6).pattern(/^\d+$/).required().messages({
      'string.length': 'OTP must be exactly 6 digits',
      'string.pattern.base': 'OTP must contain only numbers',
    }),
    purpose: Joi.string()
      .valid('password_reset', 'verify_email', 'verify_phone')
      .required(),
  }),

  resetPassword: Joi.object({
    user_id: Joi.string().uuid().required(),
    otp: Joi.string().length(6).pattern(/^\d+$/).required(),
    new_password: Joi.string()
      .pattern(PASSWORD_REGEX)
      .required()
      .messages({
        'string.pattern.base':
          'Password must be at least 8 characters and include uppercase, lowercase, number, and special character',
      }),
    confirm_password: Joi.any()
      .valid(Joi.ref('new_password'))
      .required()
      .messages({ 'any.only': 'Passwords do not match' }),
  }),
};

/**
 * Middleware factory
 */
const validate = (schemaName) => (req, res, next) => {
  const schema = schemas[schemaName];
  if (!schema) return next(new Error(`Unknown schema: ${schemaName}`));

  const { error, value } = schema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    const errors = {};
    error.details.forEach((detail) => {
      const key = detail.path.join('.');
      errors[key] = detail.message;
    });
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors,
    });
  }

  req.validatedBody = value;
  next();
};

module.exports = { validate, schemas };
