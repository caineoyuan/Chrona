const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
export const ON_TIME_WINDOW = 10 * MINUTE
const MISSED_WINDOW = 30 * MINUTE
const dateFormatters = new Map()
const dateTimeFormatters = new Map()
const timeFormatters = new Map()

function formatterFor(cache, timeZone, options) {
  if (!cache.has(timeZone)) {
    cache.set(timeZone, new Intl.DateTimeFormat('en-CA', { timeZone, ...options }))
  }
  return cache.get(timeZone)
}

export function inventoryInteger(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : fallback
}

export function updateTimeDigit(value, index, digit) {
  if (!/^\d$/.test(digit) || index < 0 || index > 3) return value
  const digits = value.replace(/\D/g, '').padEnd(4, '0').slice(0, 4).split('')
  const candidate = [...digits]
  candidate[index] = digit
  if (index === 0 && digit === '2' && Number(candidate[1]) > 3) candidate[1] = '0'
  const hours = Number(candidate.slice(0, 2).join(''))
  const minutes = Number(candidate.slice(2).join(''))
  if (hours > 23 || minutes > 59) return value
  return `${candidate[0]}${candidate[1]}:${candidate[2]}${candidate[3]}`
}

export function parsePastedTime(value) {
  const twelveHour = value.trim().match(/^(\d{1,2})(?::?([0-5]\d))\s*([ap])\.?m\.?$/i)
  if (twelveHour) {
    return toTwentyFourHourTime(twelveHour[1], twelveHour[2], twelveHour[3].toUpperCase() === 'A' ? 'AM' : 'PM')
  }
  const digits = value.replace(/\D/g, '')
  if (digits.length !== 4) return null
  const hours = Number(digits.slice(0, 2))
  const minutes = Number(digits.slice(2))
  return hours <= 23 && minutes <= 59 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : null
}

export function toTwelveHourTime(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (!match) return { hours: '12', minutes: '00', period: 'AM' }
  const hours = Number(match[1])
  return {
    hours: String(hours % 12 || 12).padStart(2, '0'),
    minutes: match[2],
    period: hours >= 12 ? 'PM' : 'AM',
  }
}

export function toTwentyFourHourTime(hours, minutes, period) {
  const hour = Number(hours)
  const minute = Number(minutes)
  if (!['AM', 'PM'].includes(period) || !Number.isInteger(hour) || hour < 1 || hour > 12 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null
  const normalizedHours = period === 'PM' ? hour % 12 + 12 : hour % 12
  return `${String(normalizedHours).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function timePartInput(rawValue, startsNewEntry = false) {
  const digits = rawValue.replace(/\D/g, '')
  return startsNewEntry ? digits.slice(-1) : digits.slice(-2)
}

export function wakingHourSchedule(intervalHours) {
  const interval = Math.min(12, Math.max(3, Math.round(Number(intervalHours) || 3)))
  const times = []
  for (let hour = 9; hour <= 23; hour += interval) {
    times.push(`${String(hour).padStart(2, '0')}:00`)
  }
  return times
}

export function timesForScheduleType(currentType, nextType, currentTimes, intervalHours) {
  if (nextType === 'interval') return wakingHourSchedule(intervalHours)
  if (currentType === 'interval') return ['08:00']
  return currentTimes
}

function atTime(date, time) {
  const [hours, minutes] = time.split(':').map(Number)
  const result = new Date(date)
  result.setHours(hours, minutes, 0, 0)
  return result
}

function shiftTime(time, minutes) {
  const [hours, currentMinutes] = time.split(':').map(Number)
  const shifted = (hours * 60 + currentMinutes + minutes + 24 * 60) % (24 * 60)
  return `${String(Math.floor(shifted / 60)).padStart(2, '0')}:${String(shifted % 60).padStart(2, '0')}`
}

function localDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function dateKeyInTimeZone(date, timeZone) {
  if (!timeZone) return localDateKey(date)
  try {
    const parts = formatterFor(dateFormatters, timeZone, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date)
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
    return `${values.year}-${values.month}-${values.day}`
  } catch {
    return localDateKey(date)
  }
}

function dateKeyValue(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

function addDateKey(dateKey, days) {
  const date = new Date(dateKeyValue(dateKey) + days * DAY)
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

function zonedDateTime(dateKey, time, timeZone) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const [hours, minutes] = time.split(':').map(Number)
  const desired = Date.UTC(year, month - 1, day, hours, minutes)
  let result = new Date(desired)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = formatterFor(dateTimeFormatters, timeZone, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(result)
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
    const rendered = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
    )
    const correction = desired - rendered
    if (!correction) return result
    result = new Date(result.getTime() + correction)
  }
  return result
}

export function scheduleTimesForDisplay(
  medication,
  reference = new Date(),
  viewerTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  const ownerTimeZone = medication.resourceAccess?.ownerTimezone
  if (!ownerTimeZone || !viewerTimeZone || ownerTimeZone === viewerTimeZone) {
    return medication.times
  }
  const ownerDateKey = dateKeyInTimeZone(reference, ownerTimeZone)
  const viewerFormatter = formatterFor(timeFormatters, viewerTimeZone, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  return medication.times.map((time) => {
    const instant = zonedDateTime(ownerDateKey, time, ownerTimeZone)
    const parts = viewerFormatter.formatToParts(instant)
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
    return `${values.hour}:${values.minute}`
  })
}

export function localScheduleAnchor(dateKey, time) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
  if (!dateMatch || !timeMatch) return null
  const result = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    0,
    0,
  )
  return Number.isNaN(result.getTime()) || localDateKey(result) !== dateKey ? null : result
}

export function reminderOffsets(notifications) {
  const stored = Array.isArray(notifications?.advanceMinutes)
    ? notifications.advanceMinutes
    : [notifications?.advanceMinutes ?? 0]
  return [...new Set(stored
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 10_080)
    .map(Math.round))]
    .sort((a, b) => a - b)
}

export function formatReminderAdvance(minutes) {
  if (!minutes) return 'Scheduled dose'
  if (minutes % 60 === 0) {
    const hours = minutes / 60
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} until the scheduled dose`
  }
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} until the scheduled dose`
}

function doseKey(medicationId, scheduledAt) {
  return `${medicationId}-${scheduledAt.toISOString()}`
}

function recordFor(medication, scheduledAt) {
  const timestamp = scheduledAt.toISOString()
  const exact = medication.history.find((entry) =>
    entry.scheduledAt === timestamp || entry.originalScheduledAt === timestamp)
  if (exact) return exact
  if (isDoseRelativeSchedule(scheduleFor(medication))) return null

  const ownerTimeZone = medication.resourceAccess?.ownerTimezone
  const occurrenceDate = dateKeyInTimeZone(scheduledAt, ownerTimeZone)
  return medication.history
    .filter((entry) => !entry.originalScheduledAt)
    .map((entry) => ({
      entry,
      displayAt: new Date(entry.takenAt || entry.skippedAt || entry.scheduledAt),
    }))
    .filter(({ displayAt }) => !Number.isNaN(displayAt.getTime()))
    .filter(({ displayAt }) => {
      if (dateKeyInTimeZone(displayAt, ownerTimeZone) === occurrenceDate) return true
      if (displayAt < scheduledAt) return false
      return scheduledOccurrencesBetween(
        medication,
        new Date(scheduledAt.getTime() + 1),
        new Date(displayAt.getTime() + 1),
      ).length === 0
    })
    .sort((left, right) => left.displayAt - right.displayAt)[0]?.entry || null
}

function recordForRegimen(medication, scheduledAt, medications = [medication]) {
  const key = regimenKey(medication)
  for (const candidate of medications) {
    if (regimenKey(candidate) !== key) continue
    const record = recordFor(candidate, scheduledAt)
    if (record) return record
  }
  return null
}

function nearestSlotIndex(medication, scheduledAt) {
  const times = Array.isArray(medication.times) && medication.times.length
    ? medication.times
    : [scheduledAt.toTimeString().slice(0, 5)]
  const targetMinutes = scheduledAt.getHours() * 60 + scheduledAt.getMinutes()
  return times.reduce((nearest, time, index) => {
    const [hours, minutes] = time.split(':').map(Number)
    const distance = Math.abs(hours * 60 + minutes - targetMinutes)
    return distance < nearest.distance ? { index, distance } : nearest
  }, { index: 0, distance: Infinity }).index
}

function scheduleFor(medication) {
  return { type: 'daily', intervalHours: 12, intervalDays: 7, weekdays: [], anchorAt: null, changes: [], ...medication.schedule }
}

function isDoseRelativeSchedule(schedule) {
  return schedule.type === 'daily' || schedule.type === 'interval'
}

function instantForCalendarTime(dateKey, time, timeZone) {
  return timeZone
    ? zonedDateTime(dateKey, time, timeZone)
    : localScheduleAnchor(dateKey, time)
}

function scheduleForCalendarDate(medication, dateKey, timeZone) {
  const current = { ...scheduleFor(medication), times: medication.times }
  const nextMidnight = instantForCalendarTime(addDateKey(dateKey, 1), '00:00', timeZone)
  return [...current.changes].reverse().reduce(
    (config, change) =>
      nextMidnight <= new Date(change.effectiveAt)
        ? { ...config, ...change.previous }
        : config,
    current,
  )
}

function scheduledTimesForCalendarDate(medication, dateKey, timeZone) {
  const schedule = scheduleForCalendarDate(medication, dateKey, timeZone)
  if (schedule.startDate && dateKey < schedule.startDate) return []
  const weekday = new Date(dateKeyValue(dateKey)).getUTCDay()
  if (schedule.type === 'weekly' && !schedule.weekdays.includes(weekday)) return []
  if (schedule.type === 'day-interval') {
    const anchor = new Date(schedule.anchorAt || medication.createdAt)
    const anchorKey = dateKeyInTimeZone(anchor, timeZone)
    const elapsedDays = Math.round(
      (dateKeyValue(dateKey) - dateKeyValue(anchorKey)) / DAY,
    )
    const intervalDays = Math.min(30, Math.max(2, Number(schedule.intervalDays) || 7))
    if (elapsedDays < 0 || elapsedDays % intervalDays !== 0) return []
  }
  if (schedule.type === 'interval' && schedule.anchorAt) {
    const start = instantForCalendarTime(dateKey, '00:00', timeZone)
    const end = instantForCalendarTime(addDateKey(dateKey, 1), '00:00', timeZone)
    const anchor = new Date(schedule.anchorAt)
    const interval = Math.max(1, Number(schedule.intervalHours) || 1) * 60 * MINUTE
    const firstIndex = Math.max(0, Math.ceil((start - anchor) / interval))
    const results = []
    for (let index = firstIndex; ; index += 1) {
      const scheduledAt = new Date(anchor.getTime() + index * interval)
      if (scheduledAt >= end) break
      if (scheduledAt >= start) {
        results.push({
          scheduledAt,
          time: scheduledAt.toTimeString().slice(0, 5),
          slotIndex: index,
        })
      }
    }
    return results
  }
  const times = schedule.type === 'day-interval' || schedule.type === 'weekly'
    ? schedule.times.slice(0, 1)
    : schedule.times
  return times.map((time, slotIndex) => ({
    scheduledAt: instantForCalendarTime(dateKey, time, timeZone),
    time,
    slotIndex,
  }))
}

function regimenKey(medication) {
  const schedule = scheduleFor(medication)
  const owner = medication.resourceAccess?.ownerUserId || 'owner'
  return `${owner}|${regimenCadenceKey(medication, schedule)}`
}

function regimenCadenceKey(medication, schedule = scheduleFor(medication)) {
  return [
    String(medication.name || '').normalize('NFKC').trim().toLocaleLowerCase(),
    String(medication.dose || '').normalize('NFKC').trim().toLocaleLowerCase(),
    schedule.type,
    schedule.type === 'day-interval' ? Number(schedule.intervalDays) || 7 : '',
  ].join('|')
}

export function isOccurrenceTooCloseToTakenDoses(medication, scheduledAt, doses) {
  const schedule = scheduleFor(medication)
  if (schedule.type !== 'day-interval') return false
  const ownerTimeZone = medication.resourceAccess?.ownerTimezone
  const scheduledDay = dateKeyValue(dateKeyInTimeZone(scheduledAt, ownerTimeZone))
  const intervalDays = Math.min(30, Math.max(2, Number(schedule.intervalDays) || 7))
  const cadenceKey = regimenCadenceKey(medication, schedule)
  return doses.some((dose) => {
    if (!dose.record?.takenAt ||
        regimenCadenceKey(dose.medication) !== cadenceKey) return false
    const takenDay = dateKeyValue(
      dateKeyInTimeZone(new Date(dose.record.takenAt), ownerTimeZone),
    )
    const elapsedDays = Math.round((scheduledDay - takenDay) / DAY)
    return elapsedDays > 0 && elapsedDays < intervalDays
  })
}

function isEveryDaysOccurrenceTooCloseToTakenDose(
  medication,
  scheduledAt,
  medications = [medication],
) {
  const ownerTimeZone = medication.resourceAccess?.ownerTimezone
  const dateKey = dateKeyInTimeZone(scheduledAt, ownerTimeZone)
  const schedule = scheduleForCalendarDate(medication, dateKey, ownerTimeZone)
  if (schedule.type !== 'day-interval') return false
  const intervalDays = Math.min(30, Math.max(2, Number(schedule.intervalDays) || 7))
  const scheduledDay = dateKeyValue(dateKey)
  const key = regimenKey(medication)
  return medications
    .filter((candidate) => regimenKey(candidate) === key)
    .some((candidate) => candidate.history.some((record) => {
      if (!record.takenAt) return false
      const takenDay = dateKeyValue(dateKeyInTimeZone(new Date(record.takenAt), ownerTimeZone))
      const elapsedDays = Math.round((scheduledDay - takenDay) / DAY)
      return elapsedDays > 0 && elapsedDays < intervalDays
    }))
}

function scheduledOccurrencesBetween(
  medication,
  startValue,
  endValue,
  medications = [medication],
) {
  const start = new Date(startValue)
  const end = new Date(endValue)
  const ownerTimeZone = medication.resourceAccess?.ownerTimezone
  const firstKey = addDateKey(dateKeyInTimeZone(start, ownerTimeZone), -1)
  const lastKey = addDateKey(dateKeyInTimeZone(new Date(end.getTime() - 1), ownerTimeZone), 1)
  const occurrences = []
  for (let dateKey = firstKey; dateKey <= lastKey; dateKey = addDateKey(dateKey, 1)) {
    occurrences.push(...scheduledTimesForCalendarDate(medication, dateKey, ownerTimeZone))
  }
  const createdAt = new Date(medication.createdAt)
  return occurrences
    .filter(({ scheduledAt }) =>
      scheduledAt >= start &&
      scheduledAt < end &&
      scheduledAt >= createdAt &&
      isActiveAt(medication, scheduledAt) &&
      !isEveryDaysOccurrenceTooCloseToTakenDose(medication, scheduledAt, medications))
    .filter(({ scheduledAt }) => {
      const timestamp = scheduledAt.toISOString()
      return !medication.history.some((record) =>
        record.originalScheduledAt === timestamp && record.scheduledAt !== timestamp)
    })
    .filter(({ scheduledAt }, index, all) =>
      all.findIndex((entry) => entry.scheduledAt.getTime() === scheduledAt.getTime()) === index)
    .sort((left, right) => left.scheduledAt - right.scheduledAt)
}

function scheduledTimesForDay(medication, day, medications = [medication]) {
  const start = new Date(day)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return scheduledOccurrencesBetween(medication, start, end, medications)
}

export function isActiveAt(medication, value) {
  const timestamp = new Date(value).getTime()
  return !(medication.pausePeriods || []).some((period) => {
    const start = new Date(period.start).getTime()
    const end = period.end ? new Date(period.end).getTime() : Infinity
    return timestamp >= start && timestamp <= end
  })
}

export function getDosesForDay(medications, day = new Date()) {
  const dayKey = localDateKey(day)
  const doses = medications.flatMap((medication) => {
    const scheduled = scheduledTimesForDay(medication, day, medications).map(({ scheduledAt, time, slotIndex }) => ({
      medication,
      time,
      slotIndex,
      scheduledAt,
      record: recordForRegimen(medication, scheduledAt, medications),
      key: doseKey(medication.id, scheduledAt),
    }))
    const scheduledRecordIds = new Set(scheduled.map((dose) => dose.record?.id).filter(Boolean))
    const recorded = medication.history.flatMap((record) => {
      if (scheduledRecordIds.has(record.id)) return []
      const displayAt = new Date(record.takenAt || record.skippedAt || record.scheduledAt)
      const scheduledAt = new Date(record.scheduledAt)
      if (Number.isNaN(displayAt.getTime()) || Number.isNaN(scheduledAt.getTime()) || localDateKey(displayAt) !== dayKey) return []
      return [{
        medication,
        time: displayAt.toTimeString().slice(0, 5),
        slotIndex: nearestSlotIndex(medication, scheduledAt),
        scheduledAt,
        record,
        key: `${medication.id}-record-${record.id || record.scheduledAt}`,
      }]
    })
    return [...scheduled, ...recorded]
  }).sort((a, b) => {
    const first = new Date(a.record?.takenAt || a.record?.skippedAt || a.scheduledAt)
    const second = new Date(b.record?.takenAt || b.record?.skippedAt || b.scheduledAt)
    return first - second
  })
  const seen = new Set()
  return doses.filter((dose) => {
    const identity = dose.record?.id
      ? `${regimenKey(dose.medication)}|record|${dose.record.id}`
      : `${regimenKey(dose.medication)}|scheduled|${dose.scheduledAt.toISOString()}`
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

export function getActionableDoses(medications, now = new Date()) {
  const today = getDosesForDay(medications, now)
  const overdue = []

  for (const medication of medications) {
    if (scheduleFor(medication).type !== 'day-interval' || scheduledTimesForDay(medication, now, medications).length) continue
    const start = new Date(now)
    start.setDate(start.getDate() - 30)
    const latest = scheduledOccurrencesBetween(medication, start, now, medications).at(-1)
    if (!latest || recordForRegimen(medication, latest.scheduledAt, medications)) continue
    overdue.push({
      medication,
      ...latest,
      overdue: true,
      record: null,
      key: doseKey(medication.id, latest.scheduledAt),
    })
  }

  return [...overdue, ...today].sort((a, b) => a.scheduledAt - b.scheduledAt)
}

export function getRecentDoses(medications, now = new Date(), days = 7) {
  const start = new Date(now)
  start.setDate(start.getDate() - Math.max(0, days - 1))
  start.setHours(0, 0, 0, 0)
  const end = new Date(now)
  end.setHours(24, 0, 0, 0)
  const doses = medications.flatMap((medication) =>
    scheduledOccurrencesBetween(medication, start, end, medications).map((occurrence) => ({
      medication,
      ...occurrence,
      record: recordForRegimen(medication, occurrence.scheduledAt, medications),
      key: doseKey(medication.id, occurrence.scheduledAt),
    })))
  return doses.sort((a, b) => a.scheduledAt - b.scheduledAt)
}

export function getNextDose(medications, now = new Date(), takenDoses = []) {
  const end = new Date(now)
  end.setDate(end.getDate() + 33)
  end.setHours(0, 0, 0, 0)
  const candidates = medications.flatMap((medication) =>
    scheduledOccurrencesBetween(medication, now, end, medications)
      .filter(({ scheduledAt }) =>
        !recordForRegimen(medication, scheduledAt, medications) &&
        !isOccurrenceTooCloseToTakenDoses(medication, scheduledAt, takenDoses))
      .map((occurrence) => ({ medication, ...occurrence })))
  return candidates.sort((a, b) => a.scheduledAt - b.scheduledAt)[0] || null
}

export function getNextReminder(medications, now = new Date()) {
  const candidates = []
  const end = new Date(now)
  end.setDate(end.getDate() + 33)
  end.setHours(0, 0, 0, 0)
  for (const medication of medications) {
    if (medication.notifications?.enabled === false) continue
    for (const { scheduledAt, time, slotIndex } of scheduledOccurrencesBetween(medication, now, end, medications)) {
      for (const advanceMinutes of reminderOffsets(medication.notifications)) {
        const alertAt = new Date(scheduledAt.getTime() - advanceMinutes * MINUTE)
        if (alertAt >= now && !recordForRegimen(medication, scheduledAt, medications)) {
          candidates.push({ medication, time, slotIndex, scheduledAt, alertAt, advanceMinutes })
        }
      }
    }
  }
  return candidates.sort((a, b) => a.alertAt - b.alertAt)[0] || null
}

export function getUpcomingReminders(medications, now = new Date(), days = 32) {
  const reminders = []
  const end = new Date(now)
  end.setDate(end.getDate() + days + 1)
  end.setHours(0, 0, 0, 0)
  for (const medication of medications) {
    if (medication.notifications?.enabled === false) continue
    for (const { scheduledAt, time } of scheduledOccurrencesBetween(medication, now, end, medications)) {
      for (const advanceMinutes of reminderOffsets(medication.notifications)) {
        const alertAt = new Date(scheduledAt.getTime() - advanceMinutes * MINUTE)
        if (alertAt < now || recordForRegimen(medication, scheduledAt, medications)) continue
        const prefix = formatReminderAdvance(advanceMinutes)
        reminders.push({
          id: `${medication.id}-${scheduledAt.toISOString()}-${advanceMinutes}`,
          medicationId: medication.id,
          alertAt: alertAt.toISOString(),
          scheduledAt: scheduledAt.toISOString(),
          advanceMinutes,
          title: medication.name,
          body: `${prefix} · ${medication.dose || medication.notes || ''}`,
          tag: `dose-${medication.id}-${time}-${advanceMinutes}`,
          icon: medication.trackInjectionSite ? '/syringe-icon.svg' : '/medication-icon.png',
        })
      }
    }
  }
  return reminders.sort((a, b) => new Date(a.alertAt) - new Date(b.alertAt))
}

export function getDoseWindow(medication, scheduledAt) {
  const start = new Date(scheduledAt)
  start.setDate(start.getDate() - 32)
  const end = new Date(scheduledAt.getTime() + 1)
  const all = scheduledOccurrencesBetween(medication, start, end)
    .map((dose) => dose.scheduledAt)
  const previous = all.filter((date) => date < scheduledAt).sort((a, b) => b - a)[0] || new Date(scheduledAt - DAY)
  return { previous, scheduledAt }
}

export function getLastTaken(medication) {
  return medication.history
    .filter((record) => record.takenAt)
    .sort((a, b) => new Date(b.takenAt) - new Date(a.takenAt))[0] || null
}

export function isFutureLocalDate(dateKey, now = new Date()) {
  const target = localScheduleAnchor(dateKey, '00:00')
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Boolean(target && target > today)
}

export function overrideTakenDate(medication, recordId, dateKey, overrideTime = null, injectionSite = undefined) {
  const record = medication.history.find((entry) => entry.id === recordId && entry.takenAt)
  if (!record) return medication
  const previousTakenAt = new Date(record.takenAt)
  const time = overrideTime || `${String(previousTakenAt.getHours()).padStart(2, '0')}:${String(previousTakenAt.getMinutes()).padStart(2, '0')}`
  const takenAt = localScheduleAnchor(dateKey, time)
  if (!takenAt) return medication
  const originalScheduledAt = new Date(record.originalScheduledAt || record.scheduledAt)
  if (Number.isNaN(originalScheduledAt.getTime())) return medication
  if (getLastTaken(medication)?.id !== recordId) {
    return {
      ...medication,
      history: medication.history.map((entry) => entry.id !== recordId ? entry : {
        ...entry,
        takenAt: takenAt.toISOString(),
        status: isOnTime(originalScheduledAt, takenAt) ? 'on-time' : 'late',
        ...(injectionSite === undefined ? {} : { injectionSite: injectionSite || null }),
      }),
    }
  }
  const restored = undoScheduleAfterDose(medication, record)
  const base = {
    ...medication,
    times: restored.times || medication.times || [time],
    schedule: restored.schedule || medication.schedule,
  }
  const adjustment = adjustScheduleAfterDose(base, {
    medication: base,
    scheduledAt: originalScheduledAt,
    slotIndex: nearestSlotIndex(base, originalScheduledAt),
  }, takenAt)
  const history = base.history.map((entry) => entry.id !== recordId ? entry : {
    ...entry,
    scheduledAt: adjustment.scheduledAt.toISOString(),
    takenAt: takenAt.toISOString(),
    originalScheduledAt: adjustment.originalScheduledAt?.toISOString() || null,
    status: isOnTime(originalScheduledAt, takenAt) ? 'on-time' : 'late',
    ...(injectionSite === undefined ? {} : { injectionSite: injectionSite || null }),
  })
  return {
    ...base,
    history,
    times: adjustment.times,
    schedule: adjustment.schedule,
  }
}

export function getRecentInjectionSites(medication, limit = 2) {
  return [...medication.history]
    .filter((record) => record.injectionSite)
    .sort((a, b) => new Date(b.takenAt) - new Date(a.takenAt))
    .slice(0, limit)
    .map((record) => record.injectionSite)
}

export const INJECTION_SITE_CODES = {
  'left-lower': 'LL',
  'left-upper': 'LU',
  'right-lower': 'RL',
  'right-upper': 'RU',
}

export function medicationCalendarMonths(medication, now = new Date(), range = null) {
  const history = medication.history || []
  const recordDates = history
    .map((record) => new Date(record.takenAt || record.scheduledAt || record.skippedAt))
    .filter((date) => !Number.isNaN(date.getTime()))
  const earliest = recordDates.reduce((first, date) => date < first ? date : first, now)
  const firstMonth = range
    ? new Date(now.getFullYear(), now.getMonth() - Math.max(0, range.pastMonths || 0), 1)
    : new Date(earliest.getFullYear(), earliest.getMonth(), 1)
  const lastMonth = range
    ? new Date(now.getFullYear(), now.getMonth() + Math.max(0, range.futureMonths || 0), 1)
    : new Date(now.getFullYear(), now.getMonth(), 1)
  const cursor = new Date(firstMonth)
  const months = []

  while (cursor <= lastMonth) {
    const year = cursor.getFullYear()
    const month = cursor.getMonth()
    const totalDays = new Date(year, month + 1, 0).getDate()
    months.push({
      key: `${year}-${month}`,
      label: cursor.toLocaleDateString([], { month: 'long', year: 'numeric' }),
      leadingDays: new Date(year, month, 1).getDay(),
      days: Array.from({ length: totalDays }, (_, index) => {
        const day = index + 1
        const date = new Date(year, month, day, 12, 0, 0)
        const key = localDateKey(date)
        const records = history.filter((record) => {
          const recordDate = new Date(record.takenAt || record.scheduledAt || record.skippedAt)
          return !Number.isNaN(recordDate.getTime()) && localDateKey(recordDate) === key
        })
        const scheduled = Array.isArray(medication.times) && medication.createdAt
          ? scheduledTimesForDay(medication, date)
            .filter(({ scheduledAt }) => scheduledAt >= new Date(medication.createdAt) && isActiveAt(medication, scheduledAt))
          : []
        const unresolvedMisses = scheduled.filter(({ scheduledAt }) => (
          !history.some((record) => (
            record.scheduledAt === scheduledAt.toISOString() || record.originalScheduledAt === scheduledAt.toISOString()
          )) && now - scheduledAt > MISSED_WINDOW
        ))
        const events = [
          ...records.map((record) => ({
            recordId: record.id || null,
            status: record.takenAt ? record.status || 'taken' : 'missed',
            time: record.takenAt || record.skippedAt || record.scheduledAt,
            injectionSite: record.injectionSite || null,
          })),
          ...unresolvedMisses.map(({ scheduledAt }) => ({
            status: 'missed',
            time: scheduledAt.toISOString(),
            injectionSite: null,
          })),
        ]
        return {
          day,
          dateKey: key,
          count: records.filter((record) => record.takenAt).length,
          missedCount: events.filter((event) => event.status === 'missed' || event.status === 'skipped').length,
          injectionSites: records.filter((record) => record.injectionSite).map((record) => INJECTION_SITE_CODES[record.injectionSite]),
          events,
        }
      }),
    })
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return range ? months : months.reverse()
}

export function adjustScheduleAfterDose(medication, dose, takenAt) {
  const schedule = scheduleFor(medication)
  const shiftedAt = new Date(takenAt)
  shiftedAt.setSeconds(0, 0)
  const scheduledAt = new Date(dose.scheduledAt)
  scheduledAt.setSeconds(0, 0)
  const shifted = isDoseRelativeSchedule(schedule) && shiftedAt.getTime() !== scheduledAt.getTime()
  const shiftMinutes = Math.round((shiftedAt - scheduledAt) / MINUTE)
  return {
    shifted,
    scheduledAt: shifted ? shiftedAt : dose.scheduledAt,
    originalScheduledAt: shifted ? dose.scheduledAt : null,
    times: shifted && schedule.type === 'daily'
      ? medication.times.map((time) => shiftTime(time, shiftMinutes)).sort()
      : medication.times,
    schedule: shifted
      ? {
          ...schedule,
          anchorAt: schedule.type === 'interval' ? shiftedAt.toISOString() : schedule.anchorAt,
          changes: [...schedule.changes, {
            effectiveAt: shiftedAt.toISOString(),
            previous: {
              type: schedule.type,
              intervalHours: schedule.intervalHours,
              intervalDays: schedule.intervalDays,
              weekdays: schedule.weekdays,
              anchorAt: schedule.anchorAt,
              times: medication.times,
            },
          }],
        }
      : medication.schedule,
  }
}

export function repairDynamicSchedule(medication) {
  const schedule = scheduleFor(medication)
  if (!isDoseRelativeSchedule(schedule)) return medication
  const latest = getLastTaken(medication)
  if (!latest?.scheduledAt) return medication
  const takenAt = new Date(latest.takenAt)
  const scheduledAt = new Date(latest.scheduledAt)
  if (Number.isNaN(takenAt.getTime()) || Number.isNaN(scheduledAt.getTime())) return medication
  takenAt.setSeconds(0, 0)
  scheduledAt.setSeconds(0, 0)
  if (takenAt.getTime() === scheduledAt.getTime()) return medication

  const adjustment = adjustScheduleAfterDose(medication, {
    medication,
    scheduledAt,
    slotIndex: nearestSlotIndex(medication, scheduledAt),
  }, takenAt)
  return {
    ...medication,
    times: adjustment.times,
    schedule: adjustment.schedule,
    history: medication.history.map((record) => record !== latest ? record : {
      ...record,
      scheduledAt: adjustment.scheduledAt.toISOString(),
      originalScheduledAt: record.originalScheduledAt || scheduledAt.toISOString(),
    }),
  }
}

export function undoScheduleAfterDose(medication, record) {
  const schedule = scheduleFor(medication)
  if (!record.originalScheduledAt || !schedule.changes.length) {
    return { times: medication.times, schedule: medication.schedule }
  }
  const changeIndex = schedule.changes.findLastIndex((change) => change.effectiveAt === record.scheduledAt)
  if (changeIndex !== schedule.changes.length - 1) {
    return { times: medication.times, schedule: medication.schedule }
  }
  const previous = schedule.changes[changeIndex].previous
  return {
    times: previous.times,
    schedule: {
      ...schedule,
      type: previous.type,
      intervalHours: previous.intervalHours,
      intervalDays: previous.intervalDays,
      weekdays: previous.weekdays,
      anchorAt: previous.anchorAt,
      changes: schedule.changes.slice(0, changeIndex),
    },
  }
}

export function removeTakenHistoryRecord(medication, recordId) {
  const record = medication.history.find((entry) => entry.id === recordId)
  if (!record) return medication
  const restored = undoScheduleAfterDose(medication, record)
  return {
    ...medication,
    times: restored.times,
    schedule: restored.schedule,
    history: medication.history.filter((entry) => entry.id !== recordId),
    inventory: !record.takenAt || medication.inventory?.remaining == null ? medication.inventory : {
      ...medication.inventory,
      remaining: inventoryInteger(medication.inventory.remaining) + 1,
    },
  }
}

export function addTakenHistoryRecord(medication, recordId, dateKey, time, injectionSite = null, scheduledAtValue = null) {
  const takenAt = localScheduleAnchor(dateKey, time)
  if (!recordId || !takenAt) return medication
  const previousScheduledAt = scheduledAtValue ? new Date(scheduledAtValue) : takenAt
  if (Number.isNaN(previousScheduledAt.getTime())) return medication
  const base = {
    ...medication,
    times: Array.isArray(medication.times) && medication.times.length ? medication.times : [time],
  }
  const latestTakenAt = getLastTaken(base)?.takenAt
  const shouldReanchor = isDoseRelativeSchedule(scheduleFor(base)) &&
    (!latestTakenAt || takenAt >= new Date(latestTakenAt))
  const slotIndex = nearestSlotIndex(base, previousScheduledAt)
  const overridden = shouldReanchor
    ? overrideScheduledTime(base, { scheduledAt: takenAt, slotIndex }, time)
    : { scheduledAt: previousScheduledAt, times: base.times, schedule: base.schedule }
  const timestamp = takenAt.toISOString()
  const scheduledTimestamp = overridden.scheduledAt.toISOString()
  const previousScheduledTimestamp = previousScheduledAt.toISOString()
  return {
    ...base,
    times: overridden.times,
    schedule: overridden.schedule,
    history: [...base.history.filter((entry) => {
      const source = entry.originalScheduledAt || entry.scheduledAt
      return source !== previousScheduledTimestamp && entry.scheduledAt !== scheduledTimestamp
    }), {
      id: recordId,
      scheduledAt: scheduledTimestamp,
      takenAt: timestamp,
      originalScheduledAt: previousScheduledTimestamp === scheduledTimestamp ? null : previousScheduledTimestamp,
      status: 'on-time',
      injectionSite: injectionSite || null,
    }],
    inventory: base.inventory?.remaining == null ? base.inventory : {
      ...base.inventory,
      remaining: Math.max(0, inventoryInteger(base.inventory.remaining) - 1),
    },
  }
}

export function overrideScheduledTime(medication, dose, time) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    return { times: medication.times, schedule: medication.schedule, scheduledAt: dose.scheduledAt }
  }
  const schedule = scheduleFor(medication)
  const scheduledAt = atTime(dose.scheduledAt, time)
  const times = schedule.type === 'interval'
    ? medication.times
    : medication.times.map((current, index) => index === dose.slotIndex ? time : current)
  return {
    scheduledAt,
    times,
    schedule: {
      ...schedule,
      anchorAt: schedule.type === 'interval' || schedule.type === 'day-interval'
        ? scheduledAt.toISOString()
        : schedule.anchorAt,
      changes: [...schedule.changes, {
        effectiveAt: scheduledAt.toISOString(),
        previous: {
          type: schedule.type,
          intervalHours: schedule.intervalHours,
          intervalDays: schedule.intervalDays,
          weekdays: schedule.weekdays,
          anchorAt: schedule.anchorAt,
          times: medication.times,
        },
      }],
    },
  }
}

export function updateDoseTime(medication, dose, time) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return medication
  if (dose.record?.takenAt) {
    const takenAt = new Date(dose.record.takenAt)
    if (Number.isNaN(takenAt.getTime())) return medication
    return overrideTakenDate(medication, dose.record.id, localDateKey(takenAt), time)
  }

  const restored = dose.record?.originalScheduledAt
    ? undoScheduleAfterDose(medication, dose.record)
    : { times: medication.times, schedule: medication.schedule }
  const base = { ...medication, times: restored.times, schedule: restored.schedule }
  const baseScheduledAt = new Date(dose.record?.originalScheduledAt || dose.scheduledAt)
  if (Number.isNaN(baseScheduledAt.getTime())) return medication
  const overridden = overrideScheduledTime(base, { ...dose, scheduledAt: baseScheduledAt }, time)
  return {
    ...base,
    times: overridden.times,
    schedule: overridden.schedule,
    history: base.history.map((record) => record.id !== dose.record?.id ? record : {
      ...record,
      scheduledAt: overridden.scheduledAt.toISOString(),
      originalScheduledAt: null,
    }),
  }
}

export function isOnTime(scheduledAt, takenAt) {
  return Math.abs(takenAt - scheduledAt) <= ON_TIME_WINDOW
}

export function takenRecordStatus(record) {
  if (record.status === 'skipped' || !record.takenAt) return record.status
  const scheduledAt = new Date(record.originalScheduledAt || record.scheduledAt)
  const takenAt = new Date(record.takenAt)
  if (Number.isNaN(scheduledAt.getTime()) || Number.isNaN(takenAt.getTime())) return record.status
  return isOnTime(scheduledAt, takenAt) ? 'on-time' : 'late'
}

export function adherenceFor(doses, now = new Date()) {
  const eligible = doses.filter((dose) => dose.scheduledAt <= now)
  const onTime = eligible.filter((dose) => dose.record?.status === 'on-time').length
  const late = eligible.filter((dose) => dose.record?.status === 'late').length
  const missed = eligible.filter((dose) => dose.record?.status === 'skipped' || (!dose.record && now - dose.scheduledAt > MISSED_WINDOW)).length
  const total = onTime + late + missed
  const taken = onTime + late
  return {
    total, taken, onTime, late, missed,
    adherence: total ? Math.round(taken / total * 100) : 100,
    onTimeRate: taken ? Math.round(onTime / taken * 100) : 100,
  }
}

export function formatRelative(target, now = new Date()) {
  const minutes = Math.max(0, Math.ceil((target - now) / MINUTE))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remainingHours = hours % 24
    const dayLabel = `${days} ${days === 1 ? 'day' : 'days'}`
    return remainingHours ? `${dayLabel} ${remainingHours} ${remainingHours === 1 ? 'hour' : 'hours'}` : dayLabel
  }
  const remainder = minutes % 60
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`
}

export function formatDateTime(value) {
  return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
