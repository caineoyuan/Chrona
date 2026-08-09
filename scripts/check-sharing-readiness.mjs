import fs from 'node:fs'
import path from 'node:path'

function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const separator = trimmed.indexOf('=')
      if (separator < 1) continue
      const key = trimmed.slice(0, separator).trim()
      let value = trimmed.slice(separator + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (!(key in process.env)) process.env[key] = value
    }
  } catch {
    // Deployment environments may supply variables without a local file.
  }
}

loadDotEnv(path.resolve('.env'))

if (!process.env.DATABASE_URL) {
  console.error('Sharing readiness: DATABASE_URL is not configured.')
  process.exitCode = 1
} else {
  const [{ pool }, { migrations, migrationChecksum }] = await Promise.all([
    import('../server/db.js'),
    import('../server/migrations.js'),
  ])
  const client = await pool.connect()
  let ready = false
  try {
    await client.query('BEGIN READ ONLY')
    const migrationTable = await client.query(
      `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
    )
    if (!migrationTable.rows[0].present) {
      console.log('Sharing readiness: NOT READY (schema_migrations is absent).')
    } else {
      const applied = await client.query(
        'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
      )
      const expected = new Map(migrations.map((migration) => [
        migration.version,
        { name: migration.name, checksum: migrationChecksum(migration) },
      ]))
      const drift = applied.rows.some((row) => {
        const migration = expected.get(Number(row.version))
        return !migration ||
          migration.name !== row.name ||
          migration.checksum !== row.checksum
      })
      const appliedVersions = new Set(applied.rows.map((row) => Number(row.version)))
      const pending = migrations
        .filter((migration) => !appliedVersions.has(migration.version))
        .map((migration) => migration.version)
      const schema = await client.query(`
        SELECT
          to_regclass('public.share_invites') IS NOT NULL
            AND to_regclass('public.share_invite_acceptances') IS NOT NULL
            AND to_regclass('public.medications') IS NOT NULL
            AND to_regclass('public.medication_shares') IS NOT NULL
            AND to_regclass('public.medication_dose_events') IS NOT NULL
            AND to_regclass('public.collaboration_events') IS NOT NULL
            AND to_regclass('public.medication_lists') IS NOT NULL
            AND to_regclass('public.medication_list_shares') IS NOT NULL
            AS complete
      `)
      ready = !drift && pending.length === 0 && schema.rows[0].complete
      const details = [
        drift ? 'migration checksum/name drift detected' : null,
        pending.length ? `pending migration versions: ${pending.join(', ')}` : null,
        !schema.rows[0].complete ? 'required sharing schema is incomplete' : null,
      ].filter(Boolean)
      console.log(ready
        ? 'Sharing readiness: READY (read-only schema and migration checks passed).'
        : `Sharing readiness: NOT READY (${details.join('; ')}).`)
    }
    await client.query('ROLLBACK')
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Preserve the original verification error.
    }
    console.error(`Sharing readiness: CHECK FAILED (${error.message}).`)
  } finally {
    client.release()
    await pool.end()
  }
  if (!ready) process.exitCode = 1
}
