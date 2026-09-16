// phase1/backend/utils/logger.js
// Structured logging with Winston
// npm install winston (already in package.json)

const winston = require('winston');
const path    = require('path');

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

// ── Console format (development) ──────────────────────────────
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length
      ? `\n  ${JSON.stringify(meta, null, 2)}`
      : '';
    return `[${timestamp}] ${level}: ${stack || message}${metaStr}`;
  })
);

// ── JSON format (production) ──────────────────────────────────
const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  format: process.env.NODE_ENV === 'production' ? prodFormat : devFormat,
  defaultMeta: { service: 'nagaguno-api' },
  transports: [
    new winston.transports.Console({
      silent: process.env.NODE_ENV === 'test',
    }),
  ],
});

// Add file transport in production
if (process.env.NODE_ENV === 'production') {
  logger.add(new winston.transports.File({
    filename: path.join(__dirname, '../logs/error.log'),
    level: 'error',
    maxsize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
  }));
  logger.add(new winston.transports.File({
    filename: path.join(__dirname, '../logs/combined.log'),
    maxsize: 10 * 1024 * 1024,
    maxFiles: 10,
  }));
}

// ── Express Morgan stream ─────────────────────────────────────
logger.stream = {
  write: (message) => logger.http(message.trim()),
};

// ── Convenience shortcuts ─────────────────────────────────────
logger.request  = (req, extra = {}) => logger.info('HTTP Request',  { method: req.method, path: req.path, ip: req.ip, ...extra });
logger.dbQuery  = (sql, duration)   => logger.debug('DB Query',     { sql: sql.slice(0, 120), duration_ms: duration });
logger.authEvent = (event, userId)  => logger.info('Auth Event',    { event, userId });
logger.mlCall   = (endpoint, ms)    => logger.info('ML Service',    { endpoint, duration_ms: ms });

module.exports = logger;
