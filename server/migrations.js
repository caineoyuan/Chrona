import { createHash } from 'node:crypto'

const MIGRATION_LOCK_NAMESPACE = 0x4348524f
const MIGRATION_LOCK_ID = 0x4e41

export const migrations = [
  {
    version: 1,
    name: 'legacy_schema',
    up: `
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        username      TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS user_sets (
        user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        sets       JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS user_medications (
        user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        medications JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint     TEXT PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subscription JSONB NOT NULL,
        tz           TEXT NOT NULL DEFAULT 'UTC',
        reminders    JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      ALTER TABLE push_subscriptions
        ADD COLUMN IF NOT EXISTS reminders JSONB NOT NULL DEFAULT '[]'::jsonb;
    `,
  },
  {
    version: 2,
    name: 'account_identities',
    up: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS display_username TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

      UPDATE users
      SET display_username = COALESCE(display_username, username),
          timezone = COALESCE(timezone, 'UTC'),
          status = COALESCE(status, 'active'),
          updated_at = COALESCE(updated_at, created_at, now())
      WHERE display_username IS NULL
         OR timezone IS NULL
         OR status IS NULL
         OR updated_at IS NULL;

      ALTER TABLE users ALTER COLUMN display_username SET NOT NULL;
      ALTER TABLE users ALTER COLUMN timezone SET DEFAULT 'UTC';
      ALTER TABLE users ALTER COLUMN timezone SET NOT NULL;
      ALTER TABLE users ALTER COLUMN status SET DEFAULT 'active';
      ALTER TABLE users ALTER COLUMN status SET NOT NULL;
      ALTER TABLE users ALTER COLUMN updated_at SET DEFAULT now();
      ALTER TABLE users ALTER COLUMN updated_at SET NOT NULL;
      ALTER TABLE users ADD CONSTRAINT users_status_check
        CHECK (status IN ('active', 'disabled', 'deleted'));

      CREATE TABLE IF NOT EXISTS user_identities (
        id                BIGSERIAL PRIMARY KEY,
        user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider          TEXT NOT NULL,
        provider_subject  TEXT NOT NULL,
        password_hash     TEXT,
        verified_email    TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_login_at     TIMESTAMPTZ,
        CONSTRAINT user_identities_provider_check
          CHECK (provider IN ('local', 'google')),
        CONSTRAINT user_identities_local_password_check
          CHECK (provider <> 'local' OR password_hash IS NOT NULL),
        CONSTRAINT user_identities_provider_subject_key
          UNIQUE (provider, provider_subject),
        CONSTRAINT user_identities_user_provider_key
          UNIQUE (user_id, provider)
      );

      INSERT INTO user_identities (
        user_id, provider, provider_subject, password_hash, created_at
      )
      SELECT id, 'local', lower(username), password_hash, created_at
      FROM users
      ON CONFLICT (provider, provider_subject) DO NOTHING;

      CREATE INDEX IF NOT EXISTS users_status_idx ON users (status);
      CREATE INDEX IF NOT EXISTS user_identities_user_id_idx
        ON user_identities (user_id);
      CREATE INDEX IF NOT EXISTS user_identities_google_email_idx
        ON user_identities (lower(verified_email))
        WHERE provider = 'google' AND verified_email IS NOT NULL;
    `,
  },
  {
    version: 3,
    name: 'sharing_invitations',
    legacyAppliedDefinitions: [{
      name: 'sharing_and_buddy_streaks',
      checksum: 'e36092ed9eed412490ef147a8c96a681029ba8b70327e827b7f4570c9736cf41',
    }],
    up: `
      CREATE TABLE IF NOT EXISTS share_invites (
        id                   BIGSERIAL PRIMARY KEY,
        resource_type        TEXT NOT NULL,
        resource_id          BIGINT NOT NULL,
        invited_by_user_id   INTEGER NOT NULL REFERENCES users(id),
        target_user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
        permission_payload   JSONB NOT NULL DEFAULT '{}'::jsonb,
        token_hash           TEXT NOT NULL UNIQUE,
        expires_at           TIMESTAMPTZ NOT NULL,
        max_uses             INTEGER NOT NULL DEFAULT 1,
        use_count            INTEGER NOT NULL DEFAULT 0,
        revoked_at           TIMESTAMPTZ,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT share_invites_resource_type_check
          CHECK (resource_type = 'medication_list'),
        CONSTRAINT share_invites_usage_check
          CHECK (max_uses > 0 AND use_count >= 0 AND use_count <= max_uses),
        CONSTRAINT share_invites_permissions_check
          CHECK (jsonb_typeof(permission_payload) = 'object'),
        CONSTRAINT share_invites_dates_check
          CHECK (expires_at > created_at AND (revoked_at IS NULL OR revoked_at >= created_at))
      );

      CREATE INDEX IF NOT EXISTS share_invites_target_idx
        ON share_invites (target_user_id, created_at DESC)
        WHERE revoked_at IS NULL;
      CREATE INDEX IF NOT EXISTS share_invites_resource_idx
        ON share_invites (resource_type, resource_id)
        WHERE revoked_at IS NULL;
      CREATE INDEX IF NOT EXISTS share_invites_expiry_idx
        ON share_invites (expires_at) WHERE revoked_at IS NULL;
    `,
  },
  {
    version: 4,
    name: 'medication_resources',
    up: `
      CREATE TABLE IF NOT EXISTS medications (
        id                 BIGSERIAL PRIMARY KEY,
        owner_user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        medication_data    JSONB NOT NULL,
        version            INTEGER NOT NULL DEFAULT 1,
        legacy_id          TEXT,
        legacy_position    INTEGER,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at         TIMESTAMPTZ,
        CONSTRAINT medications_id_owner_key UNIQUE (id, owner_user_id),
        CONSTRAINT medications_version_check CHECK (version > 0),
        CONSTRAINT medications_data_check
          CHECK (jsonb_typeof(medication_data) = 'object'),
        CONSTRAINT medications_legacy_position_key
          UNIQUE (owner_user_id, legacy_position),
        CONSTRAINT medications_dates_check
          CHECK (deleted_at IS NULL OR deleted_at >= created_at)
      );

      CREATE TABLE IF NOT EXISTS medication_shares (
        medication_id      BIGINT NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
        grantee_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role               TEXT NOT NULL,
        can_view_history   BOOLEAN NOT NULL DEFAULT false,
        created_by_user_id INTEGER NOT NULL REFERENCES users(id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        revoked_at         TIMESTAMPTZ,
        PRIMARY KEY (medication_id, grantee_user_id),
        CONSTRAINT medication_shares_role_check CHECK (role IN ('viewer', 'editor')),
        CONSTRAINT medication_shares_dates_check
          CHECK (revoked_at IS NULL OR revoked_at >= created_at)
      );

      CREATE TABLE IF NOT EXISTS medication_dose_events (
        id                    BIGSERIAL PRIMARY KEY,
        medication_id         BIGINT NOT NULL,
        owner_user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        legacy_id             TEXT,
        scheduled_at          TIMESTAMPTZ NOT NULL,
        taken_at              TIMESTAMPTZ,
        skipped_at            TIMESTAMPTZ,
        original_scheduled_at TIMESTAMPTZ,
        status                TEXT NOT NULL,
        injection_site        TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT medication_dose_events_medication_owner_fkey
          FOREIGN KEY (medication_id, owner_user_id)
          REFERENCES medications (id, owner_user_id)
          ON DELETE CASCADE,
        CONSTRAINT medication_dose_events_status_check
          CHECK (status IN ('scheduled', 'taken', 'on-time', 'late', 'skipped', 'missed')),
        CONSTRAINT medication_dose_events_outcome_check
          CHECK (NOT (taken_at IS NOT NULL AND skipped_at IS NOT NULL))
      );

      INSERT INTO medications (
        owner_user_id, medication_data, legacy_id, legacy_position, created_at, updated_at
      )
      SELECT
        source.user_id,
        source.medication - 'history',
        NULLIF(source.medication->>'id', ''),
        source.position::integer,
        CASE
          WHEN source.medication->>'createdAt'
            ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
          THEN (source.medication->>'createdAt')::timestamptz
          ELSE source.updated_at
        END,
        source.updated_at
      FROM (
        SELECT
          um.user_id,
          um.updated_at,
          item.medication,
          item.position
        FROM user_medications um
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(um.medications) = 'array' THEN um.medications
            ELSE '[]'::jsonb
          END
        ) WITH ORDINALITY AS item(medication, position)
      ) source
      ON CONFLICT (owner_user_id, legacy_position) DO NOTHING;

      INSERT INTO medication_dose_events (
        medication_id,
        owner_user_id,
        legacy_id,
        scheduled_at,
        taken_at,
        skipped_at,
        original_scheduled_at,
        status,
        injection_site,
        created_at,
        updated_at
      )
      SELECT
        medication.id,
        medication.owner_user_id,
        NULLIF(history.record->>'id', ''),
        (history.record->>'scheduledAt')::timestamptz,
        CASE WHEN history.record->>'takenAt' IS NOT NULL
          THEN (history.record->>'takenAt')::timestamptz END,
        CASE WHEN history.record->>'skippedAt' IS NOT NULL
          THEN (history.record->>'skippedAt')::timestamptz END,
        CASE WHEN history.record->>'originalScheduledAt' IS NOT NULL
          THEN (history.record->>'originalScheduledAt')::timestamptz END,
        CASE
          WHEN history.record->>'status' IN (
            'scheduled', 'taken', 'on-time', 'late', 'skipped', 'missed'
          ) THEN history.record->>'status'
          WHEN history.record->>'skippedAt' IS NOT NULL THEN 'skipped'
          WHEN history.record->>'takenAt' IS NOT NULL THEN 'taken'
          ELSE 'scheduled'
        END,
        NULLIF(history.record->>'injectionSite', ''),
        medication.created_at,
        medication.updated_at
      FROM user_medications legacy
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(legacy.medications) = 'array' THEN legacy.medications
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS source(medication, position)
      JOIN medications medication
        ON medication.owner_user_id = legacy.user_id
       AND medication.legacy_position = source.position
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(source.medication->'history') = 'array'
            THEN source.medication->'history'
          ELSE '[]'::jsonb
        END
      ) history(record);

      CREATE INDEX IF NOT EXISTS medications_owner_idx
        ON medications (owner_user_id, updated_at DESC) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS medications_legacy_id_idx
        ON medications (owner_user_id, legacy_id) WHERE legacy_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS medication_shares_grantee_idx
        ON medication_shares (grantee_user_id, medication_id) WHERE revoked_at IS NULL;
      CREATE INDEX IF NOT EXISTS medication_dose_events_history_idx
        ON medication_dose_events (medication_id, scheduled_at DESC);
      CREATE INDEX IF NOT EXISTS medication_dose_events_owner_idx
        ON medication_dose_events (owner_user_id, scheduled_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS medication_dose_events_legacy_id_idx
        ON medication_dose_events (medication_id, legacy_id)
        WHERE legacy_id IS NOT NULL;
    `,
  },
  {
    version: 5,
    name: 'collaboration_activity',
    legacyAppliedDefinitions: [{
      name: 'collaboration_activity',
      checksum: '1da2063144d3c0c9c081b8cdd2938cdf6b325fafce9901907f9461c400de3a7e',
    }],
    up: `
      CREATE TABLE IF NOT EXISTS collaboration_events (
        id                 BIGSERIAL PRIMARY KEY,
        resource_type      TEXT NOT NULL,
        resource_id        BIGINT NOT NULL,
        actor_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        recipient_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_type         TEXT NOT NULL,
        payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
        deduplication_key  TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        read_at            TIMESTAMPTZ,
        CONSTRAINT collaboration_events_resource_type_check
          CHECK (resource_type IN ('medication', 'medication_list')),
        CONSTRAINT collaboration_events_event_type_check
          CHECK (event_type IN (
            'invite', 'accepted', 'edited', 'removed'
          )),
        CONSTRAINT collaboration_events_read_date_check
          CHECK (read_at IS NULL OR read_at >= created_at)
      );

      CREATE INDEX IF NOT EXISTS collaboration_events_inbox_idx
        ON collaboration_events (recipient_user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS collaboration_events_unread_idx
        ON collaboration_events (recipient_user_id, created_at DESC)
        WHERE read_at IS NULL;
      CREATE INDEX IF NOT EXISTS collaboration_events_resource_idx
        ON collaboration_events (resource_type, resource_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS collaboration_events_deduplication_idx
        ON collaboration_events (recipient_user_id, deduplication_key)
        WHERE deduplication_key IS NOT NULL;
    `,
  },
  {
    version: 6,
    name: 'share_invite_acceptances',
    up: `
      CREATE TABLE IF NOT EXISTS share_invite_acceptances (
        invite_id    BIGINT NOT NULL REFERENCES share_invites(id) ON DELETE CASCADE,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        accepted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (invite_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS share_invite_acceptances_user_idx
        ON share_invite_acceptances (user_id, accepted_at DESC);
    `,
  },
  {
    version: 7,
    name: 'buddy_streak_private_set_promotion',
    legacyAppliedDefinitions: [{
      name: 'buddy_streak_private_set_promotion',
      checksum: '06fd31e7f83f3b9b04021a3e32295c75629bd0d7ff536e7b0c9fcd2d4771d007',
    }],
    up: `
      CREATE TABLE IF NOT EXISTS buddy_streaks (
        id                   BIGSERIAL PRIMARY KEY,
        definition           JSONB NOT NULL,
        version              INTEGER NOT NULL DEFAULT 1,
        created_by_user_id   INTEGER NOT NULL REFERENCES users(id),
        legacy_set_id        TEXT,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at           TIMESTAMPTZ,
        CONSTRAINT buddy_streaks_version_check CHECK (version > 0),
        CONSTRAINT buddy_streaks_definition_check
          CHECK (jsonb_typeof(definition) = 'object'),
        CONSTRAINT buddy_streaks_dates_check
          CHECK (deleted_at IS NULL OR deleted_at >= created_at)
      );

      CREATE TABLE IF NOT EXISTS buddy_streak_members (
        buddy_streak_id BIGINT NOT NULL REFERENCES buddy_streaks(id) ON DELETE CASCADE,
        user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role             TEXT NOT NULL DEFAULT 'participant',
        timezone         TEXT NOT NULL DEFAULT 'UTC',
        joined_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        active_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        removed_at       TIMESTAMPTZ,
        PRIMARY KEY (buddy_streak_id, user_id),
        CONSTRAINT buddy_streak_members_role_check
          CHECK (role IN ('participant', 'observer')),
        CONSTRAINT buddy_streak_members_dates_check
          CHECK (removed_at IS NULL OR removed_at >= active_at)
      );

      CREATE TABLE IF NOT EXISTS buddy_streak_completions (
        buddy_streak_id    BIGINT NOT NULL REFERENCES buddy_streaks(id) ON DELETE CASCADE,
        user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        period_key         TEXT NOT NULL,
        local_completed_at TIMESTAMP NOT NULL,
        completed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        source             TEXT NOT NULL DEFAULT 'manual',
        PRIMARY KEY (buddy_streak_id, user_id, period_key),
        CONSTRAINT buddy_streak_completions_member_fkey
          FOREIGN KEY (buddy_streak_id, user_id)
          REFERENCES buddy_streak_members (buddy_streak_id, user_id)
          ON DELETE CASCADE,
        CONSTRAINT buddy_streak_completions_source_check
          CHECK (source IN ('manual', 'timer', 'import'))
      );

      CREATE TABLE IF NOT EXISTS ping_rate_limits (
        id                 BIGSERIAL PRIMARY KEY,
        sender_user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        resource_type      TEXT NOT NULL,
        resource_id        BIGINT NOT NULL,
        sent_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ping_rate_limits_resource_type_check
          CHECK (resource_type = 'buddy_streak'),
        CONSTRAINT ping_rate_limits_distinct_users_check
          CHECK (sender_user_id <> recipient_user_id)
      );

      ALTER TABLE share_invites DROP CONSTRAINT IF EXISTS share_invites_resource_type_check;
      ALTER TABLE share_invites ADD CONSTRAINT share_invites_resource_type_check
        CHECK (resource_type IN ('buddy_streak', 'medication', 'medication_list'));

      ALTER TABLE collaboration_events
        DROP CONSTRAINT IF EXISTS collaboration_events_resource_type_check;
      ALTER TABLE collaboration_events
        ADD CONSTRAINT collaboration_events_resource_type_check
        CHECK (resource_type IN ('buddy_streak', 'medication', 'medication_list'));
      ALTER TABLE collaboration_events
        DROP CONSTRAINT IF EXISTS collaboration_events_event_type_check;
      ALTER TABLE collaboration_events
        ADD CONSTRAINT collaboration_events_event_type_check
        CHECK (event_type IN (
          'invite', 'accepted', 'completed', 'ping', 'edited', 'removed', 'automatic_reminder'
        ));

      CREATE UNIQUE INDEX IF NOT EXISTS buddy_streaks_legacy_set_idx
        ON buddy_streaks (created_by_user_id, legacy_set_id)
        WHERE legacy_set_id IS NOT NULL AND deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS buddy_streaks_creator_idx
        ON buddy_streaks (created_by_user_id) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS buddy_streak_members_user_idx
        ON buddy_streak_members (user_id, buddy_streak_id) WHERE removed_at IS NULL;
      CREATE INDEX IF NOT EXISTS buddy_streak_completions_period_idx
        ON buddy_streak_completions (buddy_streak_id, period_key);
      CREATE INDEX IF NOT EXISTS ping_rate_limits_window_idx
        ON ping_rate_limits (
          sender_user_id, recipient_user_id, resource_type, resource_id, sent_at DESC
        );
    `,
  },
  {
    version: 8,
    name: 'medication_rollback_safety',
    up: `
      ALTER TABLE medication_dose_events
        ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE medication_dose_events
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

      ALTER TABLE medication_dose_events
        ADD CONSTRAINT medication_dose_events_version_check CHECK (version > 0);
      ALTER TABLE medication_dose_events
        ADD CONSTRAINT medication_dose_events_deleted_date_check
          CHECK (deleted_at IS NULL OR deleted_at >= created_at);

      CREATE INDEX IF NOT EXISTS medication_dose_events_active_history_idx
        ON medication_dose_events (medication_id, scheduled_at DESC)
        WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 9,
    name: 'collaboration_notification_delivery',
    up: `
      ALTER TABLE collaboration_events
        ADD COLUMN IF NOT EXISTS push_requested_at TIMESTAMPTZ;
      ALTER TABLE collaboration_events
        ADD COLUMN IF NOT EXISTS push_claimed_at TIMESTAMPTZ;
      ALTER TABLE collaboration_events
        ADD COLUMN IF NOT EXISTS push_dispatched_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS collaboration_events_pending_push_idx
        ON collaboration_events (push_requested_at, id)
        WHERE push_requested_at IS NOT NULL AND push_dispatched_at IS NULL;
    `,
  },
  {
    version: 10,
    name: 'profile_avatar_metadata',
    up: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_kind TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_value TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_color TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_file TEXT;

      ALTER TABLE users ADD CONSTRAINT users_avatar_kind_check
        CHECK (avatar_kind IS NULL OR avatar_kind IN ('initial', 'bundled', 'upload'));
      ALTER TABLE users ADD CONSTRAINT users_avatar_color_check
        CHECK (
          avatar_color IS NULL OR avatar_color IN (
            '52AA8A', '52AA5E', '388659', 'E26D5C', 'FDB833',
            '1789FC', '4A5759', 'F26157', 'EF7B45', '5EB1BF',
            '94DDBC', '136F63', '465362'
          )
        );
      ALTER TABLE users ADD CONSTRAINT users_avatar_metadata_check
        CHECK (
          avatar_kind IS NULL
          OR (avatar_kind = 'initial'
              AND avatar_color IS NOT NULL AND avatar_value IS NULL AND avatar_file IS NULL)
          OR (avatar_kind = 'bundled'
              AND avatar_value IS NOT NULL AND avatar_color IS NULL AND avatar_file IS NULL)
          OR (avatar_kind = 'upload'
              AND avatar_file IS NOT NULL AND avatar_value IS NULL AND avatar_color IS NULL)
        );
    `,
  },
  {
    version: 11,
    name: 'medication_list_sharing',
    legacyAppliedDefinitions: [{
      name: 'medication_list_sharing',
      checksum: '6e84a78f02cd5e537f88463587efa2273fe7f97d1faaaeb7e1d7412cf35c0b94',
    }],
    up: `
      CREATE TABLE IF NOT EXISTS medication_lists (
        owner_user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        version       INTEGER NOT NULL DEFAULT 1,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT medication_lists_version_check CHECK (version > 0)
      );

      INSERT INTO medication_lists (owner_user_id)
      SELECT id FROM users
      ON CONFLICT (owner_user_id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS medication_list_shares (
        owner_user_id      INTEGER NOT NULL REFERENCES medication_lists(owner_user_id) ON DELETE CASCADE,
        grantee_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role               TEXT NOT NULL,
        can_view_history   BOOLEAN NOT NULL DEFAULT false,
        created_by_user_id INTEGER NOT NULL REFERENCES users(id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        revoked_at         TIMESTAMPTZ,
        PRIMARY KEY (owner_user_id, grantee_user_id),
        CONSTRAINT medication_list_shares_role_check CHECK (role IN ('viewer', 'editor')),
        CONSTRAINT medication_list_shares_distinct_users_check
          CHECK (owner_user_id <> grantee_user_id),
        CONSTRAINT medication_list_shares_dates_check
          CHECK (revoked_at IS NULL OR revoked_at >= created_at)
      );

      CREATE INDEX IF NOT EXISTS medication_list_shares_grantee_idx
        ON medication_list_shares (grantee_user_id, owner_user_id)
        WHERE revoked_at IS NULL;

      ALTER TABLE share_invites DROP CONSTRAINT IF EXISTS share_invites_resource_type_check;
      ALTER TABLE share_invites ADD CONSTRAINT share_invites_resource_type_check
        CHECK (resource_type = 'medication_list');

      ALTER TABLE collaboration_events
        DROP CONSTRAINT IF EXISTS collaboration_events_resource_type_check;
      ALTER TABLE collaboration_events
        ADD CONSTRAINT collaboration_events_resource_type_check
        CHECK (resource_type IN ('medication', 'medication_list'));
    `,
  },
  {
    version: 12,
    name: 'buddy_streak_resource_constraints',
    up: `
      ALTER TABLE share_invites DROP CONSTRAINT IF EXISTS share_invites_resource_type_check;
      ALTER TABLE share_invites ADD CONSTRAINT share_invites_resource_type_check
        CHECK (resource_type IN ('buddy_streak', 'medication', 'medication_list'));

      ALTER TABLE collaboration_events
        DROP CONSTRAINT IF EXISTS collaboration_events_resource_type_check;
      ALTER TABLE collaboration_events
        ADD CONSTRAINT collaboration_events_resource_type_check
        CHECK (resource_type IN ('buddy_streak', 'medication', 'medication_list'));
    `,
  },
]

export function migrationChecksum(migration) {
  return createHash('sha256').update(migration.up).digest('hex')
}

function validateMigrations(orderedMigrations) {
  let previous = 0
  const versions = new Set()
  for (const migration of orderedMigrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previous) {
      throw new Error('Database migrations must have strictly increasing integer versions')
    }
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate database migration version ${migration.version}`)
    }
    versions.add(migration.version)
    previous = migration.version
  }
}

export async function runMigrations(pool, orderedMigrations = migrations) {
  validateMigrations(orderedMigrations)
  const client = await pool.connect()

  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [
      MIGRATION_LOCK_NAMESPACE,
      MIGRATION_LOCK_ID,
    ])

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    const applied = await client.query(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    )
    const available = new Map(orderedMigrations.map((migration) => [
      migration.version,
      migration,
    ]))

    for (const record of applied.rows) {
      const migration = available.get(Number(record.version))
      if (!migration) {
        throw new Error(`Database has unknown migration version ${record.version}`)
      }
      const currentDefinition = record.name === migration.name &&
        record.checksum === migrationChecksum(migration)
      const legacyDefinition = migration.legacyAppliedDefinitions?.some((definition) =>
        definition.name === record.name && definition.checksum === record.checksum)
      if (!currentDefinition && !legacyDefinition) {
        throw new Error(`Database migration ${record.version} no longer matches its applied definition`)
      }
    }

    const appliedVersions = new Set(applied.rows.map((record) => Number(record.version)))
    for (const migration of orderedMigrations) {
      if (appliedVersions.has(migration.version)) continue
      await client.query('BEGIN')
      try {
        await client.query(migration.up)
        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum)
           VALUES ($1, $2, $3)`,
          [migration.version, migration.name, migrationChecksum(migration)],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [
        MIGRATION_LOCK_NAMESPACE,
        MIGRATION_LOCK_ID,
      ])
    } finally {
      client.release()
    }
  }
}
