import pg from 'pg'

const { Pool } = pg

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  console.warn(
    '[chrona] DATABASE_URL is not set. The auth/data API will fail until a Postgres connection is configured.',
  )
}

// Railway (and most hosted Postgres) require SSL; local dev does not.
const useSsl =
  /sslmode=require/.test(connectionString || '') ||
  (process.env.NODE_ENV === 'production' &&
    !/localhost|127\.0\.0\.1/.test(connectionString || ''))

export const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
})

export async function query(text, params) {
  return pool.query(text, params)
}

// Create tables if they don't exist yet.
export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sets (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      sets       JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
}
