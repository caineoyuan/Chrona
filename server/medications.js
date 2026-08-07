import { Router } from 'express'
import { requireAuth } from './auth.js'
import { query } from './db.js'

const router = Router()

router.get('/', requireAuth, async (request, response) => {
  try {
    const result = await query('SELECT medications FROM user_medications WHERE user_id = $1', [request.userId])
    const medications = result.rows[0]?.medications
    response.json({ medications: Array.isArray(medications) ? medications : [] })
  } catch (error) {
    console.error('get medications error', error)
    response.status(500).json({ error: 'Could not load your medications.' })
  }
})

router.put('/', requireAuth, async (request, response) => {
  try {
    const { medications } = request.body || {}
    if (!Array.isArray(medications)) {
      response.status(400).json({ error: 'Expected an array of medications.' })
      return
    }
    await query(
      `INSERT INTO user_medications (user_id, medications, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id)
       DO UPDATE SET medications = EXCLUDED.medications, updated_at = now()`,
      [request.userId, JSON.stringify(medications)],
    )
    response.json({ ok: true })
  } catch (error) {
    console.error('put medications error', error)
    response.status(500).json({ error: 'Could not save your medications.' })
  }
})

export default router
