import express from 'express'
import cookieParser from 'cookie-parser'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Load .env (tiny parser, no extra dependency) before importing modules that read env.
function loadDotEnv(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (!(key in process.env)) process.env[key] = value
    }
  } catch {
    /* no .env file — rely on real environment variables (e.g. Railway) */
  }
}

loadDotEnv(path.join(__dirname, '.env'))

const { migrateDatabase } = await import('./server/db.js')
const { features, featureUnavailable } = await import('./server/feature-flags.js')
const { default: authRouter } = await import('./server/auth.js')
const { requireAuth } = await import('./server/auth.js')
const { createProfileRouter } = await import('./server/profile.js')
const { default: setsRouter } = await import('./server/sets.js')
const { createMedicationsRouter } = await import('./server/medications.js')
const { default: sharingRouter } = await import('./server/sharing.js')
const { default: buddyStreaksRouter } = await import('./server/buddy-streaks.js')
const { default: activityRouter } = await import('./server/activity.js')
const { default: pushRouter, startPushCron } = await import('./server/push.js')

const app = express()
app.use(express.json({ limit: '2mb' }))
app.use(cookieParser())

app.use('/api/auth', authRouter)
app.use('/api/profile', createProfileRouter({ requireAuth }))
app.use('/api/users/profile', createProfileRouter({ requireAuth }))
app.use('/api/sets', setsRouter)
app.use('/api/medications', createMedicationsRouter(undefined, features))
app.use('/api/sharing', features.sharing ? sharingRouter : featureUnavailable)
app.use('/api/buddy-streaks', features.sharing ? buddyStreaksRouter : featureUnavailable)
app.use('/api/activity', features.sharing ? activityRouter : featureUnavailable)
app.use('/api/push', pushRouter)
app.get('/api/health', (_req, res) => res.json({
  ok: true,
  features: { sharing: features.sharing },
}))

// Serve the built front-end (production) with SPA fallback.
const dist = path.join(__dirname, 'dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(dist, 'index.html'))
  })
}

const port = process.env.PORT || 4173

migrateDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`Chrona running on port ${port}`)
      startPushCron()
    })
  })
  .catch((err) => {
    console.error('Failed to run database migrations:', err)
    process.exit(1)
  })
