// Date + streak/freeze helpers for Chrona.

const DAY = 86400000

export function startOfDay(d = new Date()) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

export function dateKey(d = new Date()) {
  const x = startOfDay(d)
  const y = x.getFullYear()
  const m = String(x.getMonth() + 1).padStart(2, '0')
  const day = String(x.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function addDays(d, n) {
  return startOfDay(new Date(startOfDay(d).getTime() + n * DAY))
}

export const todayKey = () => dateKey()

const WEEK = 7 * DAY

function parseKey(key) {
  if (key instanceof Date) return startOfDay(key)
  const [y, m, d] = String(key).split('-').map(Number)
  if (!y) return startOfDay(new Date())
  return startOfDay(new Date(y, (m || 1) - 1, d || 1))
}

function startOfWeek(d) {
  const x = startOfDay(d)
  return addDays(x, -x.getDay())
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate()
}

const mod = (n, m) => ((n % m) + m) % m

// Normalize schedule to { freq, interval, days[], anchor }.
// Back-compat: a bare weekday array becomes a weekly/interval-1 schedule.
export function normalizeSchedule(set) {
  const anchorKey = dateKey(new Date(set?.createdAt || Date.now()))
  const anchorDay = parseKey(anchorKey).getDate()
  const s = set?.schedule
  if (Array.isArray(s)) {
    return { freq: 'weekly', interval: 1, days: s, dayOfMonth: anchorDay, anchor: anchorKey }
  }
  if (s && typeof s === 'object') {
    return {
      freq: s.freq || 'weekly',
      interval: Math.max(1, s.interval || 1),
      days: Array.isArray(s.days) ? s.days : [],
      dayOfMonth: s.dayOfMonth || anchorDay,
      anchor: s.anchor || anchorKey,
    }
  }
  return { freq: 'weekly', interval: 1, days: [], dayOfMonth: anchorDay, anchor: anchorKey }
}

export function isScheduled(set, date) {
  const sc = normalizeSchedule(set)
  const d = startOfDay(date)
  const anchor = parseKey(sc.anchor)

  if (sc.freq === 'weekly') {
    const days = sc.days.length ? sc.days : [0, 1, 2, 3, 4, 5, 6]
    if (!days.includes(d.getDay())) return false
    if (sc.interval <= 1) return true
    const weeks = Math.round((startOfWeek(d) - startOfWeek(anchor)) / WEEK)
    return mod(weeks, sc.interval) === 0
  }

  if (sc.freq === 'monthly') {
    // clamp to the last day so 29/30/31 land on the month's final day
    const target = Math.min(sc.dayOfMonth, daysInMonth(d.getFullYear(), d.getMonth()))
    if (d.getDate() !== target) return false
    const months =
      (d.getFullYear() - anchor.getFullYear()) * 12 + (d.getMonth() - anchor.getMonth())
    return mod(months, sc.interval) === 0
  }

  if (sc.freq === 'yearly') {
    if (d.getMonth() !== anchor.getMonth() || d.getDate() !== anchor.getDate())
      return false
    return mod(d.getFullYear() - anchor.getFullYear(), sc.interval) === 0
  }

  return true
}

function isDone(set, d) {
  const k = dateKey(d)
  return Boolean(set.completions?.[k]) || Boolean(set.freezes?.[k])
}

export function totalSeconds(set) {
  return (set.steps || []).reduce((sum, s) => sum + (Number(s.seconds) || 0), 0)
}

export function formatDuration(totalSec) {
  const s = Math.max(0, Math.round(totalSec))
  const m = Math.floor(s / 60)
  const sec = s % 60
  if (m === 0) return `${sec}s`
  if (sec === 0) return `${m}m`
  return `${m}m ${sec}s`
}

export function clock(totalSec) {
  const s = Math.max(0, Math.ceil(totalSec))
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

// Walk backward to the most recent scheduled date on or before `from`.
function recentScheduled(set, from) {
  let d = startOfDay(from)
  for (let i = 0; i < 3650; i++) {
    if (isScheduled(set, d)) return d
    d = addDays(d, -1)
  }
  return d
}

function prevScheduled(set, from) {
  let d = addDays(from, -1)
  for (let i = 0; i < 3650; i++) {
    if (isScheduled(set, d)) return d
    d = addDays(d, -1)
  }
  return d
}

// Last `count` scheduled occurrence dates up to today (oldest first).
export function lastScheduledDates(set, count = 7) {
  const out = []
  let d = recentScheduled(set, new Date())
  for (let i = 0; i < count; i++) {
    out.unshift(d)
    d = prevScheduled(set, d)
  }
  return out
}

// Consecutive completed/frozen scheduled occurrences ending at the most recent
// past occurrence. Today counts only if already done; if today is scheduled but
// not yet done it is treated as "in progress" and does not break the streak.
export function computeStreak(set) {
  if (!set.trackStreak) return 0
  let d = recentScheduled(set, new Date())
  if (!isDone(set, d)) {
    // most recent occurrence (possibly today) not done yet -> start from prior
    d = prevScheduled(set, d)
  }
  let streak = 0
  for (let i = 0; i < 3650; i++) {
    if (isDone(set, d)) {
      streak++
      d = prevScheduled(set, d)
    } else break
  }
  return streak
}

// 1 freeze earned per 2 weeks since creation.
export function earnedFreezes(set) {
  const created = startOfDay(new Date(set.createdAt || Date.now()))
  const days = Math.floor((startOfDay(new Date()) - created) / DAY)
  return Math.floor(days / 14)
}

export function usedFreezes(set) {
  return Object.keys(set.freezes || {}).length
}

export function availableFreezes(set) {
  return Math.max(0, earnedFreezes(set) - usedFreezes(set))
}

// The occurrence a freeze would protect: the most proximate *upcoming*
// scheduled deadline that isn't already completed/frozen. A day's deadline is
// local midnight, so today still counts as upcoming until then. Starts at today
// and walks forward.
export function freezableDate(set) {
  let d = startOfDay(new Date())
  for (let i = 0; i < 3650; i++) {
    if (isScheduled(set, d) && !isDone(set, d)) return d
    d = addDays(d, 1)
  }
  return d
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

export function scheduleLabel(set) {
  const sc = normalizeSchedule(set)
  const anchor = parseKey(sc.anchor)

  if (sc.freq === 'monthly') {
    const base =
      sc.dayOfMonth >= 29
        ? 'last day of the month'
        : `${ordinal(sc.dayOfMonth)} of the month`
    return sc.interval > 1 ? `Every ${sc.interval} months · ${base}` : `Monthly · ${base}`
  }
  if (sc.freq === 'yearly') {
    const base = `${MONTHS[anchor.getMonth()]} ${anchor.getDate()}`
    return sc.interval > 1 ? `Every ${sc.interval} years · ${base}` : `Yearly · ${base}`
  }

  // weekly
  const days = sc.days || []
  let dayLabel
  if (days.length === 0 || days.length === 7) dayLabel = 'Every day'
  else {
    const sorted = [...days].sort((a, b) => a - b)
    if (sorted.join() === '1,2,3,4,5') dayLabel = 'Weekdays'
    else if (sorted.join() === '0,6') dayLabel = 'Weekends'
    else dayLabel = sorted.map((i) => WEEKDAYS[i]).join(', ')
  }
  if (sc.interval <= 1) return dayLabel
  return `Every ${sc.interval} weeks · ${dayLabel}`
}
