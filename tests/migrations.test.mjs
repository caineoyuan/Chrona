import assert from 'node:assert/strict'
import test from 'node:test'
import { migrationChecksum, migrations, runMigrations } from '../server/migrations.js'

function fakePool(appliedRows = [], failSql = null) {
  const calls = []
  const client = {
    async query(text, params) {
      const normalized = text.trim()
      calls.push({ text: normalized, params })
      if (failSql && normalized === failSql) throw new Error('migration failed')
      if (normalized.startsWith('SELECT version, name, checksum')) {
        return { rows: appliedRows }
      }
      return { rows: [] }
    },
    release() {
      calls.push({ text: 'RELEASE' })
    },
  }
  return {
    calls,
    pool: { connect: async () => client },
  }
}

test('migrations are ordered and contain the planned sharing schema', () => {
  assert.deepEqual(migrations.map(({ version }) => version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
  const sql = migrations.map(({ up }) => up).join('\n')
  for (const table of [
    'user_identities',
    'share_invites',
    'buddy_streaks',
    'buddy_streak_members',
    'buddy_streak_completions',
    'medications',
    'medication_shares',
    'medication_lists',
    'medication_list_shares',
    'medication_dose_events',
    'collaboration_events',
    'ping_rate_limits',
    'share_invite_acceptances',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`))
  }
  assert.match(sql, /source\.medication->'history'/)
  assert.doesNotMatch(sql, /medication\.medication_data->'history'/)
  assert.match(sql, /ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT/)
  assert.match(sql, /SELECT id, 'local', lower\(username\), password_hash, created_at/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS users[\s\S]*password_hash TEXT NOT NULL/)
  assert.match(sql, /legacy_set_id\s+TEXT/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ/)
  assert.match(sql, /medication_dose_events_active_history_idx/)
  assert.match(sql, /collaboration_events_pending_push_idx/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS avatar_kind TEXT/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS avatar_data BYTEA/)
  assert.match(sql, /users_avatar_metadata_check/)
  assert.doesNotMatch(sql, /DROP TABLE user_medications/)
})

test('runner holds an advisory lock and applies each migration transactionally', async () => {
  const first = { version: 1, name: 'first', up: 'SELECT 1' }
  const second = { version: 2, name: 'second', up: 'SELECT 2' }
  const { pool, calls } = fakePool()

  await runMigrations(pool, [first, second])

  assert.match(calls[0].text, /pg_advisory_lock/)
  assert.deepEqual(
    calls.map(({ text }) => text).filter((text) => ['BEGIN', 'COMMIT'].includes(text)),
    ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT'],
  )
  assert.ok(calls.find(({ text }) => text === first.up))
  assert.ok(calls.find(({ text }) => text === second.up))
  assert.match(calls.at(-2).text, /pg_advisory_unlock/)
  assert.equal(calls.at(-1).text, 'RELEASE')
})

test('runner rolls back a failed migration before unlocking and releasing', async () => {
  const migration = { version: 1, name: 'broken', up: 'BROKEN SQL' }
  const { pool, calls } = fakePool([], migration.up)

  await assert.rejects(runMigrations(pool, [migration]), /migration failed/)

  const rollback = calls.findIndex(({ text }) => text === 'ROLLBACK')
  const unlock = calls.findIndex(({ text }) => /pg_advisory_unlock/.test(text))
  assert.ok(rollback > -1)
  assert.ok(unlock > rollback)
  assert.equal(calls.at(-1).text, 'RELEASE')
})

test('runner skips an already-applied migration with the same checksum', async () => {
  const migration = { version: 1, name: 'existing', up: 'SELECT 1' }
  const initial = fakePool()
  await runMigrations(initial.pool, [migration])
  const insert = initial.calls.find(({ text }) => text.startsWith('INSERT INTO schema_migrations'))
  const applied = [{
    version: insert.params[0],
    name: insert.params[1],
    checksum: insert.params[2],
  }]
  const repeated = fakePool(applied)

  await runMigrations(repeated.pool, [migration])

  assert.equal(repeated.calls.some(({ text }) => text === 'BEGIN'), false)
  assert.equal(repeated.calls.some(({ text }) => text === migration.up), false)
})

test('runner accepts an explicitly known prerelease migration definition', async () => {
  const migration = {
    version: 1,
    name: 'current',
    up: 'SELECT 1',
    legacyAppliedDefinitions: [{
      name: 'prerelease',
      checksum: 'known-checksum',
    }],
  }
  const applied = fakePool([{
    version: 1,
    name: 'prerelease',
    checksum: 'known-checksum',
  }])

  await runMigrations(applied.pool, [migration])

  assert.equal(applied.calls.some(({ text }) => text === 'BEGIN'), false)
})

test('migration 11 preserves its production checksum and accepts the short-lived altered definition', async () => {
  const migration = migrations.find(({ version }) => version === 11)
  const nextMigration = migrations.find(({ version }) => version === 12)

  assert.equal(
    migrationChecksum(migration),
    'd818dd6778a130966fb187a467baed7d90625ff139d79950711d352598da6eab',
  )
  assert.deepEqual(migration.legacyAppliedDefinitions, [{
    name: 'medication_list_sharing',
    checksum: '6e84a78f02cd5e537f88463587efa2273fe7f97d1faaaeb7e1d7412cf35c0b94',
  }])
  assert.equal(
    nextMigration.name,
    'buddy_streak_resource_constraints',
  )

  for (const checksum of [
    migrationChecksum(migration),
    migration.legacyAppliedDefinitions[0].checksum,
  ]) {
    const applied = fakePool([{
      version: 11,
      name: 'medication_list_sharing',
      checksum,
    }])
    await runMigrations(applied.pool, [migration, nextMigration])
    const insert = applied.calls.find(({ text }) =>
      text.startsWith('INSERT INTO schema_migrations'))
    assert.equal(insert.params[0], 12)
  }
})

test('runner rejects checksum drift and unknown applied migrations before writes', async () => {
  const migration = { version: 1, name: 'existing', up: 'SELECT 1' }
  const drifted = fakePool([{
    version: 1,
    name: migration.name,
    checksum: 'changed',
  }])
  await assert.rejects(
    runMigrations(drifted.pool, [migration]),
    /no longer matches its applied definition/,
  )
  assert.equal(drifted.calls.some(({ text }) => text === 'BEGIN'), false)

  const unknown = fakePool([{
    version: 2,
    name: 'future',
    checksum: 'unknown',
  }])
  await assert.rejects(
    runMigrations(unknown.pool, [migration]),
    /unknown migration version 2/,
  )
  assert.equal(unknown.calls.some(({ text }) => text === 'BEGIN'), false)
})

test('runner rejects unordered migrations before acquiring a connection', async () => {
  let connected = false
  await assert.rejects(
    runMigrations({
      async connect() {
        connected = true
        throw new Error('must not connect')
      },
    }, [
      { version: 2, name: 'second', up: 'SELECT 2' },
      { version: 1, name: 'first', up: 'SELECT 1' },
    ]),
    /strictly increasing integer versions/,
  )
  assert.equal(connected, false)
})
