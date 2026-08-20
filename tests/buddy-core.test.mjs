import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buddyPeriodKey,
  buddyPeriodKeyForDate,
  computeGroupStreak,
  localStreakDate,
  membershipDates,
  occurrenceCompletion,
  privateCompletionEntries,
} from '../server/buddy-core.js'

test('member-local daily periods retain the existing 12:30 AM grace minute', () => {
  const instant = new Date('2026-08-07T07:30:00.000Z')
  assert.equal(localStreakDate(instant, 'America/Los_Angeles'), '2026-08-06')
  assert.equal(buddyPeriodKey({}, instant, 'America/Los_Angeles'), 'day:2026-08-06')
  assert.equal(
    buddyPeriodKey({}, new Date('2026-08-07T07:31:00.000Z'), 'America/Los_Angeles'),
    'day:2026-08-07',
  )
})

test('new streaks are not backdated into the prior grace day', () => {
  const instant = new Date('2026-08-10T00:20:00.000Z')
  assert.equal(buddyPeriodKey({}, instant, 'UTC'), 'day:2026-08-09')
  assert.equal(buddyPeriodKey({
    createdAt: instant.toISOString(),
  }, instant, 'UTC'), 'day:2026-08-10')
})

test('weekly period keys start Sunday and honor grace in an IANA timezone', () => {
  const definition = { schedule: { mode: 'weekly', timesPerWeek: 3 } }
  assert.equal(
    buddyPeriodKey(
      definition,
      new Date('2026-08-09T04:15:00.000Z'),
      'America/New_York',
    ),
    'week:2026-08-02',
  )
})

test('retroactive completion dates map to canonical daily and weekly periods', () => {
  assert.equal(buddyPeriodKeyForDate({}, '2026-08-18'), 'day:2026-08-18')
  assert.equal(
    buddyPeriodKeyForDate({ schedule: { mode: 'weekly' } }, '2026-08-18'),
    'week:2026-08-16',
  )
  assert.equal(buddyPeriodKeyForDate({}, '2026-02-30'), null)
})

test('the same instant resolves independently across far-apart member timezones', () => {
  const instant = new Date('2026-08-09T11:45:00.000Z')
  assert.equal(buddyPeriodKey({}, instant, 'Pacific/Kiritimati'), 'day:2026-08-10')
  assert.equal(buddyPeriodKey({}, instant, 'Pacific/Honolulu'), 'day:2026-08-09')
})

test('membership exposes effective local dates and excludes observers from occurrences', () => {
  const members = [
    {
      userId: '1',
      role: 'participant',
      timezone: 'America/Los_Angeles',
      activeAt: '2026-08-02T06:00:00.000Z',
      removedAt: null,
    },
    {
      userId: '2',
      role: 'observer',
      timezone: 'UTC',
      activeAt: '2026-08-01T00:00:00.000Z',
      removedAt: null,
    },
  ]
  assert.deepEqual(membershipDates(members[0]), {
    effectiveFrom: '2026-08-01',
    effectiveTo: null,
  })
  assert.deepEqual(
    occurrenceCompletion('day:2026-08-03', members, [
      { userId: '1', periodKey: 'day:2026-08-03' },
    ]),
    {
      periodKey: 'day:2026-08-03',
      participantIds: ['1'],
      completedParticipantIds: ['1'],
      complete: true,
    },
  )
})

test('an occurrence completes only when every effective participant completes', () => {
  const members = [
    { userId: '1', role: 'participant', timezone: 'UTC', activeAt: '2026-08-01' },
    { userId: '2', role: 'participant', timezone: 'UTC', activeAt: '2026-08-03' },
  ]
  const first = occurrenceCompletion('day:2026-08-02', members, [
    { userId: '1', periodKey: 'day:2026-08-02' },
  ])
  const second = occurrenceCompletion('day:2026-08-03', members, [
    { userId: '1', periodKey: 'day:2026-08-03' },
  ])
  assert.equal(first.complete, true)
  assert.equal(second.complete, false)
  assert.deepEqual(second.participantIds, ['1', '2'])
})

test('weekly targets require distinct completion dates from every participant', () => {
  const definition = { schedule: { mode: 'weekly', timesPerWeek: 3 } }
  const members = [
    { userId: '1', role: 'participant', timezone: 'UTC', activeAt: '2026-08-01' },
    { userId: '2', role: 'participant', timezone: 'UTC', activeAt: '2026-08-01' },
  ]
  const completions = [
    { userId: '1', periodKey: 'week:2026-08-02', completionDate: '2026-08-03' },
    { userId: '1', periodKey: 'week:2026-08-02', completionDate: '2026-08-05' },
    { userId: '1', periodKey: 'week:2026-08-02', completionDate: '2026-08-07' },
    { userId: '2', periodKey: 'week:2026-08-02', completionDate: '2026-08-03' },
    { userId: '2', periodKey: 'week:2026-08-02', completionDate: '2026-08-05' },
  ]
  const incomplete = occurrenceCompletion(
    'week:2026-08-02',
    members,
    completions,
    definition,
  )
  assert.deepEqual(incomplete.completedParticipantIds, ['1'])
  assert.equal(incomplete.complete, false)
  completions.push({
    userId: '2',
    periodKey: 'week:2026-08-02',
    completionDate: '2026-08-07',
  })
  assert.equal(occurrenceCompletion(
    'week:2026-08-02',
    members,
    completions,
    definition,
  ).complete, true)
})

test('group streak walks scheduled occurrences and treats today as in progress', () => {
  const definition = {
    createdAt: '2026-08-01T00:00:00.000Z',
    schedule: { freq: 'weekly', days: [1, 3, 5], anchor: '2026-08-01' },
  }
  const members = [
    { userId: '1', role: 'participant', timezone: 'UTC', activeAt: '2026-08-01' },
    { userId: '2', role: 'participant', timezone: 'UTC', activeAt: '2026-08-01' },
  ]
  const completions = ['2026-08-07', '2026-08-05'].flatMap((date) =>
    members.map(({ userId }) => ({ userId, periodKey: `day:${date}` })))
  assert.equal(
    computeGroupStreak(
      definition,
      members,
      completions,
      new Date('2026-08-10T12:00:00.000Z'),
      'UTC',
    ),
    2,
  )
})

test('private promotion maps completion history without mutating private data', () => {
  const set = {
    id: 'private-1',
    name: 'Read',
    schedule: { mode: 'weekly', timesPerWeek: 2 },
    completions: { '2026-08-03': true, '2026-08-06': true },
  }
  assert.deepEqual(privateCompletionEntries(set), [
    { completionDate: '2026-08-03', periodKey: 'week:2026-08-02' },
    { completionDate: '2026-08-06', periodKey: 'week:2026-08-02' },
  ])
  assert.deepEqual(set.completions, {
    '2026-08-03': true,
    '2026-08-06': true,
  })
})
