// db/client.js
// Postgres client with safety helpers for multi-tenant queries

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[db] Pool error:', err);
});

// Generic query
async function query(sql, params = []) {
  const start = Date.now();
  try {
    const res = await pool.query(sql, params);
    const duration = Date.now() - start;
    if (duration > 500) console.log('[db] slow query:', duration, 'ms', sql.slice(0, 100));
    return res;
  } catch (e) {
    console.error('[db] Query error:', e.message, '\nSQL:', sql.slice(0, 200));
    throw e;
  }
}

// Single-row helper
async function one(sql, params = []) {
  const res = await query(sql, params);
  return res.rows[0] || null;
}

// Many-rows helper
async function many(sql, params = []) {
  const res = await query(sql, params);
  return res.rows;
}

// SAFETY: Force userId-scoped query — every multi-tenant query MUST go through this
// to prevent accidentally leaking data across users.
async function userQuery(userId, sql, params = []) {
  if (!userId) throw new Error('userQuery: userId is required');
  if (!sql.includes('user_id')) {
    throw new Error('userQuery: SQL must reference user_id column for safety');
  }
  return query(sql, [userId, ...params]);
}

async function userOne(userId, sql, params = []) {
  const res = await userQuery(userId, sql, params);
  return res.rows[0] || null;
}

async function userMany(userId, sql, params = []) {
  const res = await userQuery(userId, sql, params);
  return res.rows;
}

// Transaction helper
async function tx(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Run schema migration on startup
async function ensureSchema() {
  const fs = require('fs');
  const path = require('path');
  const schemaPath = path.join(__dirname, 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    console.warn('[db] schema.sql not found, skipping');
    return;
  }
  const sql = fs.readFileSync(schemaPath, 'utf8');
  try {
    await query(sql);
    console.log('[db] Schema ensured');
  } catch (e) {
    console.error('[db] Schema migration error:', e.message);
    throw e;
  }
}

module.exports = {
  pool,
  query,
  one,
  many,
  userQuery,
  userOne,
  userMany,
  tx,
  ensureSchema,
};
