import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addTakenHistoryRecord,
  adjustScheduleAfterDose,
  adherenceFor,
  anchorMedicationSchedule,
  doseScheduleAdjustmentDecision,
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
  isOnTime,
  localScheduleAnchor,
  medicationCalendarMonths,
  overrideScheduledTime,
  overrideTakenDate,
  parsePastedTime,
  reminderOffsets,
  repairDynamicSchedule,
  removeTakenHistoryRecord,
  scheduleTimesForDisplay,
  setRecurrenceAnchor,
  takenRecordStatus,
  timePartInput,
  timesForScheduleType,
  toTwelveHourTime,
  toTwentyFourHourTime,
  undoScheduleAfterDose,
  updateDoseTime,
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

test('marks doses green only within ten minutes before or after their schedule', () => {
  const scheduledAt = new Date('2026-08-06T12:00:00')
  assert.equal(isOnTime(scheduledAt, new Date('2026-08-06T11:50:00')), true)
  assert.equal(isOnTime(scheduledAt, new Date('2026-08-06T12:10:00')), true)
  assert.equal(isOnTime(scheduledAt, new Date('2026-08-06T11:49:59')), false)
  assert.equal(isOnTime(scheduledAt, new Date('2026-08-06T12:10:01')), false)
  assert.equal(takenRecordStatus({
    scheduledAt: '2026-08-06T12:00:00',
    takenAt: '2026-08-06T12:15:00',
    status: 'on-time',
  }), 'late')
})

test('formats next-dose countdowns in days after 24 hours', () => {
  const now = new Date('2026-08-06T09:00:00')
  assert.equal(formatRelative(new Date('2026-08-07T09:00:00'), now), '1 day')
  assert.equal(formatRelative(new Date('2026-08-08T14:00:00'), now), '2 days 5 hours')
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

test('uses one weekly occurrence when legacy data contains multiple times', () => {
  const weekly = medication({
    type: 'weekly',
    intervalHours: 168,
    weekdays: [4],
    anchorAt: null,
    changes: [],
  }, ['09:00', '11:00'])

  const doses = getDosesForDay([weekly], new Date('2026-08-06T12:00:00'))
  assert.equal(doses.length, 1)
  assert.equal(doses[0].time, '09:00')
})

test('uses one owner-timezone weekly occurrence across shared profiles', () => {
  const weekly = {
    ...medication({
      type: 'weekly',
      intervalHours: 168,
      weekdays: [1],
      anchorAt: null,
      changes: [],
    }, ['20:00', '21:00']),
    resourceAccess: {
      role: 'viewer',
      canViewHistory: true,
      canViewSchedule: true,
      ownerTimezone: 'America/New_York',
    },
  }

  const reminders = getUpcomingReminders(
    [weekly],
    new Date('2026-08-10T00:00:00.000Z'),
    2,
  )
  assert.equal(reminders.length, 1)
  assert.equal(reminders[0].scheduledAt, '2026-08-11T00:00:00.000Z')
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

test('anchors every-N-days dates to the latest taken date without changing clock time', () => {
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

  assert.deepEqual(updated.times, ['09:00'])
  assert.equal(next.scheduledAt.getDate(), 7)
  assert.equal(next.scheduledAt.getHours(), 9)
  assert.equal(next.scheduledAt.getMinutes(), 0)
  assert.equal(getActionableDoses([updated], new Date('2026-08-05T10:30:00')).length, 0)
})

test('keeps the configured minute for an on-time every-N-days dose', () => {
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

  assert.deepEqual(updated.times, ['09:00'])
  assert.equal(next.scheduledAt.getDate(), 6)
  assert.equal(next.scheduledAt.getMinutes(), 0)
})

test('converts a shared every-N-days schedule from the owner timezone and does not duplicate a taken dose', () => {
  const med = {
    ...medication({
      type: 'day-interval',
      intervalDays: 3,
      intervalHours: 72,
      weekdays: [],
      anchorAt: '2026-08-09T04:00:00.000Z',
      changes: [],
    }, ['20:00', '21:00']),
    createdAt: '2026-08-01T00:00:00.000Z',
    resourceAccess: {
      role: 'viewer',
      canViewHistory: true,
      canViewSchedule: true,
      ownerTimezone: 'America/New_York',
    },
  }

  const due = getNextDose([med], new Date('2026-08-09T22:00:00.000Z'))
  assert.equal(due.scheduledAt.toISOString(), '2026-08-10T00:00:00.000Z')
  assert.deepEqual(
    scheduleTimesForDisplay(
      med,
      new Date('2026-08-09T22:00:00.000Z'),
      'America/Los_Angeles',
    ),
    ['17:00', '18:00'],
  )

  const taken = {
    ...med,
    history: [{
      id: 'eastern-dose',
      scheduledAt: due.scheduledAt.toISOString(),
      takenAt: due.scheduledAt.toISOString(),
      status: 'on-time',
    }],
  }
  const today = getActionableDoses([taken], new Date('2026-08-10T00:01:00.000Z'))
    .filter((dose) => dose.medication.id === taken.id)
  assert.equal(today.length, 1)
  assert.equal(today[0].record.id, 'eastern-dose')

  const next = getNextDose([taken], new Date('2026-08-10T00:01:00.000Z'))
  assert.equal(next.scheduledAt.toISOString(), '2026-08-13T00:00:00.000Z')
})

test('keeps weekly anchors isolated between shared owners in EST and PST', () => {
  const schedule = {
    type: 'weekly',
    intervalHours: 168,
    weekdays: [1],
    anchorAt: null,
    changes: [],
  }
  const western = {
    ...medication(schedule, ['11:00']),
    id: 'western-weekly',
    name: 'Testosterone',
    resourceAccess: {
      role: 'viewer',
      ownerUserId: 'western-owner',
      ownerTimezone: 'America/Los_Angeles',
      canViewHistory: true,
      canViewSchedule: true,
    },
  }
  const eastern = {
    ...medication(schedule, ['08:00']),
    id: 'eastern-weekly',
    name: 'Testosterone',
    resourceAccess: {
      role: 'viewer',
      ownerUserId: 'eastern-owner',
      ownerTimezone: 'America/New_York',
      canViewHistory: true,
      canViewSchedule: true,
    },
    history: [{
      id: 'eastern-weekly-dose',
      scheduledAt: '2026-08-17T12:00:00.000Z',
      takenAt: '2026-08-17T12:00:00.000Z',
      status: 'on-time',
    }],
  }

  const doses = getDosesForDay(
    [western, eastern],
    new Date('2026-08-17T19:00:00.000Z'),
  )

  assert.equal(doses.length, 2)
  assert.ok(doses.some(({ medication, scheduledAt }) =>
    medication.id === western.id &&
    scheduledAt.toISOString() === '2026-08-17T18:00:00.000Z'))
  assert.ok(doses.some(({ record }) => record?.id === 'eastern-weekly-dose'))
})

test('keeps every-N-days anchors isolated between shared owners in PST and EST', () => {
  const schedule = {
    type: 'day-interval',
    intervalDays: 3,
    intervalHours: 72,
    weekdays: [],
    anchorAt: '2026-08-15T18:00:00.000Z',
    changes: [],
  }
  const western = {
    ...medication(schedule, ['11:00']),
    id: 'western-every-days',
    name: 'Estradiol',
    resourceAccess: {
      role: 'viewer',
      ownerUserId: 'western-owner',
      ownerTimezone: 'America/Los_Angeles',
      canViewHistory: true,
      canViewSchedule: true,
    },
  }
  const eastern = {
    ...medication(schedule, ['14:00']),
    id: 'eastern-every-days',
    name: 'Estradiol',
    resourceAccess: {
      role: 'viewer',
      ownerUserId: 'eastern-owner',
      ownerTimezone: 'America/New_York',
      canViewHistory: true,
      canViewSchedule: true,
    },
    history: [{
      id: 'eastern-every-days-dose',
      scheduledAt: '2026-08-17T18:00:00.000Z',
      takenAt: '2026-08-17T18:00:00.000Z',
      status: 'on-time',
    }],
  }

  const westernNext = getDosesForDay(
    [western, eastern],
    new Date('2026-08-18T19:00:00.000Z'),
  ).filter(({ medication }) => medication.id === western.id)

  assert.equal(westernNext.length, 1)
  assert.equal(westernNext[0].scheduledAt.toISOString(), '2026-08-18T18:00:00.000Z')
})

test('canonical schedule timezone overrides a stale shared owner timezone', () => {
  const weekly = {
    ...medication({
      type: 'weekly',
      timezone: 'America/New_York',
      intervalHours: 168,
      weekdays: [1],
      anchorAt: null,
      changes: [],
    }, ['17:36']),
    id: 'repaired-testosterone',
    name: 'Testosterone Cypionate',
    recurrenceAnchor: {
      at: '2026-08-17T21:36:00.000Z',
      scheduledAt: '2026-08-18T20:00:00.000Z',
      updatedAt: '2026-08-17T22:50:00.000Z',
      source: 'retroactive-repair',
      consumed: true,
      slotIndex: 0,
    },
    resourceAccess: {
      role: 'editor',
      ownerUserId: 'shared-owner',
      ownerTimezone: 'UTC',
      canViewHistory: true,
      canViewSchedule: true,
    },
  }

  const next = getNextDose([weekly], new Date('2026-08-17T22:00:00.000Z'))

  assert.equal(next.scheduledAt.toISOString(), '2026-08-24T21:36:00.000Z')
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
  assert.equal(doses[0].overdue, true)
  assert.equal(doses[0].scheduledAt.getDate(), 3)
})

test('reconciles a legacy weekly taken record with its same-day occurrence', () => {
  const takenAt = new Date('2026-08-10T17:58:00')
  const med = {
    ...medication({
      type: 'weekly',
      intervalHours: 168,
      weekdays: [1],
      anchorAt: null,
      changes: [],
    }, ['13:00']),
    history: [{
      id: 'legacy-weekly',
      scheduledAt: takenAt.toISOString(),
      takenAt: takenAt.toISOString(),
      status: 'late',
    }],
  }

  const doses = getDosesForDay([med], new Date('2026-08-10T20:00:00'))
  assert.equal(doses.length, 1)
  assert.equal(doses[0].scheduledAt.toISOString(), takenAt.toISOString())
  assert.equal(doses[0].record.id, 'legacy-weekly')
})

test('reconciles a late every-N-days record and anchors the next date', () => {
  const takenAt = new Date('2026-08-10T18:01:00')
  const med = {
    ...medication({
      type: 'day-interval',
      intervalDays: 3,
      intervalHours: 72,
      weekdays: [],
      anchorAt: '2026-08-08T16:00:00',
      changes: [],
    }, ['16:00']),
    history: [{
      id: 'legacy-every-days',
      scheduledAt: takenAt.toISOString(),
      takenAt: takenAt.toISOString(),
      status: 'late',
    }],
  }

  const today = getActionableDoses([med], new Date('2026-08-10T20:00:00'))
  const tomorrow = getDosesForDay([med], new Date('2026-08-11T12:00:00'))
  const next = getNextDose([med], new Date('2026-08-10T20:00:00'))

  assert.equal(today.length, 1)
  assert.equal(today[0].record.id, 'legacy-every-days')
  assert.equal(today[0].overdue, undefined)
  assert.equal(tomorrow.length, 0)
  assert.equal(next.scheduledAt.getDate(), 13)
  assert.equal(next.scheduledAt.getHours(), 16)
})

test('enforces every-N-days spacing across duplicate shared resource copies', () => {
  const takenAt = new Date('2026-08-10T18:01:00')
  const schedule = {
    type: 'day-interval',
    intervalDays: 3,
    intervalHours: 72,
    weekdays: [],
    anchorAt: '2026-08-08T16:00:00',
    changes: [],
  }
  const access = {
    role: 'viewer',
    ownerUserId: 'shared-owner',
    ownerTimezone: 'America/Los_Angeles',
    canViewHistory: true,
    canViewSchedule: true,
  }
  const scheduledCopy = {
    ...medication(schedule, ['16:00']),
    id: 'estradiol-schedule-copy',
    name: 'Estradiol Vaginal',
    dose: '10 mcg',
    resourceAccess: access,
  }
  const historyCopy = {
    ...medication(schedule, ['16:00']),
    id: 'estradiol-history-copy',
    name: 'Estradiol Vaginal',
    dose: '10 mcg',
    resourceAccess: access,
    history: [{
      id: 'shared-taken-dose',
      scheduledAt: takenAt.toISOString(),
      takenAt: takenAt.toISOString(),
      status: 'late',
    }],
  }
  const medications = [scheduledCopy, historyCopy]

  const today = getActionableDoses(medications, new Date('2026-08-10T20:00:00'))
  const tomorrow = getDosesForDay(medications, new Date('2026-08-11T12:00:00'))
  const next = getNextDose(medications, new Date('2026-08-10T20:00:00'))

  assert.equal(today.length, 1)
  assert.equal(today[0].record.id, 'shared-taken-dose')
  assert.equal(tomorrow.length, 0)
  assert.equal(next.scheduledAt.getDate(), 13)
  assert.equal(next.scheduledAt.getHours(), 16)
})

test('keeps an overdue every-N-days occurrence distinct from the next fixed dose', () => {
  const med = medication({
    type: 'day-interval',
    intervalDays: 3,
    intervalHours: 72,
    weekdays: [],
    anchorAt: '2026-08-06T09:00:00',
    changes: [],
  }, ['09:00'])

  const overdue = getActionableDoses([med], new Date('2026-08-08T12:00:00'))
  const next = getNextDose([med], new Date('2026-08-08T12:00:00'))

  assert.equal(overdue.length, 1)
  assert.equal(overdue[0].overdue, true)
  assert.equal(overdue[0].scheduledAt.getDate(), 6)
  assert.equal(next.scheduledAt.getDate(), 9)
  assert.equal((next.scheduledAt - overdue[0].scheduledAt) / (24 * 60 * 60 * 1000), 3)
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

test('re-anchors a 12-hour schedule to the exact taken time', () => {
  const med = medication({ type: 'interval', intervalHours: 12, weekdays: [], anchorAt: '2026-08-06T11:00:00' })
  const updated = applyTaken(med, new Date('2026-08-06T11:00:00'), new Date('2026-08-06T09:16:00'))
  const next = getNextDose([updated], new Date('2026-08-06T09:17:00'))
  assert.equal(next.scheduledAt.getHours(), 21)
  assert.equal(next.scheduledAt.getMinutes(), 16)
  assert.equal(next.scheduledAt.getDate(), 6)
})

test('anchors hourly recurrence to latest history even when its stored anchor is stale', () => {
  const med = {
    ...medication({
      type: 'interval',
      intervalHours: 3,
      weekdays: [],
      anchorAt: '2026-08-10T09:00:00',
      changes: [],
    }, ['09:00', '12:00', '15:00']),
    history: [{
      id: 'latest-hourly',
      scheduledAt: '2026-08-10T09:00:00',
      takenAt: '2026-08-10T10:17:00',
      status: 'late',
    }],
  }
  const next = getNextDose([med], new Date('2026-08-10T10:18:00'))

  assert.equal(next.scheduledAt.getHours(), 13)
  assert.equal(next.scheduledAt.getMinutes(), 17)
})

test('minute-normalizes hourly anchors without duplicating taken dose rows', () => {
  const medications = ['Gabapentin', 'Carprofen', 'Animax Ointment'].map((name, index) => {
    const minute = 24 + Math.min(index, 1)
    const scheduledAt = new Date(2026, 7, 10, 10, minute)
    const takenAt = new Date(2026, 7, 10, 10, minute, 37 + index)
    return {
      ...medication({
        type: 'interval',
        intervalHours: 12,
        weekdays: [],
        anchorAt: new Date(2026, 7, 10, 10).toISOString(),
        changes: [],
      }, ['10:00', '22:00']),
      id: `twelve-hour-${index}`,
      name,
      history: [{
        id: `morning-${index}`,
        scheduledAt: scheduledAt.toISOString(),
        takenAt: takenAt.toISOString(),
        originalScheduledAt: new Date(2026, 7, 10, 10).toISOString(),
        status: 'late',
      }],
    }
  })

  const doses = getDosesForDay(medications, new Date('2026-08-10T12:00:00'))
  assert.equal(doses.length, 6)
  for (const medication of medications) {
    const medicationDoses = doses.filter((dose) => dose.medication.id === medication.id)
    assert.equal(medicationDoses.length, 2)
    assert.equal(medicationDoses.filter((dose) => dose.record?.takenAt).length, 1)
    assert.equal(medicationDoses.filter((dose) => !dose.record).length, 1)
  }
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

test('moves a dose-relative occurrence without retaining a duplicate at its old time', () => {
  const med = medication(
    { type: 'daily', intervalHours: 24, weekdays: [], anchorAt: null, changes: [] },
    ['23:00'],
  )
  const updated = applyTaken(
    med,
    new Date('2026-08-06T23:00:00'),
    new Date('2026-08-07T01:00:00'),
  )
  const doses = getRecentDoses([updated], new Date('2026-08-07T12:00:00'), 2)

  assert.equal(doses.length, 1)
  assert.equal(doses[0].scheduledAt.getDate(), 7)
  assert.equal(doses[0].scheduledAt.getHours(), 1)
  assert.equal(doses[0].record.takenAt, new Date('2026-08-07T01:00:00').toISOString())
})

test('shifts every future daily time by the exact taken-time difference', () => {
  const med = medication(
    { type: 'daily', intervalHours: 12, weekdays: [], anchorAt: null, changes: [] },
    ['11:00', '23:00'],
  )
  const updated = applyTaken(med, new Date('2026-08-06T11:00:00'), new Date('2026-08-06T09:16:00'))
  const next = getNextDose([updated], new Date('2026-08-06T09:17:00'))

  assert.deepEqual(updated.times, ['09:16', '21:16'])
  assert.equal(next.scheduledAt.getHours(), 21)
  assert.equal(next.scheduledAt.getMinutes(), 16)
})

test('repairs a stored hourly schedule from its latest actual taken time', () => {
  const med = {
    ...medication(
      { type: 'interval', intervalHours: 12, weekdays: [], anchorAt: '2026-08-06T11:16:00', changes: [] },
      ['11:16', '23:16'],
    ),
    history: [{
      id: 'legacy-dose',
      scheduledAt: '2026-08-06T11:16:00',
      takenAt: '2026-08-06T10:31:00',
      status: 'late',
    }],
  }
  const repaired = repairDynamicSchedule(med)
  const repairedAgain = repairDynamicSchedule(repaired)
  const next = getNextDose([repaired], new Date('2026-08-06T10:32:00'))

  assert.equal(next.scheduledAt.getHours(), 22)
  assert.equal(next.scheduledAt.getMinutes(), 31)
  assert.equal(repaired.history[0].originalScheduledAt, new Date('2026-08-06T11:16:00').toISOString())
  assert.deepEqual(repairedAgain, repaired)
})

test('repairs stored daily times without shifting them again on reload', () => {
  const med = {
    ...medication(
      { type: 'daily', intervalHours: 12, weekdays: [], anchorAt: null, changes: [] },
      ['11:16', '23:16'],
    ),
    history: [{
      id: 'legacy-dose',
      scheduledAt: '2026-08-06T11:16:00',
      takenAt: '2026-08-06T10:31:00',
      status: 'late',
    }],
  }
  const repaired = repairDynamicSchedule(med)

  assert.deepEqual(repaired.times, ['10:31', '22:31'])
  assert.deepEqual(repairDynamicSchedule(repaired), repaired)
})

test('edits the exact taken interval record instead of the upcoming dose', () => {
  const med = {
    ...medication(
      { type: 'interval', intervalHours: 12, weekdays: [], anchorAt: '2026-08-08T10:15:00', changes: [] },
      ['10:15', '22:15'],
    ),
    history: [{
      id: 'taken-dose',
      scheduledAt: new Date('2026-08-08T10:15:00').toISOString(),
      takenAt: new Date('2026-08-08T10:31:00').toISOString(),
      status: 'late',
    }],
  }
  const takenDose = getDosesForDay([med], new Date('2026-08-08T12:00:00'))
    .find((dose) => dose.record?.id === 'taken-dose')
  const updated = updateDoseTime(med, takenDose, '10:45')
  const doses = getDosesForDay([updated], new Date('2026-08-08T12:00:00'))
  const editedTaken = doses.find((dose) => dose.record?.id === 'taken-dose')
  const upcoming = doses.find((dose) => !dose.record)

  assert.equal(new Date(editedTaken.record.takenAt).getHours(), 10)
  assert.equal(new Date(editedTaken.record.takenAt).getMinutes(), 45)
  assert.equal(editedTaken.scheduledAt.getMinutes(), 45)
  assert.equal(upcoming.scheduledAt.getHours(), 22)
  assert.equal(upcoming.scheduledAt.getMinutes(), 45)
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

test('anchors weekly date gaps to the latest taken owner date', () => {
  const weekly = medication({
    type: 'weekly',
    intervalHours: 168,
    weekdays: [1],
    anchorAt: null,
    changes: [],
  }, ['13:00'])
  const updated = applyTaken(
    weekly,
    new Date('2026-08-10T13:00:00'),
    new Date('2026-08-11T18:00:00'),
  )
  const next = getNextDose([updated], new Date('2026-08-11T18:01:00'))

  assert.equal(next.scheduledAt.getDay(), 2)
  assert.equal(next.scheduledAt.getDate(), 18)
  assert.equal(next.scheduledAt.getHours(), 13)
})

test('preserves weekly gap pattern after a late twice-weekly dose', () => {
  const twiceWeekly = medication({
    type: 'weekly',
    intervalHours: 84,
    weekdays: [0, 4],
    anchorAt: null,
    changes: [],
  }, ['13:00'])
  const updated = applyTaken(
    twiceWeekly,
    new Date('2026-08-13T13:00:00'),
    new Date('2026-08-14T18:00:00'),
  )
  const next = getNextDose([updated], new Date('2026-08-14T18:01:00'))

  assert.equal(next.scheduledAt.getDay(), 1)
  assert.equal(next.scheduledAt.getDate(), 17)
  assert.equal(next.scheduledAt.getHours(), 13)
})

test('generates weekly recurrence in owner timezone before viewer conversion', () => {
  const weekly = {
    ...medication({
      type: 'weekly',
      intervalHours: 168,
      weekdays: [1],
      anchorAt: null,
      changes: [],
    }, ['13:00']),
    history: [{
      id: 'owner-weekly',
      scheduledAt: '2026-08-10T17:00:00.000Z',
      takenAt: '2026-08-11T05:00:00.000Z',
      status: 'late',
    }],
    resourceAccess: {
      role: 'viewer',
      ownerUserId: 'eastern-owner',
      ownerTimezone: 'America/New_York',
      canViewHistory: true,
      canViewSchedule: true,
    },
  }
  const next = getNextDose([weekly], new Date('2026-08-11T05:01:00.000Z'))

  assert.equal(next.scheduledAt.toISOString(), '2026-08-18T17:00:00.000Z')
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

test('daily doses within one hour keep the scheduled recurrence anchor', () => {
  const med = medication({ type: 'daily', intervalHours: 24, weekdays: [], anchorAt: null, changes: [] })
  const scheduledAt = new Date('2026-08-06T11:00:00')

  assert.deepEqual(
    doseScheduleAdjustmentDecision(
      med,
      { scheduledAt },
      new Date('2026-08-06T12:00:00'),
    ),
    { adjustSchedule: false, prompt: false },
  )
  const adjustment = adjustScheduleAfterDose(
    med,
    { medication: med, scheduledAt, slotIndex: 0 },
    new Date('2026-08-06T11:45:00'),
    { adjustSchedule: false },
  )
  assert.equal(adjustment.scheduledAt.toISOString(), scheduledAt.toISOString())
  assert.equal(adjustment.originalScheduledAt, null)
  assert.deepEqual(adjustment.times, ['11:00'])
})

test('daily doses over one hour ask unless the medication remembers yes or no', () => {
  const med = medication({ type: 'daily', intervalHours: 24, weekdays: [], anchorAt: null, changes: [] })
  const dose = { scheduledAt: new Date('2026-08-06T11:00:00') }
  const takenAt = new Date('2026-08-06T12:01:00')

  assert.deepEqual(
    doseScheduleAdjustmentDecision(med, dose, takenAt),
    { adjustSchedule: false, prompt: true },
  )
  assert.deepEqual(
    doseScheduleAdjustmentDecision({ ...med, scheduleAdjustmentPreference: 'yes' }, dose, takenAt),
    { adjustSchedule: true, prompt: false },
  )
  assert.deepEqual(
    doseScheduleAdjustmentDecision({ ...med, scheduleAdjustmentPreference: 'no' }, dose, takenAt),
    { adjustSchedule: false, prompt: false },
  )
})

test('overrides daily, interval, and weekly times from a dose card', () => {
  const scheduledAt = new Date('2026-08-06T11:00:00')
  const daily = medication({ type: 'daily', intervalHours: 24, weekdays: [], anchorAt: null, changes: [] })
  assert.deepEqual(overrideScheduledTime(daily, { scheduledAt, slotIndex: 0 }, '13:30').times, ['13:30'])

  const interval = medication({ type: 'interval', intervalHours: 12, weekdays: [], anchorAt: scheduledAt.toISOString(), changes: [] })
  const intervalOverride = overrideScheduledTime(interval, { scheduledAt, slotIndex: 0 }, '13:30')
  assert.equal(new Date(intervalOverride.schedule.anchorAt).getHours(), 13)
  assert.equal(new Date(intervalOverride.schedule.anchorAt).getMinutes(), 30)
  assert.deepEqual(intervalOverride.times, ['13:30'])

  const weekly = medication({ type: 'weekly', intervalHours: 168, weekdays: [4], anchorAt: null, changes: [] })
  const weeklyOverride = overrideScheduledTime(weekly, { scheduledAt, slotIndex: 0 }, '13:30')
  assert.deepEqual(weeklyOverride.times, ['13:30'])
  assert.deepEqual(weeklyOverride.schedule.weekdays, [4])
})

test('saves a taken-time edit into history and recalculates later daily doses', () => {
  const scheduledAt = new Date('2026-08-06T09:00:00')
  const takenAt = new Date('2026-08-06T09:05:00')
  const med = {
    ...medication({ type: 'daily', intervalHours: 24, weekdays: [], anchorAt: null, changes: [] }, ['09:00']),
    history: [{
      id: 'taken-dose',
      scheduledAt: scheduledAt.toISOString(),
      takenAt: takenAt.toISOString(),
      status: 'on-time',
    }],
  }
  const dose = { medication: med, scheduledAt, slotIndex: 0, record: med.history[0] }
  const updated = updateDoseTime(med, dose, '10:15')
  const next = getNextDose([updated], new Date('2026-08-06T10:16:00'))

  assert.equal(new Date(updated.history[0].takenAt).getHours(), 10)
  assert.equal(new Date(updated.history[0].takenAt).getMinutes(), 15)
  assert.equal(updated.history[0].originalScheduledAt, scheduledAt.toISOString())
  assert.deepEqual(updated.times, ['10:15'])
  const calendarEvent = medicationCalendarMonths(updated, new Date('2026-08-06T12:00:00'))[0]
    .days.find(({ day }) => day === 6).events[0]
  assert.equal(new Date(calendarEvent.time).getHours(), 10)
  assert.equal(new Date(calendarEvent.time).getMinutes(), 15)
  assert.equal(next.scheduledAt.getDate(), 7)
  assert.equal(next.scheduledAt.getHours(), 10)
  assert.equal(next.scheduledAt.getMinutes(), 15)
})

test('adds a past dose from today to history, schedule, and future recurrence', () => {
  const med = {
    ...medication({ type: 'interval', intervalHours: 6, weekdays: [], anchorAt: '2026-08-07T09:00:00', changes: [] }, ['09:00', '15:00', '21:00']),
    inventory: { remaining: 5, unit: 'doses' },
  }
  const updated = addTakenHistoryRecord(med, 'calendar-dose', '2026-08-07', '13:30')
  const today = getActionableDoses([updated], new Date('2026-08-07T17:00:00'))
  const recorded = today.find((dose) => dose.record?.id === 'calendar-dose')
  const next = getNextDose([updated], new Date('2026-08-07T13:31:00'))

  assert.ok(recorded)
  assert.equal(recorded.record.status, 'on-time')
  assert.equal(new Date(recorded.record.takenAt).getHours(), 13)
  assert.equal(updated.inventory.remaining, 4)
  assert.equal(next.scheduledAt.getHours(), 19)
  assert.equal(next.scheduledAt.getMinutes(), 30)
})

test('anchors every-days dates and time to the latest manual dose', () => {
  const med = medication({
    type: 'day-interval',
    intervalDays: 3,
    intervalHours: 24,
    weekdays: [],
    anchorAt: '2026-08-06T09:00:00',
    changes: [],
  }, ['09:00'])
  const updated = addTakenHistoryRecord(med, 'calendar-dose', '2026-08-07', '08:20')
  const next = getNextDose([updated], new Date('2026-08-07T08:21:00'))

  assert.equal(new Date(updated.schedule.anchorAt).getDate(), 6)
  assert.equal(new Date(updated.schedule.anchorAt).getMinutes(), 0)
  assert.equal(next.scheduledAt.getDate(), 10)
  assert.equal(next.scheduledAt.getHours(), 8)
  assert.equal(next.scheduledAt.getMinutes(), 20)
})

test('anchors weekly dates and time to the latest manual dose', () => {
  const med = medication({
    type: 'weekly',
    intervalHours: 168,
    weekdays: [4],
    anchorAt: null,
    changes: [],
  }, ['09:00'])
  const updated = addTakenHistoryRecord(med, 'calendar-dose', '2026-08-07', '14:20')
  const next = getNextDose([updated], new Date('2026-08-07T14:21:00'))

  assert.deepEqual(updated.times, ['14:20'])
  assert.equal(next.scheduledAt.getDay(), 5)
  assert.equal(next.scheduledAt.getDate(), 14)
  assert.equal(next.scheduledAt.getHours(), 14)
  assert.equal(next.scheduledAt.getMinutes(), 20)
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

test('overrides a taken date without re-anchoring the every-days schedule', () => {
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
  assert.equal(anchorAt.getDate(), 6)
  assert.equal(anchorAt.getHours(), 9)
  assert.equal(anchorAt.getMinutes(), 10)
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

test('editing an older dose becomes the latest manual recurrence anchor', () => {
  const med = {
    ...medication({
      type: 'day-interval',
      intervalDays: 3,
      intervalHours: 24,
      weekdays: [],
      anchorAt: '2026-08-07T08:00:00',
      changes: [],
    }, ['08:00']),
    history: [{
      id: 'older-dose',
      scheduledAt: '2026-08-04T08:00:00',
      takenAt: '2026-08-04T08:05:00',
      status: 'on-time',
    }, {
      id: 'latest-dose',
      scheduledAt: '2026-08-07T08:00:00',
      takenAt: '2026-08-07T08:02:00',
      status: 'on-time',
    }],
  }
  const updated = overrideTakenDate(med, 'older-dose', '2026-08-04', '07:30')

  assert.equal(updated.recurrenceAnchor.source, 'taken-edit')
  assert.equal(updated.recurrenceAnchor.consumed, true)
  assert.equal(new Date(updated.recurrenceAnchor.at).getHours(), 7)
  assert.equal(new Date(updated.recurrenceAnchor.at).getMinutes(), 30)
  assert.equal(new Date(updated.history[0].takenAt).getMinutes(), 30)
})

test('adding older history becomes the latest manual recurrence anchor', () => {
  const med = {
    ...medication({
      type: 'interval',
      intervalHours: 12,
      weekdays: [],
      anchorAt: '2026-08-07T08:00:00',
      changes: [],
    }, ['08:00', '20:00']),
    history: [{
      id: 'latest-dose',
      scheduledAt: '2026-08-07T08:00:00',
      takenAt: '2026-08-07T08:02:00',
      status: 'on-time',
    }],
  }
  const updated = addTakenHistoryRecord(med, 'older-dose', '2026-08-05', '10:00')

  assert.equal(updated.recurrenceAnchor.source, 'manual-taken')
  assert.equal(updated.recurrenceAnchor.consumed, true)
  assert.equal(new Date(updated.recurrenceAnchor.at).getDate(), 5)
  assert.equal(new Date(updated.recurrenceAnchor.at).getHours(), 10)
})

test('the latest manual action replaces the interval recurrence anchor', () => {
  const takenAt = new Date('2026-08-17T12:00:00.000Z')
  const taken = setRecurrenceAnchor({
    ...medication({
      type: 'interval',
      intervalHours: 12,
      weekdays: [],
      anchorAt: takenAt.toISOString(),
      changes: [],
    }, ['12:00', '00:00']),
    history: [{
      id: 'carprofen-noon',
      scheduledAt: takenAt.toISOString(),
      takenAt: takenAt.toISOString(),
      status: 'on-time',
    }],
    resourceAccess: {
      role: 'owner',
      ownerUserId: 'carprofen-owner',
      ownerTimezone: 'UTC',
    },
  }, takenAt, 'taken', {
    consumed: true,
    scheduledAt: takenAt,
    updatedAt: new Date('2026-08-17T12:01:00.000Z'),
  })

  const edited = anchorMedicationSchedule({
    ...taken,
    times: ['23:00'],
  }, new Date('2026-08-17T14:00:00.000Z'))
  const next = getNextDose([edited], new Date('2026-08-17T14:00:00.000Z'))

  assert.equal(edited.recurrenceAnchor.source, 'schedule-edit')
  assert.equal(edited.recurrenceAnchor.consumed, false)
  assert.equal(next.scheduledAt.toISOString(), '2026-08-17T23:00:00.000Z')
})

test('adds and removes manually recorded doses while updating inventory and last taken', () => {
  const med = {
    ...medication({ type: 'daily' }),
    inventory: { remaining: 8, unit: 'doses' },
    history: [{
      id: 'older-dose',
      scheduledAt: '2026-08-04T09:00:00',
      takenAt: '2026-08-04T09:05:00',
      status: 'on-time',
    }],
  }
  const added = addTakenHistoryRecord(med, 'manual-dose', '2026-08-05', '10:30', 'right-lower')

  assert.equal(added.inventory.remaining, 7)
  assert.equal(getLastTaken(added).id, 'manual-dose')
  assert.equal(added.history.at(-1).injectionSite, 'right-lower')

  const removed = removeTakenHistoryRecord(added, 'manual-dose')
  assert.equal(removed.inventory.remaining, 8)
  assert.equal(getLastTaken(removed).id, 'older-dose')
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

test('creates a unique notification for every scheduled dose occurrence', () => {
  const medications = ['Gabapentin', 'Carprofen', 'Animax Ointment'].map((name, index) => ({
    ...medication({
      type: 'interval',
      intervalHours: 12,
      weekdays: [],
      anchorAt: new Date(2026, 7, 10, 10, 24 + Math.min(index, 1)).toISOString(),
      changes: [],
    }, ['10:24', '22:24']),
    id: `notification-medication-${index}`,
    name,
  }))
  const reminders = getUpcomingReminders(
    medications,
    new Date(2026, 7, 10, 9),
    0,
  )

  assert.equal(reminders.length, 6)
  assert.equal(new Set(reminders.map(({ id }) => id)).size, 6)
  assert.equal(new Set(reminders.map(({ tag }) => tag)).size, 6)
  assert.ok(reminders.every(({ tag, scheduledAt }) => tag.includes(scheduledAt)))
})
