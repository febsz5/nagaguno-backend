// phase1/backend/scripts/migrate.js
// Run: node scripts/migrate.js
// Safe to run multiple times — tracks applied migrations

require('dotenv').config();
const { Pool } = require('pg');
const fs       = require('fs');
const path     = require('path');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'nagaguno_db',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

// Ordered migration list — add new migrations here
const MIGRATIONS = [
  { name: '001_init',        file: path.resolve(__dirname, '../../phase1/backend/migrations/001_init.sql') },
  { name: '002_marketplace', file: path.resolve(__dirname, '../../phase2/backend/migrations/002_marketplace.sql') },
];

async function runMigrations() {
  const client = await pool.connect();
  console.log('\n📦 NagaGuno Database Migration Runner');
  console.log('══════════════════════════════════════\n');

  try {
    // Bootstrap tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    for (const migration of MIGRATIONS) {
      const { rows } = await client.query(
        'SELECT 1 FROM _migrations WHERE name = $1',
        [migration.name]
      );

      if (rows.length) {
        console.log(`  ⏭  ${migration.name} — already applied`);
        continue;
      }

      if (!fs.existsSync(migration.file)) {
        console.error(`  ❌ ${migration.name} — file not found: ${migration.file}`);
        process.exit(1);
      }

      const sql = fs.readFileSync(migration.file, 'utf8');

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [migration.name]);
        await client.query('COMMIT');
        console.log(`  ✅ ${migration.name} — applied`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  ❌ ${migration.name} — FAILED: ${err.message}`);
        process.exit(1);
      }
    }

    console.log('\n✨ All migrations complete.\n');
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch((err) => {
  console.error('Migration runner crashed:', err.message);
  process.exit(1);
});
