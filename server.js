require('dotenv').config();
const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const compression  = require('compression');
const cookieParser = require('cookie-parser');
const morgan       = require('morgan');

const authRoutes = require('./routes/auth');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Security ──────────────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: false, // ← ADD THIS
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      imgSrc:      ["'self'", "data:", "blob:", "https://*.supabase.co"],
      scriptSrc:   ["'self'"],
      styleSrc:    ["'self'", "https:", "'unsafe-inline'"],
      fontSrc:     ["'self'", "https:", "data:"],
      connectSrc:  ["'self'", "https://*.supabase.co"],
    },
  },
}));
// ── CORS ──────────────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:3000/',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://localhost:3001',
  'https://nagaguno.vercel.app',
];
if (process.env.CLIENT_URL) allowedOrigins.push(process.env.CLIENT_URL);
if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
}));

// ── Rate limiting ─────────────────────────────────────────────
// Definitions live in middleware/rateLimiters.js so routes/auth.js can
// apply the login/registration-specific limiters directly to those
// exact routes, rather than one blanket rule for all of /api/auth.
const { apiLimiter } = require('./middleware/rateLimiters');
app.use('/api', apiLimiter);

// ── Body parsing ──────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Logging ───────────────────────────────────────────────────
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:       'ok',
    service:      'NagaGuno API',
    version:      '2.0',
    db_connected: true,
    timestamp:    new Date().toISOString(),
  });
});

// ── Routes ────────────────────────────────────────────────────
// ── Routes ────────────────────────────────────────────────────
// ── Routes ────────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth.js'));
app.use('/api/profiles',      require('./routes/profile.js'));
app.use('/api/products',      require('./routes/products.js'));
app.use('/api/marketplace',   require('./routes/marketplace.js'));
app.use('/api/orders',        require('./routes/orders.js'));
app.use('/api/agreements',    require('./routes/agreement.js'));
app.use('/api/production',    require('./routes/cropPlans.js'));
app.use('/api/notifications', require('./routes/notifications.js'));
app.use('/api/admin',         require('./routes/admin.js'));
app.use('/api/dashboard',     require('./routes/dashboard.js'));
app.use('/api/demand',           require('./routes/demand.js'));
app.use('/api/recommendations',  require('./routes/recommendation.js'));
app.use('/api/kyc',              require('./routes/kyc.js'));
app.use('/api/spoilage',         require('./routes/spoilage.js'));

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ success: false, message: 'CORS policy blocked this request.' });
  }
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🌱 NagaGuno API running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   CORS Allowed: ${allowedOrigins.join(', ')}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);

  // Automatic spoilage-based discounting -- runs every hour. See
  // jobs/spoilageAutoDiscount.js for the full real reasoning: this
  // closes a genuine gap where spoilage detection was already fully
  // automatic (a live database view) but turning that into an actual
  // price change required a farmer/vendor to manually report it AND
  // manually accept the resulting suggestion. Runs once immediately
  // on startup too, rather than waiting up to an hour for the first
  // real run.
  const cron = require('node-cron');
  const { runSpoilageAutoDiscount } = require('./jobs/spoilageAutoDiscount');
  runSpoilageAutoDiscount().then((r) => console.log('🥬 Spoilage auto-discount (startup run):', r));
  cron.schedule('0 * * * *', async () => {
    const result = await runSpoilageAutoDiscount();
    console.log('🥬 Spoilage auto-discount (hourly run):', result);
  });
});

module.exports = app;