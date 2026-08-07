import assert from 'node:assert/strict'
import test from 'node:test'
import { inferScheduleRecommendation } from '../src/medira/openFda.js'

test('infers daily FDA instructions at 11 AM', () => {
  assert.deepEqual(inferScheduleRecommendation('Take one tablet once daily.'), {
    type: 'daily',
    intervalHours: 24,
    times: ['11:00'],
    weekdays: [],
  })
})

test('infers common hourly FDA instructions', () => {
  assert.equal(inferScheduleRecommendation('Take one capsule every 6 hours.').intervalHours, 6)
  assert.equal(inferScheduleRecommendation('Take one tablet twice daily.').intervalHours, 12)
  assert.equal(inferScheduleRecommendation('Take one tablet three times a day.').intervalHours, 8)
})

test('infers weekly FDA instructions and leaves unclear labels unchanged', () => {
  assert.deepEqual(inferScheduleRecommendation('Inject once weekly.').weekdays, [1])
  assert.deepEqual(inferScheduleRecommendation('Use two times per week.').weekdays, [1, 4])
  assert.equal(inferScheduleRecommendation('Take as directed by your clinician.'), null)
})
