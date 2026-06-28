import { Router } from 'express'
import { query } from './db.js'
import { requireAuth } from './auth.js'

const router = Router()

router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await query('SELECT sets FROM user_sets WHERE user_id = $1', [
      req.userId,
    ])
    const sets = result.rows[0]?.sets
    res.json({ sets: Array.isArray(sets) ? sets : [] })
  } catch (err) {
    console.error('get sets error', err)
    res.status(500).json({ error: 'Could not load your sets.' })
  }
})

router.put('/', requireAuth, async (req, res) => {
  try {
    const { sets } = req.body || {}
    if (!Array.isArray(sets)) {
      return res.status(400).json({ error: 'Expected an array of sets.' })
    }
    await query(
      `INSERT INTO user_sets (user_id, sets, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id)
       DO UPDATE SET sets = EXCLUDED.sets, updated_at = now()`,
      [req.userId, JSON.stringify(sets)],
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('put sets error', err)
    res.status(500).json({ error: 'Could not save your sets.' })
  }
})

export default router
