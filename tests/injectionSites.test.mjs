import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adjustScheduleAfterDose,
  adherenceFor,
  formatRelative,
  getActionableDoses,
  getDosesForDay,
  getNextDose,
  getLastTaken,
  getRecentDoses,
  getRecentInjectionSites,
  getUpcomingReminders,
  INJECTION_SITE_CODES,
  inventoryInteger,
  isFutureLocalDate,
  localScheduleAnchor,
  medicationCalendarMonths,
  overrideScheduledTime,
  overrideTakenDate,
  parsePastedTime,
  reminderOffsets,
  timePartInput,
  timesForScheduleType,
  toTwelveHourTime,
  toTwentyFourHourTime,
  undoScheduleAfterDose,
  updateTimeDigit,
  wakingHourSchedule,
} from '../src/medira/lib.js'

test('normalizes inventory quantities to non-negative integers', () => {
  assert.equal(inventoryInteger(8.6), 9)
  assert.equal(inventoryInteger('4.2'), 4)
  assert.equal(inventoryInteger(-3), 0)
  assert.equal(inventoryInteger('invalid', 5), 5)
})

test('orders the last two testosterone injection sites for highlighting', () => {
  const testosterone = {
    name: 'Testosterone injection',
    history: [
      { takenAt: '2026-07-20T09:00:00Z', injectionSite: 'left-upper' },
      { takenAt: '2026-07-27T09:00:00Z', injectionSite: 'right-lower' },
      { takenAt: '2026-08-03T09:00:00Z', injectionSite: 'left-lower' },
      { takenAt: '2026-08-04T09:00:00Z', injectionSite: null },
    ],
  }

  assert.deepEqual(getRecentInjectionSites(testosterone), ['left-lower', 'right-lower'])
})

test('updates valid time digits while preserving the colon', () => {
  assert.equal(updateTimeDigit('08:00', 0, '1'), '18:00')
  assert.equal(updateTimeDigit('08:00', 0, '2'), '20:00')
  assert.equal(updateTimeDigit('18:00', 1, '9'), '19:00')
  assert.equal(updateTimeDigit('19:00', 2, '4'), '19:40')
  assert.equal(updateTimeDigit('19:40', 3, '5'), '19:45')
  assert.equal(updateTimeDigit('19:45', 0, '3'), '19:45')
})

test('accepts only complete valid pasted times', () => {
  assert.equal(parsePastedTime('09:30'), '09:30')
  assert.equal(parsePastedTime('2359'), '23:59')
  assert.equal(parsePastedTime('9:30 PM'), '21:30')
  assert.equal(parsePastedTime('25:00'), null)
  assert.equal(parsePastedTime('930'), null)
})

test('converts AM and PM schedule times without changing local clock intent', () => {
  assert.deepEqual(toTwelveHourTime('00:15'), { hours: '12', minutes: '15', period: 'AM' })
  assert.deepEqual(toTwelveHourTime('12:30'), { hours: '12', minutes: '30', period: 'PM' })
  assert.deepEqual(toTwelveHourTime('21:45'), { hours: '09', minutes: '45', period: 'PM' })
  assert.equal(toTwentyFourHourTime('12', '15', 'AM'), '00:15')
  assert.equal(toTwentyFourHourTime('12', '30', 'PM'), '12:30')
  assert.equal(toTwentyFourHourTime('9', '45', 'PM'), '21:45')
})

test('formats next-dose countdowns in days after 24 hours', () => {
  const now = new Date('2026-08-06T09:00:00')
  assert.equal(formatRelative(new Date('2026-08-07T09:00:00'), now), '1 day')
  assert.equal(formatRelative(new Date('2026-08-07T10:00:00'), now), '1 day 1 hour')
  assert.equal(formatRelative(new Date('2026-08-08T11:00:00'), now), '2 days 2 hours')
})

test('starts a fresh time part when iOS retains the selected value', () => {
  assert.equal(timePartInput('081', true), '1')
  assert.equal(timePartInput('1', false), '1')
  assert.equal(timePartInput('10', false), '10')
  assert.equal(timePartInput('11', false), '11')
  assert.equal(timePartInput('12', false), '12')
})

test('fills interval schedules across waking hours', () => {
  assert.deepEqual(wakingHourSchedule(3), ['09:00', '12:00', '15:00', '18:00', '21:00'])
  assert.deepEqual(wakingHourSchedule(6), ['09:00', '15:00', '21:00'])
  assert.deepEqual(wakingHourSchedule(7), ['09:00', '16:00', '23:00'])
  assert.deepEqual(wakingHourSchedule(12), ['09:00', '21:00'])
  assert.deepEqual(wakingHourSchedule(1), wakingHourSchedule(3))
  assert.deepEqual(wakingHourSchedule(20), wakingHourSchedule(12))
})

test('removes generated hourly times when switching to daily or weekly', () => {
  const hourlyTimes = wakingHourSchedule(6)
  assert.deepEqual(timesForScheduleType('interval', 'daily', hourlyTimes, 6), ['08:00'])
  assert.deepEqual(timesForScheduleType('interval', 'weekly', hourlyTimes, 6), ['08:00'])
  assert.deepEqual(timesForScheduleType('daily', 'weekly', ['11:30'], 6), ['11:30'])
})

test('uses waking-hour defaults until an interval is re-anchored', () => {
  const med = medication({ type: 'interval', intervalHours: 3, weekdays: [], anchorAt: null, changes: [] }, wakingHourSchedule(3))
  const next = getNextDose([med], new Date('2026-08-06T21:01:00'))
  assert.equal(next.scheduledAt.getDate(), 7)
  assert.equal(next.scheduledAt.getHours(), 9)
})

test('builds separate medication schedules for today and tomorrow', () => {
  const daily = medication({ type: 'daily', intervalHours: 24, weekdays: [], anchorAt: null, changes: [] }, ['08:00'])
  const tomorrowOnly = {
    ...medication({ type: 'weekly', intervalHours: 168, weekdays: [5], anchorAt: null, changes: [] }, ['09:30']),
    id: 'tomorrow-only',
  }
  const today = getDosesForDay([daily, tomorrowOnly], new Date('2026-08-06T20:00:00'))
  const tomorrow = getDosesForDay([daily, tomorrowOnly], new Date('2026-08-07T20:00:00'))

  assert.deepEqual(today.map((dose) => dose.medication.id), ['testosterone'])
  assert.deepEqual(tomorrow.map((dose) => dose.medication.id), ['testosterone', 'tomorrow-only'])
  assert.deepEqual(tomorrow.map((dose) => dose.time), ['08:00', '09:30'])
})

test('does not schedule medication before its selected local start date', () => {
  const med = medication({ type: 'daily', startDate: '2026-08-08' }, ['09:00'])
  assert.equal(getDosesForDay([med], new Date(2026, 7, 7, 12)).length, 0)
  assert.equal(getDosesForDay([med], new Date(2026, 7, 8, 12)).length, 1)

  const anchor = localScheduleAnchor('2026-08-08', '09:00')
  assert.equal(anchor.getFullYear(), 2026)
  assert.equal(anchor.getMonth(), 7)
  assert.equal(anchor.getDate(), 8)
  assert.equal(anchor.getHours(), 9)
})

test('schedules medication every N days from its anchor date', () => {
  const med = medication({
    type: 'day-interval',
    intervalDays: 14,
    intervalHours: 12,
    weekdays: [],
    anchorAt: '2026-08-01T09:00:00',
    changes: [],
  }, ['09:00'])

  assert.equal(getDosesForDay([med], new Date('2026-08-14T12:00:00')).length, 0)
  assert.equal(getDosesForDay([med], new Date('2026-08-15T12:00:00')).length, 1)

  const next = getNextDose([med], new Date('2026-08-02T12:00:00'))
  assert.equal(next.scheduledAt.getDate(), 15)
  assert.equal(next.scheduledAt.getHours(), 9)
})

test('re-anchors every-N-days doses to the latest late taken time', () => {
  const med = medication({
    type: 'day-interval',
    intervalDays: 3,
    intervalHours: 12,
    weekdays: [],
    anchorAt: '2026-08-03T09:00:00',
    changes: [],
  }, ['09:00'])
  const scheduledAt = new Date('2026-08-03T09:00:00')
  const takenAt = new Date('2026-08-04T10:30:00')
  const updated = applyTaken(med, scheduledAt, takenAt)
  const next = getNextDose([updated], new Date('2026-08-04T10:31:00'))

  assert.deepEqual(updated.times, ['10:30'])
  assert.equal(next.scheduledAt.getDate(), 7)
  assert.equal(next.scheduledAt.getHours(), 10)
  assert.equal(next.scheduledAt.getMinutes(), 30)
  assert.equal(getActionableDoses([updated], new Date('2026-08-05T10:30:00')).length, 0)
})

test('uses the actual taken minute for an on-time every-N-days dose', () => {
  const med = medication({
    type: 'day-interval',
    intervalDays: 3,
    intervalHours: 12,
    weekdays: [],
    anchorAt: '2026-08-03T09:00:00',
    changes: [],
  }, ['09:00'])
  const updated = applyTaken(med, new Date('2026-08-03T09:00:00'), new Date('2026-08-03T09:15:00'))
  const next = getNextDose([updated], new Date('2026-08-03T09:16:00'))

  assert.deepEqual(updated.times, ['09:15'])
  assert.equal(next.scheduledAt.getDate(), 6)
  assert.equal(next.scheduledAt.getMinutes(), 15)
})

test('keeps the latest overdue every-N-days dose actionable', () => {
  const med = medication({
    type: 'day-interval',
    intervalDays: 3,
    intervalHours: 12,
    weekdays: [],
    anchorAt: '2026-08-03T09:00:00',
    changes: [],
  }, ['09:00'])

  const doses = getActionableDoses([med], new Date('2026-08-04T10:30:00'))
  assert.equal(doses.length, 1)
  assert.equal(doses[0].scheduledAt.getDate(), 3)
})

test('excludes same-day doses scheduled before medication creation', () => {
  const daily = {
    ...medication({ type: 'daily', intervalHours: 24, weekdays: [], anchorAt: null, changes: [] }, ['08:00', '18:00']),
    createdAt: '2026-08-06T14:00:00',
  }
  const hourly = {
    ...medication({ type: 'interval', intervalHours: 3, weekdays: [], anchorAt: null, changes: [] }, ['09:00', '12:00', '15:00', '18:00', '21:00']),
    id: 'hourly',
    createdAt: '2026-08-06T14:00:00',
  }

  assert.deepEqual(getDosesForDay([daily], new Date('2026-08-06T16:00:00')).map((dose) => dose.time), ['18:00'])
  assert.deepEqual(getDosesForDay([hourly], new Date('2026-08-06T16:00:00')).map((dose) => dose.time), ['15:00', '18:00', '21:00'])
})

function medication(schedule, times = ['11:00']) {
  return {
    id: 'testosterone',
    name: 'Testosterone injection',
    createdAt: '2026-08-01T08:00:00',
    times,
    history: [],
    pausePeriods: [],
    notifications: { enabled: true, advanceMinutes: 0 },
    schedule,
  }
}

function applyTaken(med, scheduledAt, takenAt, slotIndex = 0) {
  const dose = { medication: med, scheduledAt, slotIndex }
  const adjustment = adjustScheduleAfterDose(med, dose, takenAt)
  return {
    ...med,
    times: adjustment.times,
    schedule: adjustment.schedule,
    history: [{
      scheduledAt: adjustment.scheduledAt.toISOString(),
      originalScheduledAt: adjustment.originalScheduledAt?.toISOString() || null,
      takenAt: takenAt.toISOString(),
      status: 'late',
    }],
  }
}

test('re-anchors a 12-hour schedule after a dose over 30 minutes late', () => {
  const med = medication({ type: 'interval', intervalHours: 12, weekdays: [], anchorAt: '2026-08-06T11:00:00' })
  const updated = applyTaken(med, new Date('2026-08-06T11:00:00'), new Date('2026-08-06T12:00:00'))
  const next = getNextDose([updated], new Date('2026-08-06T12:01:00'))
  assert.equal(next.scheduledAt.getHours(), 0)
  assert.equal(next.scheduledAt.getDate(), 7)
})

test('moves a daily schedule to the late taken time', () => {
  const med = medication({ type: 'daily', intervalHours: 24, weekdays: [], anchorAt: null })
  const updated = applyTaken(med, new Date('2026-08-06T11:00:00'), new Date('2026-08-06T15:00:00'))
  const next = getNextDose([updated], new Date('2026-08-06T15:01:00'))
  assert.deepEqual(updated.times, ['15:00'])
  assert.equal(next.scheduledAt.getHours(), 15)
  assert.equal(next.scheduledAt.getDate(), 7)
  const previousDay = getRecentDoses([updated], new Date('2026-08-05T18:00:00'), 1)
  assert.equal(previousDay[0].scheduledAt.getHours(), 11)
})

test('keeps weekly and twice-weekly schedules at their set time', () => {
  const weekly = medication({ type: 'weekly', intervalHours: 168, weekdays: [4], anchorAt: null })
  const weeklyUpdated = applyTaken(weekly, new Date('2026-08-06T11:00:00'), new Date('2026-08-06T15:00:00'))
  const weeklyNext = getNextDose([weeklyUpdated], new Date('2026-08-06T15:01:00'))
  assert.equal(weeklyNext.scheduledAt.getDay(), 4)
  assert.equal(weeklyNext.scheduledAt.getHours(), 11)

  const twiceWeekly = medication({ type: 'weekly', intervalHours: 84, weekdays: [0, 4], anchorAt: null })
  const twiceUpdated = applyTaken(twiceWeekly, new Date('2026-08-06T11:00:00'), new Date('2026-08-06T15:00:00'))
  const twiceNext = getNextDose([twiceUpdated], new Date('2026-08-06T15:01:00'))
  assert.equal(twiceNext.scheduledAt.getDay(), 0)
  assert.equal(twiceNext.scheduledAt.getHours(), 11)
})

test('undoes a taken dose and its automatic daily shift', () => {
  const med = medication({ type: 'daily', intervalHours: 24, weekdays: [], anchorAt: null, changes: [] })
  const scheduledAt = new Date('2026-08-06T11:00:00')
  const adjustment = adjustScheduleAfterDose(med, { medication: med, scheduledAt, slotIndex: 0 }, new Date('2026-08-06T15:00:00'))
  const shifted = {
    ...med,
    times: adjustment.times,
    schedule: adjustment.schedule,
  }
  const restored = undoScheduleAfterDose(shifted, {
    scheduledAt: adjustment.scheduledAt.toISOString(),
    originalScheduledAt: scheduledAt.toISOString(),
  })
  assert.deepEqual(restored.times, ['11:00'])
  assert.equal(restored.schedule.changes.length, 0)
})

test('overrides daily, interval, and weekly times from a dose card', () => {
  const scheduledAt = new Date('2026-08-06T11:00:00')
  const daily = medication({ type: 'daily', intervalHours: 24, weekdays: [], anchorAt: null, changes: [] })
  assert.deepEqual(overrideScheduledTime(daily, { scheduledAt, slotIndex: 0 }, '13:30').times, ['13:30'])

  const interval = medication({ type: 'interval', intervalHours: 12, weekdays: [], anchorAt: scheduledAt.toISOString(), changes: [] })
  const intervalOverride = overrideScheduledTime(interval, { scheduledAt, slotIndex: 0 }, '13:30')
  assert.equal(new Date(intervalOverride.schedule.anchorAt).getHours(), 13)
  assert.equal(new Date(intervalOverride.schedule.anchorAt).getMinutes(), 30)

  const weekly = medication({ type: 'weekly', intervalHours: 168, weekdays: [4], anchorAt: null, changes: [] })
  const weeklyOverride = overrideScheduledTime(weekly, { scheduledAt, slotIndex: 0 }, '13:30')
  assert.deepEqual(weeklyOverride.times, ['13:30'])
  assert.deepEqual(weeklyOverride.schedule.weekdays, [4])
})

test('counts skipped doses as missed without changing last taken', () => {
  const scheduledAt = new Date('2026-08-06T11:00:00')
  const skipped = { scheduledAt: scheduledAt.toISOString(), skippedAt: '2026-08-06T10:00:00', status: 'skipped' }
  const taken = { scheduledAt: '2026-08-05T11:00:00', takenAt: '2026-08-05T11:05:00', status: 'on-time' }
  const med = { ...medication({ type: 'daily' }), history: [taken, skipped] }
  const stats = adherenceFor([{ scheduledAt, record: skipped }], new Date('2026-08-06T12:00:00'))

  assert.equal(stats.missed, 1)
  assert.equal(stats.taken, 0)
  assert.equal(getLastTaken(med), taken)
})

test('builds current and past calendar months with taken counts', () => {
  const med = {
    history: [
      { takenAt: '2026-07-04T09:00:00' },
      { id: 'injection-record', takenAt: '2026-08-06T09:00:00', injectionSite: 'left-lower' },
      { takenAt: '2026-08-06T15:00:00' },
      { skippedAt: '2026-08-05T09:00:00', status: 'skipped' },
    ],
  }
  const months = medicationCalendarMonths(med, new Date('2026-08-10T12:00:00'))

  assert.equal(months.length, 2)
  assert.equal(months[0].days.find(({ day }) => day === 6).count, 2)
  assert.equal(months[0].days.find(({ day }) => day === 5).missedCount, 1)
  assert.deepEqual(months[0].days.find(({ day }) => day === 6).injectionSites, ['LL'])
  assert.equal(months[0].days.find(({ day }) => day === 6).events[0].recordId, 'injection-record')
  assert.equal(months[1].days.find(({ day }) => day === 4).count, 1)
  assert.equal(INJECTION_SITE_CODES['left-upper'], 'LU')
  assert.equal(INJECTION_SITE_CODES['right-lower'], 'RL')
  assert.equal(INJECTION_SITE_CODES['right-upper'], 'RU')
})

test('overrides a taken date locally and re-anchors the latest every-days dose', () => {
  const scheduledAt = new Date(2026, 7, 6, 9, 0).toISOString()
  const originalTakenAt = new Date(2026, 7, 6, 9, 10).toISOString()
  const med = {
    history: [{
      id: 'latest-dose',
      scheduledAt,
      takenAt: originalTakenAt,
      status: 'on-time',
    }],
    schedule: { type: 'day-interval', intervalDays: 3, anchorAt: originalTakenAt },
  }
  const updated = overrideTakenDate(med, 'latest-dose', '2026-08-04', '14:25')
  const takenAt = new Date(updated.history[0].takenAt)
  const anchorAt = new Date(updated.schedule.anchorAt)

  assert.equal(takenAt.getDate(), 4)
  assert.equal(takenAt.getHours(), 14)
  assert.equal(takenAt.getMinutes(), 25)
  assert.equal(anchorAt.getDate(), 4)
  assert.equal(isFutureLocalDate('2026-08-07', new Date(2026, 7, 6, 23, 59)), true)
  assert.equal(isFutureLocalDate('2026-08-06', new Date(2026, 7, 6, 0, 1)), false)
})

test('overrides a taken dose date, time, and injection site together', () => {
  const med = {
    history: [{
      id: 'injection-dose',
      scheduledAt: new Date(2026, 7, 6, 9, 0).toISOString(),
      takenAt: new Date(2026, 7, 6, 9, 10).toISOString(),
      injectionSite: 'left-lower',
      status: 'on-time',
    }],
    times: ['09:00'],
    schedule: { type: 'weekly', weekdays: [4] },
  }
  const updated = overrideTakenDate(med, 'injection-dose', '2026-08-05', '11:30', 'right-upper')
  const takenAt = new Date(updated.history[0].takenAt)

  assert.equal(takenAt.getDate(), 5)
  assert.equal(takenAt.getHours(), 11)
  assert.equal(takenAt.getMinutes(), 30)
  assert.equal(updated.history[0].injectionSite, 'right-upper')
})

test('builds scrollable medication history ranges into past and future months', () => {
  const med = { history: [] }
  const months = medicationCalendarMonths(med, new Date(2026, 7, 10, 12), { pastMonths: 2, futureMonths: 3 })
  assert.equal(months.length, 6)
  assert.equal(months[0].label, 'June 2026')
  assert.equal(months.at(-1).label, 'November 2026')
})

test('builds multiple future push reminders without completed or disabled doses', () => {
  const enabled = medication({ type: 'daily', intervalHours: 24, weekdays: [], anchorAt: null, changes: [] }, ['11:00'])
  enabled.notifications = { enabled: true, advanceMinutes: [0, 15] }
  enabled.trackInjectionSite = true
  const disabled = { ...medication({ type: 'daily' }, ['12:00']), id: 'disabled', notifications: { enabled: false } }
  const reminders = getUpcomingReminders([enabled, disabled], new Date('2026-08-06T10:00:00'), 0)

  assert.equal(reminders.length, 2)
  assert.deepEqual(reminders.map(({ advanceMinutes }) => advanceMinutes), [15, 0])
  assert.equal(new Date(reminders[0].scheduledAt) - new Date(reminders[0].alertAt), 15 * 60 * 1000)
  assert.match(reminders[0].body, /15 minutes/)
  assert.equal(reminders[0].icon, '/syringe-icon.svg')
  assert.notEqual(reminders[0].tag, reminders[1].tag)
  assert.deepEqual(reminderOffsets({ advanceMinutes: [15, 0, 15] }), [0, 15])
})
