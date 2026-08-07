import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeStreak,
  dateKey,
  streakDate,
  todayKey,
  toggleSetCompleteToday,
} from '../src/lib.js'

function dailySet(completions = {}) {
  return {
    id: 'daily',
    createdAt: '2026-08-01T09:00:00',
    trackStreak: true,
    schedule: {
      freq: 'weekly',
      interval: 1,
      days: [0, 1, 2, 3, 4, 5, 6],
      anchor: '2026-08-01',
      mode: 'days',
    },
    completions,
    freezes: {},
  }
}

test('keeps the previous streak day active through the 12:30 AM minute', () => {
  const beforeDeadline = new Date(2026, 7, 7, 0, 29, 59)
  const atDeadline = new Date(2026, 7, 7, 0, 30, 0)
  const afterDeadline = new Date(2026, 7, 7, 0, 31, 0)

  assert.equal(dateKey(streakDate(beforeDeadline)), '2026-08-06')
  assert.equal(todayKey(beforeDeadline), '2026-08-06')
  assert.equal(todayKey(atDeadline), '2026-08-06')
  assert.equal(todayKey(afterDeadline), '2026-08-07')
})

test('credits a grace-period completion to the prior due date', () => {
  const set = dailySet()
  const { set: completed } = toggleSetCompleteToday(set, new Date(2026, 7, 7, 0, 15))

  assert.equal(completed.completions['2026-08-06'], true)
  assert.equal(completed.completions['2026-08-07'], undefined)
})

test('does not break a streak until the 12:30 AM deadline passes', () => {
  const set = dailySet({ '2026-08-05': true })

  assert.equal(computeStreak(set, new Date(2026, 7, 7, 0, 29)), 1)
  assert.equal(computeStreak(set, new Date(2026, 7, 7, 0, 31)), 0)
})
