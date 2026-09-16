// Read-only diagnostic; never prints connection strings or application data.
require('dotenv').config();
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
(async () => {
  try {
    await client.connect();
    const result = await client.query(`SELECT c.relname, pg_get_triggerdef(t.oid) AS definition,
      pg_get_functiondef(t.tgfoid) AS function_definition FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid
      WHERE c.relname IN ('orders','order_items','products','agreements') AND NOT t.tgisinternal`);
    console.log(JSON.stringify(result.rows, null, 2));
  } finally { await client.end(); }
})().catch(error => { console.error('Schema inspection failed:', error.code); process.exitCode = 1; });
