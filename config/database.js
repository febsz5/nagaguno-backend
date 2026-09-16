require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
console.log('DATABASE_URL configured:', !!process.env.DATABASE_URL);
console.log('APP_BACKEND_DATABASE_URL set:', !!process.env.APP_BACKEND_DATABASE_URL);

const { Pool } = require('pg');

// ── Privileged pool (existing) ──────────────────────────────────
// Bypasses RLS. Reserved for the small set of genuinely pre-authentication
// operations where no user identity exists yet to scope a policy against:
// login's email/phone lookup, registration's INSERT, refresh-token lookup
// by hash, and forgot/reset-password's email lookup. Every other query,
// anywhere a real authenticated user is making the request, should use
// queryAsUser() below instead.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 60000,
});

pool.on('error', (err) => {
  console.error('❌ Unexpected DB error:', err);
});

// ── Restricted pool (new) ────────────────────────────────────────
// Connects as app_backend -- NOT superuser, NOT bypassrls -- so RLS
// policies actually apply to every query made through it. Set
// APP_BACKEND_DATABASE_URL in .env to the same connection string as
// DATABASE_URL but with the app_backend role/password instead of postgres.
const appPool = process.env.APP_BACKEND_DATABASE_URL
  ? new Pool({
      connectionString: process.env.APP_BACKEND_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 60000,
      connectionTimeoutMillis: 60000,
    })
  : null;

if (appPool) {
  appPool.on('error', (err) => {
    console.error('❌ Unexpected app_backend DB error:', err);
  });
}

// Transaction helper (existing -- privileged pool, used by authController)
const withTransaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Runs a query as a specific authenticated user, through the RLS-respecting
 * app_backend connection. Every route handling an authenticated request
 * should use this instead of the plain `query()` export.
 *
 * Wraps each call in its own short transaction so `SET LOCAL` — which is
 * transaction-scoped — can't leak the previous request's user context onto
 * a reused pooled connection. This is the standard, safe pattern for RLS
 * with a custom (non-Supabase-Auth) JWT backend.
 *
 * @param {{id: string, role: string}} user - req.user, from the `authenticate` middleware
 * @param {string} text - SQL text
 * @param {Array} params - query parameters
 */
async function queryAsUser(user, text, params = []) {
  if (!appPool) {
    throw new Error(
      'APP_BACKEND_DATABASE_URL is not set. queryAsUser() requires the restricted ' +
      'app_backend role connection string -- see config/database.js and the RLS setup notes.'
    );
  }
  if (!user || !user.id) {
    throw new Error('queryAsUser() requires an authenticated user with an id -- got: ' + JSON.stringify(user));
  }

  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    // Real bug fixed this session: SET LOCAL does not support $1
    // parameter placeholders at all -- that's invalid Postgres syntax
    // (error 42601), not something that fails silently. set_config()
    // is the correct, parameter-safe equivalent; its third argument
    // (true) scopes it to the current transaction, same as SET LOCAL
    // would have. This went unnoticed all session because every time
    // this pattern was tested directly, real literal values were
    // inlined into the SQL text by hand, never exercising the actual
    // parameterized code path here.
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', user.id]);
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_role', user.role || '']);
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Test connection
(async () => {
  console.log('⏳ Connecting to Supabase via Hotspot...');
  try {
    const client = await pool.connect();
    console.log('✅ PostgreSQL (privileged) connected successfully!');
    client.release();
  } catch (err) {
    console.error('❌ Connection error:', err.message);
    console.log('💡 TIP: Ensure your .env has the correct DATABASE_URL from Supabase.');
  }
  if (appPool) {
    try {
      const client = await appPool.connect();
      console.log('✅ PostgreSQL (app_backend, RLS-restricted) connected successfully!');
      client.release();
    } catch (err) {
      console.error('❌ app_backend connection error:', err.message);
      console.log('💡 TIP: Check APP_BACKEND_DATABASE_URL and that the app_backend role/password are correct.');
    }
  } else {
    console.log('⚠️  APP_BACKEND_DATABASE_URL not set -- queryAsUser() will throw until this is configured.');
  }
})();

/**
 * Like withTransaction(), but through the RLS-respecting app_backend
 * connection, with the user's session context set before the callback
 * runs. Use this for any authenticated request that needs multiple
 * writes/reads in one atomic transaction (e.g. an INSERT plus a
 * notification row) instead of withTransaction().
 *
 * @param {{id: string, role: string}} user - req.user
 * @param {(client) => Promise<any>} callback - receives the same kind of
 *   client withTransaction() gives you; use client.query(...) inside it
 */
async function withTransactionAsUser(user, callback) {
  if (!appPool) {
    throw new Error(
      'APP_BACKEND_DATABASE_URL is not set. withTransactionAsUser() requires the ' +
      'restricted app_backend role connection string -- see config/database.js.'
    );
  }
  if (!user || !user.id) {
    throw new Error('withTransactionAsUser() requires an authenticated user with an id -- got: ' + JSON.stringify(user));
  }

  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    // Same real fix as queryAsUser above -- see that function's
    // comment for the full explanation.
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', user.id]);
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_role', user.role || '']);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  queryAsUser,
  withTransaction,
  withTransactionAsUser,
  pool,
  appPool,
};