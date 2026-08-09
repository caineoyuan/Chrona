import pg from 'pg'
import { runMigrations } from './migrations.js'

const { Pool } = pg

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  console.warn(
    '[chrona] DATABASE_URL is not set. The auth/data API will fail until a Postgres connection is configured.',
  )
}

// SSL rules:
//  - Local dev (localhost) → no SSL.
//  - Railway's PRIVATE network (*.railway.internal) → no SSL (not supported there).
//  - Anything else in production, or an explicit sslmode=require → SSL on.
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString || '')
const isRailwayInternal = /railway\.internal/.test(connectionString || '')
const useSsl =
  /sslmode=require/.test(connectionString || '') ||
  (process.env.NODE_ENV === 'production' && !isLocal && !isRailwayInternal)

export const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
})

export async function query(text, params) {
  return pool.query(text, params)
}

export async function migrateDatabase() {
  await runMigrations(pool)
}
