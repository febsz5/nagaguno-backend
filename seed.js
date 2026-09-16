// seed.js — seeds an admin account, three test accounts (farmer/vendor/buyer),
// and sample products/crop plans, all via direct SQL against this app's own
// `users` table (bcrypt password_hash), matching how routes/auth.js +
// controllers/authController.js actually authenticate. Safe to re-run.
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12');

const SAMPLE_PRODUCTS = [
  { name: 'Pechay (Bok Choy)', category: 'vegetables', price_per_unit: 35, unit: 'kg', stock_qty: 100, description: 'Fresh pechay harvested daily from our farm in Barangay San Felipe.' },
  { name: 'Ampalaya (Bitter Gourd)', category: 'vegetables', price_per_unit: 50, unit: 'kg', stock_qty: 80, description: 'Organically grown ampalaya. Great for blood sugar management.' },
  { name: 'Kamote (Sweet Potato)', category: 'root crops', price_per_unit: 28, unit: 'kg', stock_qty: 150, description: 'Orange-flesh kamote, sweet and nutritious.' },
  { name: 'NFA Rice', category: 'rice', price_per_unit: 45, unit: 'kg', stock_qty: 500, description: 'Premium quality rice from local paddies.' },
  { name: 'Kangkong (Water Spinach)', category: 'vegetables', price_per_unit: 20, unit: 'bundle', stock_qty: 200, description: 'Fresh kangkong, perfect for sinigang and adobo.' },
  { name: 'Siling Labuyo', category: 'herbs', price_per_unit: 80, unit: 'kg', stock_qty: 30, description: 'Fiery local chili, freshly picked.' },
  { name: 'Bataw (Hyacinth Bean)', category: 'legumes', price_per_unit: 45, unit: 'kg', stock_qty: 60, description: 'Tender bataw pods, great for stews.' },
  { name: 'Kalabasa (Squash)', category: 'vegetables', price_per_unit: 30, unit: 'kg', stock_qty: 120, description: 'Locally grown calabasa, sweet and creamy.' },
];

const SAMPLE_CROPS = [
  {
    crop_name: 'Pechay Batch 2', category: 'vegetables', quantity_kg: 50, unit: 'kg', stage: 'growing',
    planting_date: new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0],
    expected_harvest: new Date(Date.now() + 20 * 86400000).toISOString().split('T')[0],
    field_location: 'Field A, Barangay San Felipe',
  },
  {
    crop_name: 'Kamote Crop', category: 'root crops', quantity_kg: 200, unit: 'kg', stage: 'planted',
    planting_date: new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0],
    expected_harvest: new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0],
    field_location: 'Field B, Barangay San Felipe',
  },
];

const TEST_USERS = [
  { email: 'farmer@nagaguno.test', password: 'Farmer@2026!', full_name: 'Maria Santos', role: 'farmer', barangay: 'San Felipe' },
  { email: 'buyer@nagaguno.test', password: 'Buyer@2026!', full_name: 'Jose Reyes', role: 'buyer', barangay: 'Triangulo' },
  { email: 'vendor@nagaguno.test', password: 'Vendor@2026!', full_name: 'Ana Villanueva', role: 'vendor', barangay: 'Calauag' },
];

async function seedAdmin(client) {
  console.log('\n👤 Seeding admin user...');
  const hashedPw = await bcrypt.hash(process.env.ADMIN_PASSWORD, SALT_ROUNDS);
  await client.query(
    `INSERT INTO users (email, password_hash, full_name, role, account_status)
     VALUES ($1, $2, $3, 'admin', 'active')
     ON CONFLICT (email) DO NOTHING;`,
    [process.env.ADMIN_EMAIL, hashedPw, process.env.ADMIN_FULL_NAME]
  );
  console.log(`✅ Admin ready: ${process.env.ADMIN_EMAIL}`);
}

async function seedTestUsers(client) {
  console.log('\n👥 Seeding test users...');
  const ids = {};

  for (const u of TEST_USERS) {
    const hashedPw = await bcrypt.hash(u.password, SALT_ROUNDS);
    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, full_name, role, barangay, account_status, auth_provider)
       VALUES ($1, $2, $3, $4, $5, 'active', 'email')
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING id, role`,
      [u.email, hashedPw, u.full_name, u.role, u.barangay]
    );
    const userId = rows[0].id;
    ids[u.role] = userId;

    const profileTable = { farmer: 'farmer_profiles', vendor: 'vendor_profiles', buyer: 'buyer_profiles' }[u.role];
    if (profileTable) {
      await client.query(
        `INSERT INTO ${profileTable} (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
        [userId]
      );
    }
    console.log(`✅ User ready: ${u.email} (${u.role})`);
  }

  return ids;
}

async function seedFarmerData(client, farmerId) {
  if (!farmerId) { console.warn('⚠️  No farmer id, skipping products/crops.'); return; }

  console.log('\n🌾 Seeding products...');
  for (const p of SAMPLE_PRODUCTS) {
    await client.query(
      `INSERT INTO products (seller_id, seller_role, name, description, category, unit, price_per_unit, stock_qty, barangay, status)
       VALUES ($1, 'farmer', $2, $3, $4, $5, $6, $7, 'San Felipe', 'live')`,
      [farmerId, p.name, p.description, p.category, p.unit, p.price_per_unit, p.stock_qty]
    );
  }
  console.log(`✅ Seeded ${SAMPLE_PRODUCTS.length} products`);

  console.log('\n🌱 Seeding crop plans...');
  for (const c of SAMPLE_CROPS) {
    await client.query(
      `INSERT INTO crop_plans (farmer_id, crop_name, category, quantity_kg, unit, field_location, barangay, planting_date, expected_harvest, stage)
       VALUES ($1, $2, $3, $4, $5, $6, 'San Felipe', $7, $8, $9)`,
      [farmerId, c.crop_name, c.category, c.quantity_kg, c.unit, c.field_location, c.planting_date, c.expected_harvest, c.stage]
    );
  }
  console.log(`✅ Seeded ${SAMPLE_CROPS.length} crop plans`);
}

async function runSeed() {
  console.log('🌱 NagaGuno Database Seeder\n');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedAdmin(client);
    const ids = await seedTestUsers(client);
    await seedFarmerData(client, ids.farmer);
    await client.query('COMMIT');

    console.log('\n🎉 Seeding complete!\n\nTest accounts:');
    TEST_USERS.forEach(u => console.log(`  ${u.role.padEnd(8)} ${u.email.padEnd(28)} ${u.password}`));
    console.log(`  ${'admin'.padEnd(8)} ${process.env.ADMIN_EMAIL}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runSeed();
