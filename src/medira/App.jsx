import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import './index.css'
import { FluentProvider, Spinner, Switch, webDarkTheme, webLightTheme } from '@fluentui/react-components'
import Avatar from '../components/Avatar'
import Icon from '../components/PaperIcon'
import {
  CheckCircleButton,
  IconButton as PaperIconButton,
} from '../components/PaperButton'
import {
  loadMediraNavigation,
  saveMediraNavigation,
  saveMediraView,
} from './navigation.js'
import {
  addTakenHistoryRecord,
  adjustScheduleAfterDose,
  formatDateTime,
  formatReminderAdvance,
  formatRelative,
  getActionableDoses,
  getDoseWindow,
  getDosesForDay,
  getLastTaken,
  getNextDose,
  getNextReminder,
  getRecentInjectionSites,
  INJECTION_SITE_CODES,
  inventoryInteger,
  isFutureLocalDate,
  isOnTime,
  localScheduleAnchor,
  medicationCalendarMonths,
  overrideTakenDate,
  parsePastedTime,
  reminderOffsets,
  removeTakenHistoryRecord,
  timesForScheduleType,
  timePartInput,
  toTwelveHourTime,
  toTwentyFourHourTime,
  updateDoseTime,
  wakingHourSchedule,
} from './lib'
import { scanMedicationLabel } from './labelOcr'
import { searchOpenFda } from './openFda'
import { playComplete, unlockSounds } from './sound'
import { useMedications } from './storage'
import { syncPushReminders } from './push'
import { medicationPermissions } from './scoped-medications'
import { useMedicationSharing } from './medication-sharing'
import { sharingEnabled } from '../feature-flags.js'

const emptyForm = {
  name: '', dose: '', notes: '', times: ['08:00'],
  scheduleType: 'daily', intervalHours: 12, weeklyMode: 'interval', intervalDays: 7,
  weekdays: [1], scheduleAnchorAt: null, scheduleChanges: [], hasStartDate: false, startDate: '',
  inventoryRemaining: '', inventoryUnit: 'doses', refillAt: 0,
  notificationsEnabled: true, notifyMinutesBefore: [0], reminderTiming: 'preset', customReminderMinutes: null,
  customNotifyAmount: 2, customNotifyUnit: 'hours', trackInjectionSite: false,
}

const mediraTheme = {
  ...webDarkTheme,
  colorBrandBackground: '#01eeb8',
  colorBrandBackgroundHover: '#57f6da',
  colorBrandForeground1: '#01eeb8',
  colorCompoundBrandBackground: '#01eeb8',
  colorCompoundBrandBackgroundHover: '#57f6da',
  colorCompoundBrandBackgroundPressed: '#01eeb8',
  colorNeutralBackground1: '#131313',
}
const mediraLightTheme = {
  ...webLightTheme,
  colorBrandBackground: '#59b899',
  colorBrandBackgroundHover: '#59b899',
  colorBrandForeground1: '#006b56',
  colorCompoundBrandBackground: '#59b899',
  colorCompoundBrandBackgroundHover: '#59b899',
  colorCompoundBrandBackgroundPressed: '#59b899',
  colorNeutralBackground1: '#f7f7f4',
}

const REMINDER_PRESETS = [
  { value: 0, label: 'At time' },
  { value: 5, label: '5 min' },
  { value: 10, label: '10 min' },
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hour' },
]
const REMINDER_PRESET_VALUES = REMINDER_PRESETS.map(({ value }) => value)
const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]

function formatTime(time) {
  return new Date(`2000-01-01T${time}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function weeklyFrequency(weekdays) {
  const names = weekdays.map((day) => WEEKDAY_NAMES[day]).filter(Boolean)
  return names.length
    ? `Every ${new Intl.ListFormat(undefined, { type: 'conjunction' }).format(names)}`
    : 'Every selected day'
}

function localDateValue(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function scheduleLabels(medication) {
  const schedule = { type: 'daily', intervalHours: 12, intervalDays: 7, weekdays: [], ...medication.schedule }
  let frequency
  if (schedule.type === 'interval') frequency = `Every ${schedule.intervalHours} hours`
  else if (schedule.type === 'day-interval') frequency = `Every ${schedule.intervalDays} days at ${formatTime(medication.times[0])}`
  else if (schedule.type === 'weekly') {
    const frequency = weeklyFrequency(schedule.weekdays)
    const labels = [`${frequency} at ${formatTime(medication.times[0])}`]
    if (schedule.startDate) labels.push(`Starts ${formatLocalDate(schedule.startDate)}`)
    return labels
  }
  else frequency = `Daily at ${medication.times.map(formatTime).join(' and ')}`
  return [frequency, ...(schedule.startDate ? [`Starts ${formatLocalDate(schedule.startDate)}`] : [])]
}

function formatLocalDate(value) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatLocalDateLong(value) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })
}

function frequencyLabel(medication) {
  const schedule = { type: 'daily', intervalHours: 12, intervalDays: 7, weekdays: [], ...medication.schedule }
  if (schedule.type === 'interval') return `Every ${schedule.intervalHours}h`
  if (schedule.type === 'day-interval') return `Every ${schedule.intervalDays} days`
  if (schedule.type === 'weekly') return weeklyFrequency(schedule.weekdays)
  return 'Daily'
}

function medicationTakenCount(medication) {
  return medication.history.filter((record) => record.takenAt).length
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}

function medicationListClipboardContent(medications) {
  const entries = medications.map((medication) => {
    const dose = medication.dose || 'Dose not specified'
    const schedule = scheduleLabels(medication).join(' · ')
    const canViewHistory = medicationPermissions(medication).canViewHistory
    const count = canViewHistory ? medicationTakenCount(medication) : null
    const since = new Date(medication.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
    return { medication, dose, schedule, count, since }
  })
  return {
    text: ['Medication list', ...entries.map(({ medication, dose, schedule, count, since }) => (
      `• ${medication.name}\n  ◦ Dose: ${dose}\n  ◦ Schedule: ${schedule}${
        count == null ? '' : `\n  ◦ ${count} ${count === 1 ? 'dose' : 'doses'} taken since ${since}`
      }`
    ))].join('\n'),
    html: `<h2>Medication list</h2><ul>${entries.map(({ medication, dose, schedule, count, since }) => (
      `<li><strong>${escapeHtml(medication.name)}</strong><ul><li>Dose: ${escapeHtml(dose)}</li><li>Schedule: ${escapeHtml(schedule)}</li>${count == null ? '' : `<li>${count} ${count === 1 ? 'dose' : 'doses'} taken since ${escapeHtml(since)}</li>`}</ul></li>`
    )).join('')}</ul>`,
  }
}

function SmallIconButton({ label, name, size = 17, className = '', ...props }) {
  return <PaperIconButton label={label} icon={<Icon name={name} size={size} />}
    className={className} {...props} />
}

function TimeInput({ value, onChange, onComplete, label, compact = false }) {
  const inputs = useRef([])
  const startsNewEntry = useRef([false, false])
  const [parts, setParts] = useState(() => toTwelveHourTime(value))
  const partsRef = useRef(parts)

  const updateParts = (nextParts) => {
    partsRef.current = nextParts
    setParts(nextParts)
  }

  useEffect(() => {
    const nextParts = toTwelveHourTime(value)
    partsRef.current = nextParts
    setParts(nextParts)
  }, [value])

  const enterPart = (index, rawValue) => {
    const nextPart = timePartInput(rawValue, startsNewEntry.current[index])
    if (nextPart) startsNewEntry.current[index] = false
    const field = index === 0 ? 'hours' : 'minutes'
    const nextParts = { ...partsRef.current, [field]: nextPart }
    updateParts(nextParts)
    if (nextPart.length !== 2) {
      requestAnimationFrame(() => inputs.current[index]?.setSelectionRange(nextPart.length, nextPart.length))
      return
    }
    const next = toTwentyFourHourTime(nextParts.hours, nextParts.minutes, nextParts.period)
    if (!next) {
      updateParts(toTwelveHourTime(value))
      return
    }
    onChange(next)
    if (index === 1) onComplete?.(next)
    inputs.current[index + 1]?.focus()
  }

  const handleKey = (event, index) => {
    const part = index === 0 ? partsRef.current.hours : partsRef.current.minutes
    if (event.key === 'Backspace' && !part && index > 0) {
      inputs.current[index - 1]?.focus()
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      inputs.current[Math.max(0, index - 1)]?.focus()
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      inputs.current[Math.min(1, index + 1)]?.focus()
    }
  }

  const commitPartial = (index) => {
    const part = index === 0 ? partsRef.current.hours : partsRef.current.minutes
    if (!part || part.length === 2) return
    enterPart(index, part.padStart(2, '0'))
  }

  const handlePaste = (event) => {
    const time = parsePastedTime(event.clipboardData.getData('text'))
    if (!time) return
    event.preventDefault()
    onChange(time)
    onComplete?.(time)
    updateParts(toTwelveHourTime(time))
    inputs.current[1]?.focus()
  }

  const selectPeriod = (period) => {
    const nextParts = { ...partsRef.current, period }
    updateParts(nextParts)
    const next = toTwentyFourHourTime(nextParts.hours, nextParts.minutes, period)
    if (!next) return
    onChange(next)
    onComplete?.(next)
  }

  const completeEdit = (event) => {
    if (event.currentTarget.contains(event.relatedTarget)) return
    const current = partsRef.current
    const next = toTwentyFourHourTime(current.hours, current.minutes, current.period)
    if (next) onComplete?.(next)
  }

  return (
    <div className={`time-input ${compact ? 'compact' : ''}`} role="group" aria-label={label}
      onBlur={completeEdit} onPaste={handlePaste}>
      {[0, 1].map((index) => (
        <span key={index}>
          {index === 1 && <b aria-hidden="true">:</b>}
          <input ref={(element) => { inputs.current[index] = element }} value={index === 0 ? parts.hours : parts.minutes}
            inputMode="numeric" pattern="[0-9]*" maxLength="2" aria-label={`${label}, ${index === 0 ? 'hours' : 'minutes'}`}
            onFocus={(event) => {
              startsNewEntry.current[index] = true
              event.target.select()
            }} onChange={(event) => enterPart(index, event.target.value)}
            onKeyDown={(event) => handleKey(event, index)} onBlur={() => commitPartial(index)} />
        </span>
      ))}
      <button type="button" className="time-period-toggle"
        role="switch" aria-checked={parts.period === 'PM'}
        aria-label={`${label}, ${parts.period}. Toggle AM or PM`}
        onClick={() => selectPeriod(parts.period === 'AM' ? 'PM' : 'AM')}>
        <span className={parts.period === 'AM' ? 'active' : ''}>AM</span>
        <span className={parts.period === 'PM' ? 'active' : ''}>PM</span>
      </button>
    </div>
  )
}

function DoseTimeEditor({ dose, onChange, readOnly = false }) {
  const takenAt = dose.record?.takenAt ? new Date(dose.record.takenAt) : null
  const displayedAt = takenAt && !Number.isNaN(takenAt.getTime()) ? takenAt : dose.scheduledAt
  const initial = displayedAt.toTimeString().slice(0, 5)
  const [value, setValue] = useState(initial)
  const committed = useRef(initial)
  useEffect(() => {
    committed.current = initial
    setValue(initial)
  }, [initial])
  const save = (time) => {
    if (time === committed.current) return
    committed.current = time
    onChange(dose, time)
  }
  return (
    <div className="dose-time-editor" onClick={(event) => event.stopPropagation()}>
      {readOnly
        ? <span className="dose-time-readonly">{formatTime(value)}</span>
        : <TimeInput compact label={`${takenAt ? 'Taken' : 'Scheduled'} time for ${dose.medication.name}`} value={value}
            onChange={setValue} onComplete={save} />}
    </div>
  )
}

function ProgressRing({ next, now }) {
  const R = 46
  const C = 2 * Math.PI * R
  const previous = next ? getDoseWindow(next.medication, next.scheduledAt).previous : now
  const duration = Math.max(1, next?.scheduledAt - previous)
  const progress = next ? Math.min(1, Math.max(0, (now - previous) / duration)) : 1
  const color = !next ? '#1DB954' : progress < .25 ? '#ef4444' : progress < .5 ? '#f97316' : progress < .75 ? 'var(--gold)' : '#9ACD32'
  const angle = (-90 + 360 * progress) * Math.PI / 180
  const sx = 60 + R * Math.cos(angle)
  const sy = 60 + R * Math.sin(angle)
  const countdown = next ? formatRelative(next.scheduledAt, now) : 'All done'
  const countdownSize = countdown.length > 14 ? 'extra-long' : countdown.length > 7 ? 'long' : ''
  return (
    <div className="ring">
      <svg viewBox="0 0 120 120" className="ring-svg">
        <circle className="ring-track" cx="60" cy="60" r={R} />
        <circle className="ring-fill" cx="60" cy="60" r={R} stroke={color}
          strokeDasharray={C} strokeDashoffset={C * (1 - progress)} />
        {next && progress > .001 && progress < .999 && (
          <g className="spark" transform={`translate(${sx} ${sy})`}>
            <circle r="4.5" className="spark-glow" fill={color} />
            <circle r="2.4" className="spark-core" />
          </g>
        )}
      </svg>
      <div className="ring-center">
        <strong className={countdownSize}>{countdown}</strong>
        <span>{next ? 'until next dose' : 'for today'}</span>
      </div>
    </div>
  )
}

function MedicationSearch({ onSelect }) {
  const [query, setQuery] = useState('')
  const [state, setState] = useState({ status: 'idle', results: [], error: '' })
  const skipNextSearch = useRef(false)

  useEffect(() => {
    const term = query.trim()
    if (skipNextSearch.current) {
      skipNextSearch.current = false
      return
    }
    if (term.length < 2) {
      setState({ status: 'idle', results: [], error: '' })
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setState({ status: 'loading', results: [], error: '' })
      try {
        const results = await searchOpenFda(term, controller.signal)
        setState({ status: 'complete', results, error: results.length ? '' : 'No matches.' })
      } catch {
        if (!controller.signal.aborted) {
          setState({ status: 'error', results: [], error: 'Search unavailable.' })
        }
      }
    }, 350)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  return (
    <div className="fda-search">
      <span className="field-label">Search OpenFDA</span>
      <div className="search-row">
        <input value={query} placeholder="Brand or generic name" role="combobox"
          aria-autocomplete="list" aria-expanded={state.results.length > 0} aria-controls="fda-search-results"
          onChange={(event) => setQuery(event.target.value)} />
        {state.status === 'loading' && <Spinner className="search-spinner" size="tiny" aria-label="Searching OpenFDA" />}
      </div>
      {state.error && <span className="field-message">{state.error}</span>}
      {state.results.length > 0 && <div className="search-results" id="fda-search-results" role="listbox">
        {state.results.map((result) => (
          <button type="button" role="option" aria-selected="false" key={result.id} onClick={() => { onSelect(result); skipNextSearch.current = true; setState({ status: 'idle', results: [], error: '' }); setQuery(result.name) }}>
            <strong>{result.name}</strong>
            <span>{[result.genericName !== result.name && result.genericName, result.dose, result.form].filter(Boolean).join(' · ')}</span>
            {result.manufacturer && <small>{result.manufacturer}</small>}
          </button>
        ))}
      </div>}
      <small className="fda-disclaimer">FDA label data may be incomplete. Confirm details with the medication label or prescriber.</small>
    </div>
  )
}

function MedicationForm({ initial, onSave, onClose }) {
  const [stage, setStage] = useState(initial ? 'details' : 'source')
  const [form, setForm] = useState(() => {
    if (!initial) return { ...emptyForm }
    const storedScheduleType = initial.schedule?.type ?? 'daily'
    const scheduleType = storedScheduleType === 'day-interval' ? 'weekly' : storedScheduleType
    const intervalHours = initial.schedule?.intervalHours ?? 12
    const storedAdvanceMinutes = reminderOffsets(initial.notifications)
    const advanceMinutes = storedAdvanceMinutes.length ? storedAdvanceMinutes : [0]
    const customReminder = advanceMinutes.find((value) => !REMINDER_PRESET_VALUES.includes(value)) ?? null
    const customNotifyUnit = customReminder != null && customReminder >= 60 && customReminder % 60 === 0 ? 'hours' : 'minutes'
    return {
      ...emptyForm,
      name: initial.name, dose: initial.dose, notes: initial.notes,
      times: scheduleType === 'interval' ? wakingHourSchedule(intervalHours) : initial.times,
      scheduleType,
      intervalHours,
      weeklyMode: storedScheduleType === 'weekly' ? 'weekdays' : 'interval',
      intervalDays: initial.schedule?.intervalDays ?? 7,
      weekdays: initial.schedule?.weekdays?.length ? initial.schedule.weekdays : [1],
      scheduleAnchorAt: initial.schedule?.anchorAt ?? null,
      scheduleChanges: initial.schedule?.changes ?? [],
      hasStartDate: Boolean(initial.schedule?.startDate),
      startDate: initial.schedule?.startDate ?? '',
      inventoryRemaining: initial.inventory?.remaining == null ? '' : inventoryInteger(initial.inventory.remaining),
      inventoryUnit: initial.inventory?.unit ?? 'doses',
      refillAt: inventoryInteger(initial.inventory?.refillAt),
      notificationsEnabled: initial.notifications?.enabled ?? true,
      notifyMinutesBefore: advanceMinutes,
      reminderTiming: customReminder != null ? 'custom' : 'preset',
      customReminderMinutes: customReminder,
      customNotifyAmount: customReminder != null ? customReminder / (customNotifyUnit === 'hours' ? 60 : 1) : 2,
      customNotifyUnit: customReminder != null ? customNotifyUnit : 'hours',
      trackInjectionSite: initial.trackInjectionSite ?? false,
    }
  })
  const [scan, setScan] = useState({ status: 'idle', progress: 0, preview: '', confidence: 0, error: '' })
  const [showPhotoChoices, setShowPhotoChoices] = useState(false)
  const customReminderSelected = form.reminderTiming === 'custom'
  const customReminderInputRef = useRef(null)
  const activateCustomReminder = () => {
    setForm((current) => ({
      ...current,
      reminderTiming: 'custom',
      customReminderMinutes: Math.max(1, Number(current.customNotifyAmount) || 2) * (current.customNotifyUnit === 'hours' ? 60 : 1),
      notifyMinutesBefore: reminderOffsets({
        advanceMinutes: [
          ...current.notifyMinutesBefore,
          Math.max(1, Number(current.customNotifyAmount) || 2) * (current.customNotifyUnit === 'hours' ? 60 : 1),
        ],
      }),
    }))
    requestAnimationFrame(() => {
      customReminderInputRef.current?.focus()
      customReminderInputRef.current?.select()
    })
  }
  const setCustomReminder = (amount, unit) => {
    setForm((current) => {
      const minutes = Math.max(1, Number(amount) || 1) * (unit === 'hours' ? 60 : 1)
      return {
        ...current,
        customNotifyAmount: amount,
        customNotifyUnit: unit,
        customReminderMinutes: minutes,
        notifyMinutesBefore: reminderOffsets({
          advanceMinutes: [
            ...current.notifyMinutesBefore.filter((value) => value !== current.customReminderMinutes),
            minutes,
          ],
        }),
      }
    })
  }
  const removeCustomReminder = () => {
    setForm((current) => {
      const remaining = current.notifyMinutesBefore.filter((value) => value !== current.customReminderMinutes)
      return {
        ...current,
        reminderTiming: 'preset',
        notifyMinutesBefore: remaining.length ? remaining : [0],
        customReminderMinutes: null,
      }
    })
  }
  const toggleReminder = (value) => {
    setForm((current) => {
      const selected = current.notifyMinutesBefore.includes(value)
        ? current.notifyMinutesBefore.filter((option) => option !== value)
        : reminderOffsets({ advanceMinutes: [...current.notifyMinutesBefore, value] })
      return { ...current, notifyMinutesBefore: selected.length ? selected : [0] }
    })
  }

  useEffect(() => () => {
    if (scan.preview) URL.revokeObjectURL(scan.preview)
  }, [scan.preview])

  const updateTime = (index, value) => setForm((current) => ({
    ...current, times: current.times.map((time, i) => i === index ? value : time),
  }))
  const removeTime = (index) => setForm((current) => ({
    ...current, times: current.times.filter((_, i) => i !== index),
  }))
  const submit = (event) => {
    event.preventDefault()
    if (!form.name.trim() || !form.times.length) return
    const startAnchor = form.hasStartDate ? localScheduleAnchor(form.startDate, form.times[0]) : null
    const selectedReminderOffsets = reminderOffsets({ advanceMinutes: form.notifyMinutesBefore })
    onSave({
      name: form.name.trim(), dose: form.dose.trim(), notes: form.notes.trim(), times: [...form.times].sort(),
      inventory: {
        remaining: form.inventoryRemaining === '' ? null : inventoryInteger(form.inventoryRemaining),
        unit: form.inventoryUnit,
        perDose: 1,
        refillAt: inventoryInteger(form.refillAt),
      },
      notifications: {
        enabled: form.notificationsEnabled,
        advanceMinutes: form.notificationsEnabled && !selectedReminderOffsets.length ? [0] : selectedReminderOffsets,
      },
      schedule: {
        type: form.scheduleType === 'weekly' && form.weeklyMode === 'interval' ? 'day-interval' : form.scheduleType,
        intervalHours: form.scheduleType === 'interval'
          ? Math.min(12, Math.max(3, Number(form.intervalHours) || 3))
          : Math.max(1, Number(form.intervalHours) || 1),
        intervalDays: Math.min(30, Math.max(2, Number(form.intervalDays) || 7)),
        weekdays: form.weekdays,
        startDate: form.hasStartDate ? form.startDate : null,
        anchorAt: form.scheduleType === 'interval'
          ? form.scheduleAnchorAt
          : form.scheduleType === 'weekly' && form.weeklyMode === 'interval'
            ? startAnchor?.toISOString() || form.scheduleAnchorAt || new Date().toISOString()
            : null,
        changes: form.scheduleChanges,
      },
      trackInjectionSite: form.trackInjectionSite,
    })
  }
  const scanLabel = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    setShowPhotoChoices(false)
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setScan({ status: 'error', progress: 0, preview: '', confidence: 0, error: 'Choose a photo of the medication label.' })
      return
    }
    if (file.size > 15 * 1024 * 1024) {
      setScan({ status: 'error', progress: 0, preview: '', confidence: 0, error: 'Choose an image smaller than 15 MB.' })
      return
    }
    const preview = URL.createObjectURL(file)
    setScan({ status: 'scanning', progress: 0, preview, confidence: 0, error: '' })
    try {
      const result = await scanMedicationLabel(file, (progress) => {
        setScan((current) => ({ ...current, progress }))
      })
      setForm((current) => ({
        ...current,
        name: result.name || current.name,
        dose: result.dose || current.dose,
      }))
      setScan({
        status: result.name || result.dose ? 'complete' : 'error',
        progress: 100,
        preview,
        confidence: result.confidence,
        error: result.name || result.dose ? '' : 'No medication details were found. Try a closer, well-lit photo.',
      })
      if (result.name || result.dose) setStage('details')
    } catch {
      setScan({ status: 'error', progress: 0, preview, confidence: 0, error: 'The label could not be read. Check your connection and try again.' })
    }
  }

  return (
    <div className="modal-backdrop form-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal medication-form" onSubmit={submit}>
        <div className="modal-head">
          <div>{initial && <span className="eyebrow">Medication</span>}<h2 className="modal-title">{initial ? 'Edit medication' : 'Add medication'}</h2></div>
          <SmallIconButton label="Close" name="close" onClick={onClose} />
        </div>
        <div className="modal-scroll">
          {stage === 'source' ? (
            <section className="form-section source-section">
              <div className={`label-scanner ${scan.status}`}>
                <div className="scan-copy">
                  <strong>{scan.status === 'scanning' ? `Reading label… ${scan.progress}%` : scan.status === 'complete' ? 'Label read' : 'Medication label'}</strong>
                  <span>{scan.error || (scan.status === 'complete' ? `OCR confidence ${scan.confidence}%. Review the details below.` : 'Use a clear, well-lit photo. The image stays on this device.')}</span>
                  {scan.status === 'scanning' && <span className="scan-progress"><i style={{ width: `${scan.progress}%` }} /></span>}
                </div>
                <button type="button" className="scan-btn" aria-label="Add medication label photo" title="Add medication label photo"
                  disabled={scan.status === 'scanning'} onClick={() => setShowPhotoChoices((visible) => !visible)}>
                  <Icon name="camera" size={20} />
                </button>
                <input id="medication-camera-input" className="source-photo-input" type="file" accept="image/*" capture="environment" onChange={scanLabel} />
                <input id="medication-photo-input" className="source-photo-input" type="file" accept="image/*" onChange={scanLabel} />
                {showPhotoChoices && <div className="photo-choice-menu" role="dialog" aria-label="Choose medication label photo">
                  <label className="photo-choice-option" htmlFor="medication-camera-input">Take a picture</label>
                  <label className="photo-choice-option" htmlFor="medication-photo-input">Use existing photo</label>
                </div>}
              </div>
              <div className="source-divider"><span>or</span></div>
              <MedicationSearch onSelect={(result) => {
                setForm((current) => ({
                  ...current,
                  name: result.name || current.name,
                  dose: result.dose || current.dose,
                  notes: result.notes || current.notes,
                  trackInjectionSite: result.route?.toLowerCase().includes('intramuscular') || current.trackInjectionSite,
                  scheduleType: result.scheduleRecommendation?.type || current.scheduleType,
                  weeklyMode: result.scheduleRecommendation?.type === 'weekly' ? 'weekdays' : current.weeklyMode,
                  intervalHours: result.scheduleRecommendation?.intervalHours || current.intervalHours,
                  weekdays: result.scheduleRecommendation?.weekdays?.length ? result.scheduleRecommendation.weekdays : current.weekdays,
                  times: result.scheduleRecommendation
                    ? result.scheduleRecommendation.type === 'interval'
                      ? wakingHourSchedule(result.scheduleRecommendation.intervalHours)
                      : result.scheduleRecommendation.times
                    : current.times,
                  scheduleAnchorAt: result.scheduleRecommendation ? null : current.scheduleAnchorAt,
                }))
                setStage('details')
              }} />
              <button type="button" className="secondary-btn wide manual-entry-btn" onClick={() => setStage('details')}>Enter details manually</button>
            </section>
          ) : <>
          <fieldset className="form-section">
            <div className="form-section-head"><div><h3>Details</h3></div></div>
            <div className="form-grid detail-fields">
              <label>Drug name<input required value={form.name} placeholder="e.g. Metformin"
                onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
              <label>Dose <span className="optional">optional</span><input value={form.dose} placeholder="e.g. 500 mg"
                onChange={(event) => setForm({ ...form, dose: event.target.value })} /></label>
            </div>
            <div className="toggle-row detail-injection-toggle"><span><strong>Track injection site</strong><small>Record the thigh section used.</small></span>
              <Switch className="fluent-switch" checked={form.trackInjectionSite} onChange={(_, data) => setForm({ ...form, trackInjectionSite: data.checked })} aria-label="Track injection site" /></div>
          </fieldset>

          <fieldset className="form-section">
            <div className="form-section-head"><div><h3>Schedule</h3></div></div>
            <span className="field-label">Frequency</span>
            <div className="frequency-picker" role="group" aria-label="Medication frequency">
              {[['interval', 'Hourly'], ['daily', 'Daily'], ['weekly', 'Weekly']].map(([value, label]) => (
                <button type="button" key={value} className={form.scheduleType === value ? 'active' : ''} aria-pressed={form.scheduleType === value}
                  onClick={() => setForm({
                    ...form,
                    scheduleType: value,
                    weeklyMode: value === 'weekly' ? 'interval' : form.weeklyMode,
                    scheduleAnchorAt: null,
                    times: timesForScheduleType(form.scheduleType, value, form.times, form.intervalHours),
                  })}>{label}</button>
              ))}
            </div>
            {form.scheduleType === 'interval' && <label>Hours between doses<input type="number" min="3" max="12" inputMode="numeric" value={form.intervalHours}
              onFocus={(event) => event.target.select()}
              onChange={(event) => {
                const raw = event.target.value
                const hours = Number(raw)
                setForm({
                  ...form,
                  intervalHours: raw,
                  times: hours >= 3 && hours <= 12 ? wakingHourSchedule(hours) : form.times,
                  scheduleAnchorAt: null,
                })
              }}
              onBlur={() => {
                const hours = Math.min(12, Math.max(3, Number(form.intervalHours) || 3))
                setForm({ ...form, intervalHours: hours, times: wakingHourSchedule(hours), scheduleAnchorAt: null })
              }} /></label>}
            {form.scheduleType === 'weekly' && <>
              <div className="weekly-choice-picker" role="group" aria-label="Weekly schedule type">
                <div className={`every-days-option ${form.weeklyMode === 'interval' ? 'active' : ''}`}>
                  <button type="button" onClick={() => setForm({ ...form, weeklyMode: 'interval' })}>Every</button>
                  <input className="inline-days-input" type="number" min="2" max="30" inputMode="numeric"
                    aria-label="Number of days between doses" value={form.intervalDays}
                    onFocus={(event) => { event.target.select(); setForm({ ...form, weeklyMode: 'interval' }) }}
                    onChange={(event) => setForm({ ...form, weeklyMode: 'interval', intervalDays: event.target.value, scheduleAnchorAt: null })}
                    onBlur={() => setForm({ ...form, intervalDays: Math.min(30, Math.max(2, Number(form.intervalDays) || 7)) })} />
                  <button type="button" onClick={() => setForm({ ...form, weeklyMode: 'interval' })}>days</button>
                </div>
                <span>or</span>
                <button type="button" className={form.weeklyMode === 'weekdays' ? 'active' : ''} aria-pressed={form.weeklyMode === 'weekdays'}
                  onClick={() => setForm({ ...form, weeklyMode: 'weekdays', scheduleAnchorAt: null })}>Specific days</button>
              </div>
              {form.weeklyMode === 'weekdays' ? <div className="weekday-picker" role="group" aria-label="Dose weekdays">
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((label, day) => <button type="button" key={day}
                  className={form.weekdays.includes(day) ? 'active' : ''} aria-pressed={form.weekdays.includes(day)}
                  aria-label={['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day]}
                  onClick={() => setForm((current) => ({
                    ...current,
                    weekdays: current.weekdays.includes(day)
                      ? current.weekdays.length > 1 ? current.weekdays.filter((value) => value !== day) : current.weekdays
                      : [...current.weekdays, day].sort(),
                  }))}>{label}</button>)}
              </div> : null}
            </>}
            {form.scheduleType === 'interval' ? (
              <div className="time-list interval-time-list" aria-label="Suggested waking-hour schedule">
                {form.times.map((time, index) => <TimeInput key={index} label={`Suggested dose time ${index + 1}`} value={time} onChange={(value) => updateTime(index, value)} />)}
              </div>
            ) : <div className="time-list">
              {(form.scheduleType === 'daily' ? form.times : form.times.slice(0, 1)).map((time, index) => (
                <div className="time-row" key={index}>
                  <TimeInput label={`Dose time ${index + 1}`} value={time} onChange={(value) => updateTime(index, value)} />
                  {form.scheduleType === 'daily' && form.times.length > 1 && <SmallIconButton label={`Remove ${time}`} name="close" className="small danger" onClick={() => removeTime(index)} />}
                </div>
              ))}
            </div>}
            {form.scheduleType === 'daily' && <SmallIconButton label="Add time" name="plus" className="add-time-btn" onClick={() => setForm({ ...form, times: [...form.times, '12:00'] })} />}
            <div className="start-date-options" role="radiogroup" aria-label="Medication start date">
              <label><input type="radio" name="medication-start-date" checked={form.hasStartDate}
                onClick={(event) => {
                  if (!form.hasStartDate) return
                  event.preventDefault()
                  setForm({ ...form, hasStartDate: false, startDate: '' })
                }}
                onChange={(event) => {
                  if (event.target.checked) setForm({ ...form, hasStartDate: true })
                }} />Add a start date</label>
            </div>
            {form.hasStartDate && <label className="start-date-field">Start date
              <input type="date" required value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value, scheduleAnchorAt: null })} />
            </label>}
          </fieldset>

          <fieldset className="form-section">
            <div className="form-section-head"><div><h3>Instructions</h3></div></div>
            <label className="sr-only" htmlFor="medication-notes">Instructions</label>
            <textarea id="medication-notes" rows="3" value={form.notes} placeholder="e.g. Take with food"
              onChange={(event) => setForm({ ...form, notes: event.target.value })} />
          </fieldset>

          <details className="form-section collapsible-section">
            <summary><span className="summary-title">Inventory</span><span className="summary-end"><small>Optional</small><Icon name="chevron" size={20} /></span></summary>
            <div className="form-grid inventory-fields">
              <label>Amount remaining<input type="number" min="0" step="1" inputMode="numeric" value={form.inventoryRemaining} placeholder="30"
                onChange={(event) => setForm({ ...form, inventoryRemaining: event.target.value })}
                onBlur={() => setForm((current) => ({ ...current, inventoryRemaining: current.inventoryRemaining === '' ? '' : inventoryInteger(current.inventoryRemaining) }))} /></label>
              <label>Unit<select value={form.inventoryUnit} onChange={(event) => setForm({ ...form, inventoryUnit: event.target.value })}>
                <option value="doses">doses</option><option value="tablets">tablets</option><option value="capsules">capsules</option><option value="mL">mL</option><option value="vials">vials</option>
              </select></label>
              <label>Low-stock level<input type="number" min="0" step="1" inputMode="numeric" value={form.refillAt}
                onChange={(event) => setForm({ ...form, refillAt: event.target.value })}
                onBlur={() => setForm((current) => ({ ...current, refillAt: inventoryInteger(current.refillAt) }))} /></label>
            </div>
          </details>

          <fieldset className="form-section settings-fieldset">
            <div className="form-section-head"><div><h3>Reminders</h3></div></div>
            <div className="toggle-row"><span><strong>Dose reminders</strong><small>Notify from the medication schedule.</small></span>
              <Switch className="fluent-switch" checked={form.notificationsEnabled} onChange={(_, data) => setForm({ ...form, notificationsEnabled: data.checked })} aria-label="Dose reminders" /></div>
            {form.notificationsEnabled && <div className="reminder-timing">
              <span className="field-label">Reminder times <small>Select all that apply</small></span>
              <div className="reminder-option-grid" role="group" aria-label="Reminder times">
                {REMINDER_PRESETS.map(({ value, label }) => <button type="button" key={value}
                  className={form.notifyMinutesBefore.includes(value) ? 'active' : ''}
                  aria-pressed={form.notifyMinutesBefore.includes(value)}
                  onClick={() => toggleReminder(value)}>{label}</button>)}
                {customReminderSelected ? <div className="custom-reminder-control">
                  <input ref={customReminderInputRef} className="custom-reminder-input" type="number"
                    min="1" max={form.customNotifyUnit === 'hours' ? '168' : '10080'} inputMode="numeric"
                    aria-label={`Custom reminder amount in ${form.customNotifyUnit}`} value={form.customNotifyAmount}
                    onFocus={(event) => event.target.select()}
                    onChange={(event) => setCustomReminder(event.target.value, form.customNotifyUnit)}
                    onBlur={() => setCustomReminder(Math.max(1, Number(form.customNotifyAmount) || 1), form.customNotifyUnit)} />
                  <SmallIconButton label="Remove custom reminder" name="close" className="small" onClick={removeCustomReminder} />
                </div> : <button type="button" onClick={activateCustomReminder}>Custom</button>}
              </div>
              {customReminderSelected && <div className="custom-unit-picker" role="group" aria-label="Custom reminder unit">
                  {['minutes', 'hours'].map((unit) => <button type="button" key={unit}
                    className={form.customNotifyUnit === unit ? 'active' : ''} aria-pressed={form.customNotifyUnit === unit}
                    onClick={() => setCustomReminder(Math.max(1, Number(form.customNotifyAmount) || 1), unit)}>
                    {unit === 'minutes' ? 'Minutes' : 'Hours'}</button>)}
              </div>}
              {!form.notifyMinutesBefore.length && <span className="field-message">Select at least one reminder time.</span>}
            </div>}
          </fieldset>
          </>}
        </div>
        {stage === 'details' && <div className="modal-footer">
          <SmallIconButton label="Cancel" name="close" className="modal-cancel" onClick={onClose} />
          <SmallIconButton label={initial ? 'Save changes' : 'Add medication'} name="save" size={24} className="modal-save" type="submit" />
        </div>}
      </form>
    </div>
  )
}

function DoseCard({ dose, onTaken, onSkip, onUndo, onTimeChange, onOpen }) {
  const now = new Date()
  const isSkipped = dose.record?.status === 'skipped'
  const isTaken = Boolean(dose.record) && !isSkipped
  const isMissed = !dose.record && now - dose.scheduledAt > 30 * 60 * 1000
  const status = isSkipped ? 'skipped' : isTaken ? dose.record.status : isMissed ? 'missed' : dose.scheduledAt < now ? 'due' : 'upcoming'
  const [dragX, setDragX] = useState(0)
  const gesture = useRef(null)
  const rowRef = useRef(null)
  const moved = useRef(false)
  const { canEdit, canViewHistory } = medicationPermissions(dose.medication)
  const canRecord = canEdit && canViewHistory
  const readOnlyToggleClass = isSkipped
    ? 'skipped'
    : isTaken
      ? 'complete'
      : isMissed
        ? 'overdue'
        : ''
  const width = () => rowRef.current?.offsetWidth || 320

  const startSwipe = (event) => {
    if (dose.record || !canRecord) return
    const touch = event.touches[0]
    gesture.current = { x: touch.clientX, y: touch.clientY, horizontal: null }
    moved.current = false
  }

  const moveSwipe = (event) => {
    if (!gesture.current) return
    const touch = event.touches[0]
    const dx = touch.clientX - gesture.current.x
    const dy = touch.clientY - gesture.current.y
    if (gesture.current.horizontal == null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      gesture.current.horizontal = Math.abs(dx) > Math.abs(dy) * 1.4
      if (!gesture.current.horizontal) {
        gesture.current = null
        return
      }
    }
    event.preventDefault()
    moved.current = true
    const cardWidth = width()
    let distance = Math.max(0, -dx)
    const knee = cardWidth * .25
    if (distance > knee) distance = knee + (distance - knee) * 2.5
    setDragX(-Math.min(cardWidth, distance))
  }

  const endSwipe = () => {
    if (!gesture.current) return
    gesture.current = null
    if (-dragX >= width() * .9) {
      setDragX(-width())
      onSkip(dose)
      setTimeout(() => {
        setDragX(0)
        moved.current = false
      }, 200)
      return
    }
    setDragX(0)
    setTimeout(() => { moved.current = false }, 0)
  }

  const skipProgress = Math.max(0, Math.min(1, -dragX / width()))
  return (
    <div className="dose-swipe-wrap" ref={rowRef}>
      {canRecord && <div className="dose-skip-fill" style={{ opacity: Math.pow(skipProgress, 4) }}>
        <span>Skip</span><Icon name="close" size={22} />
      </div>}
      <div className={`dose-row ${status} clickable`} role="button" tabIndex="0"
        style={{ transform: `translateX(${dragX}px)`, transition: dragX ? 'none' : 'transform .2s ease' }}
        aria-label={`View ${dose.medication.name} details`}
        onClick={() => { if (!moved.current) onOpen(dose.medication) }}
        onTouchStart={startSwipe} onTouchMove={moveSwipe} onTouchEnd={endSwipe} onTouchCancel={endSwipe}
        onKeyDown={(event) => { if (event.currentTarget === event.target && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen(dose.medication) } }}>
        <div className="dose-time-column">
          {isTaken && <span className="dose-time-label">Taken at:</span>}
          <DoseTimeEditor dose={dose} onChange={onTimeChange} readOnly={!canEdit} />
        </div>
        <div className="dose-dot"><span /></div>
        <div className="dose-info">
          <strong>{dose.medication.name}</strong>
          {isSkipped && <span className="skipped-at">Skipped {new Date(dose.record.skippedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
          <span>{dose.medication.dose || 'Dose not set'} · {frequencyLabel(dose.medication)}</span>
        </div>
        <div className="dose-action-column">
          {!canRecord ? (
            <>
              <CheckCircleButton className={readOnlyToggleClass}
                label={`${isTaken ? 'Taken' : isSkipped ? 'Skipped' : 'Not taken'}, read only`}
                complete={isTaken} disabled
                icon={isSkipped ? <Icon name="close" size={20} /> : undefined} />
              <span className="read-only-label">Read only</span>
            </>
          ) : isSkipped ? (
            <CheckCircleButton className="skipped" label="Undo skip"
              onChange={() => onUndo(dose)}
              icon={<Icon name="close" size={20} />} />
          ) : isTaken ? (
            <CheckCircleButton complete label="Undo taken"
              onChange={() => onUndo(dose)} />
          ) : (
            <CheckCircleButton className={isMissed ? 'overdue' : ''} label="Mark taken"
              onChange={() => onTaken(dose)} />
          )}
        </div>
      </div>
    </div>
  )
}

const injectionSites = [
  { id: 'left-upper', label: 'Left upper thigh', side: 'left', section: 'upper' },
  { id: 'left-lower', label: 'Left lower thigh', side: 'left', section: 'lower' },
  { id: 'right-upper', label: 'Right upper thigh', side: 'right', section: 'upper' },
  { id: 'right-lower', label: 'Right lower thigh', side: 'right', section: 'lower' },
]

function SharingModal({ sharing, onClose }) {
  const [username, setUsername] = useState('')
  const [role, setRole] = useState('viewer')
  const [canViewHistory, setCanViewHistory] = useState(false)
  const [feedback, setFeedback] = useState('')
  const permissions = { role, canViewHistory }
  const busy = sharing.status === 'busy' || sharing.status === 'loading'

  const submitUsername = async (event) => {
    event.preventDefault()
    if (!username.trim()) return
    try {
      await sharing.inviteUsername(username.trim(), permissions)
      setUsername('')
      setFeedback('Invitation created if that account is available.')
    } catch {
      // Stable feedback is rendered in the modal.
    }
  }
  const createLink = async () => {
    try {
      await sharing.createLink(permissions)
      setFeedback('Invitation link created.')
    } catch {
      // Stable feedback is rendered in the modal.
    }
  }
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(sharing.link)
      setFeedback('Invitation link copied.')
    } catch {
      // The selectable link remains available when clipboard access is denied.
    }
  }
  const revokeMember = async (userId) => {
    try {
      await sharing.revokeMember(userId)
      setFeedback('Access revoked.')
    } catch {
      // Stable feedback is rendered in the modal.
    }
  }
  const revokeInvitation = async (id) => {
    try {
      await sharing.revokeInvitation(id)
      setFeedback('Invitation revoked.')
    } catch {
      // Stable feedback is rendered in the modal.
    }
  }

  return (
    <div className="modal-backdrop sharing-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal sharing-modal" aria-labelledby="sharing-title" aria-busy={busy}>
        <div className="modal-head">
          <h2 className="modal-title" id="sharing-title">Medication list</h2>
          <SmallIconButton label="Close sharing" name="close" onClick={onClose} />
        </div>
        {sharing.error && <p className="sharing-feedback error" role="alert">{sharing.error}</p>}
        {feedback && !sharing.error && <p className="sharing-feedback" role="status">{feedback}</p>}
        <fieldset className="sharing-permissions">
          <legend>Invitation access</legend>
          <div className="sharing-role-picker">
            {['viewer', 'editor'].map((value) => <button type="button" key={value}
              className={role === value ? 'active' : ''} aria-pressed={role === value}
              onClick={() => setRole(value)}>{value === 'viewer' ? 'Viewer' : 'Editor'}</button>)}
          </div>
          <div className="sharing-history-options" role="radiogroup"
            aria-label="Medication list sharing access">
            <label>
              <input type="radio" name="history-access" checked={!canViewHistory}
                onChange={() => setCanViewHistory(false)} />
              <span>Share medication list</span>
            </label>
            <label>
              <input type="radio" name="history-access" checked={canViewHistory}
                onChange={() => setCanViewHistory(true)} />
              <span>Share medication list, dose history &amp; schedule</span>
            </label>
          </div>
        </fieldset>
        <form className="username-invite" onSubmit={submitUsername}>
          <label>Invite by exact username
            <div><input value={username} autoCapitalize="none" autoCorrect="off"
              placeholder="username" onChange={(event) => setUsername(event.target.value)} />
              <button className="secondary-action" disabled={busy || !username.trim()}>Invite</button></div>
          </label>
        </form>
        <div className="link-invite">
          <button type="button" className="secondary-action" disabled={busy} onClick={createLink}>
            Create invitation link
          </button>
          {sharing.link && <div className="generated-link">
            <input readOnly value={sharing.link} aria-label="Invitation link" onFocus={(event) => event.target.select()} />
            <SmallIconButton label="Copy invitation link" name="copy" onClick={copyLink} />
          </div>}
        </div>
        <section className="share-management" aria-labelledby="shared-access-title">
          <h3 id="shared-access-title">People with access</h3>
          {sharing.status === 'loading' && <p className="sharing-empty">Loading access…</p>}
          {sharing.status !== 'loading' && !sharing.members.length && <p className="sharing-empty">No one else has access.</p>}
          {sharing.members.map((member) => <div className="share-row" key={member.userId}>
            <Avatar user={member} size="medium" />
            <span><strong>@{member.username}</strong><small>{member.role === 'editor' ? 'Editor' : 'Viewer'} · {member.canViewHistory ? 'History visible' : 'History private'}</small></span>
            <SmallIconButton label={`Revoke access for ${member.username}`} name="trash" className="danger"
              disabled={busy} onClick={() => revokeMember(member.userId)} />
          </div>)}
          {sharing.invitations.length > 0 && <h3>Pending invitations</h3>}
          {sharing.invitations.map((invitation) => <div className="share-row" key={invitation.id}>
            <span><strong>{invitation.username ? `@${invitation.username}` : 'Invitation link'}</strong>
              <small>{invitation.permissions.role === 'editor' ? 'Editor' : 'Viewer'} · {invitation.permissions.canViewHistory ? 'History visible' : 'History private'}</small></span>
            <SmallIconButton label="Revoke invitation" name="trash" className="danger"
              disabled={busy} onClick={() => revokeInvitation(invitation.id)} />
          </div>)}
        </section>
      </section>
    </div>
  )
}

function InjectionSiteMap({ medication, onSelect, compact = false }) {
  const recentSites = getRecentInjectionSites(medication)
  return (
    <>
      {recentSites.length > 0 && <div className="site-legend">
        <span><i className="last-dose" />1 dose ago</span>
        {recentSites.length > 1 && <span><i className="two-doses-ago" />2 doses ago</span>}
      </div>}
      <div className={`thigh-map ${compact ? 'compact' : ''}`} role="group" aria-label="Injection location">
        {['left', 'right'].map((side) => (
          <div className="thigh" key={side}>
            <span>{side === 'left' ? 'Left thigh' : 'Right thigh'}</span>
            <div className="thigh-shape">
              {injectionSites.filter((site) => site.side === side).map((site) => (
                <button type="button" disabled={!onSelect} aria-label={site.label}
                  className={`${site.section} ${recentSites[0] === site.id ? 'last-dose' : ''} ${recentSites[1] === site.id ? 'two-doses-ago' : ''}`}
                  key={site.id} onClick={() => onSelect?.(site.id)}>
                  <span className="site-markers">
                    {recentSites[0] === site.id && <i className="last-dose" />}
                    {recentSites[1] === site.id && <i className="two-doses-ago" />}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

function MedicationDetails({ medication, now, onClose, onEdit, onAdjustInventory, onOverrideTakenHistory }) {
  const [pastMonths, setPastMonths] = useState(6)
  const [futureMonths, setFutureMonths] = useState(6)
  const [selectedDate, setSelectedDate] = useState(null)
  const [historyEdits, setHistoryEdits] = useState([])
  const [deletedRecordIds, setDeletedRecordIds] = useState([])
  const [newDose, setNewDose] = useState(null)
  const [futureDateWarning, setFutureDateWarning] = useState(false)
  const calendarScrollRef = useRef(null)
  const calendarLoad = useRef(null)
  const currentMonthKey = `${now.getFullYear()}-${now.getMonth()}`
  const permissions = medicationPermissions(medication)
  const next = permissions.canViewSchedule ? getNextDose([medication], now) : null
  const calendarMonths = permissions.canViewHistory
    ? medicationCalendarMonths(medication, now, { pastMonths, futureMonths })
    : []

  useEffect(() => {
    const container = calendarScrollRef.current
    const currentMonth = container?.querySelector(`[data-month="${currentMonthKey}"]`)
    if (container && currentMonth) container.scrollLeft = currentMonth.offsetLeft - container.offsetLeft
  }, [currentMonthKey, medication.id])

  useLayoutEffect(() => {
    const container = calendarScrollRef.current
    if (!container || !calendarLoad.current) return
    if (calendarLoad.current.side === 'past') {
      container.scrollLeft += container.scrollWidth - calendarLoad.current.scrollWidth
    }
    calendarLoad.current = null
  }, [futureMonths, pastMonths])

  const loadCalendarAtEdge = (event) => {
    const container = event.currentTarget
    if (calendarLoad.current) return
    if (container.scrollLeft <= 16) {
      calendarLoad.current = { side: 'past', scrollWidth: container.scrollWidth }
      setPastMonths((months) => months + 6)
    } else if (container.scrollWidth - container.clientWidth - container.scrollLeft <= 16) {
      calendarLoad.current = { side: 'future', scrollWidth: container.scrollWidth }
      setFutureMonths((months) => months + 6)
    }
  }

  const selectHistoryDate = (date, monthLabel) => {
    setSelectedDate({ ...date, monthLabel })
    setDeletedRecordIds([])
    setNewDose(null)
    setHistoryEdits(date.events.filter((event) => event.recordId && event.status !== 'missed' && event.status !== 'skipped').map((event) => {
      const takenAt = new Date(event.time)
      return {
        recordId: event.recordId,
        dateKey: date.dateKey,
        time: Number.isNaN(takenAt.getTime())
          ? '08:00'
          : `${String(takenAt.getHours()).padStart(2, '0')}:${String(takenAt.getMinutes()).padStart(2, '0')}`,
        injectionSite: event.injectionSite || '',
      }
    }))
  }

  const updateHistoryEdit = (recordId, changes) => {
    setHistoryEdits((edits) => edits.map((edit) => edit.recordId === recordId ? { ...edit, ...changes } : edit))
  }

  const startAddingDose = () => {
    setNewDose({
      dateKey: selectedDate.dateKey,
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      injectionSite: '',
      scheduledAt: selectedDate.events.find((event) => event.status === 'missed' || event.status === 'skipped')?.time || null,
    })
  }

  const closeHistoryDate = () => {
    setSelectedDate(null)
    setHistoryEdits([])
    setDeletedRecordIds([])
    setNewDose(null)
  }

  const saveHistoryEdits = () => {
    if ([...historyEdits, newDose].filter(Boolean).some((edit) => isFutureLocalDate(edit.dateKey, now))) {
      setFutureDateWarning(true)
      return
    }
    onOverrideTakenHistory(medication, historyEdits, deletedRecordIds, newDose)
    closeHistoryDate()
  }

  return (
    <div className="modal-backdrop details-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <article className="modal details-modal">
        <div className="medication-actions details-actions">
          {permissions.canEdit && <SmallIconButton label="Edit medication" name="edit" onClick={() => onEdit(medication)} />}
          <SmallIconButton label="Close" name="close" onClick={onClose} />
        </div>
        <div className="modal-head">
          <div>{medication.paused && <span className="eyebrow">Paused</span>}<h2 className="modal-title">{medication.name}</h2><p className="detail-dose">{medication.dose || 'Dose not set'}</p></div>
        </div>
        <div className="detail-list">
          <div><span>Schedule</span><strong>{permissions.canViewSchedule ? scheduleLabels(medication).join(' · ') : 'Not shared'}</strong></div>
          <div><span>Next dose</span><strong>{permissions.canViewSchedule ? medication.paused ? 'Paused' : next ? formatDateTime(next.scheduledAt) : '—' : 'Not shared'}</strong></div>
          <div className="detail-inventory"><span>Inventory</span>
            <strong>{medication.inventory?.remaining == null ? 'Not tracked' : `${inventoryInteger(medication.inventory.remaining)} ${medication.inventory.unit}`}</strong>
            {permissions.canEdit && <div className="detail-inventory-controls">
              <SmallIconButton label={`Decrease ${medication.name} inventory`} name="chevron-down" className="inventory-adjust"
                onClick={() => onAdjustInventory(medication, -1)} />
              <SmallIconButton label={`Increase ${medication.name} inventory`} name="chevron-up" className="inventory-adjust"
                onClick={() => onAdjustInventory(medication, 1)} />
            </div>}
          </div>
        </div>
        {medication.trackInjectionSite && <section className="detail-site-map">
          <InjectionSiteMap medication={medication} compact />
        </section>}
        {medication.notes && <section className="detail-instructions"><span>Instructions</span><p>{medication.notes}</p></section>}
        {permissions.canViewHistory && <section className="medication-calendar">
          <div className="calendar-heading">
            <span className="eyebrow">Dose history</span>
            <span className="calendar-guidance">
              <small>Current day is bolded.</small>
              <small>Scroll for past and future months</small>
            </span>
          </div>
          <div className="calendar-scroll" ref={calendarScrollRef} onScroll={loadCalendarAtEdge}>
            {calendarMonths.map((month) => (
              <div className="calendar-month" data-month={month.key} key={month.key}>
                <h4>{month.label}</h4>
                <div className="calendar-grid">
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => <span className="calendar-weekday" key={day}>{day.slice(0, 1)}</span>)}
                  {Array.from({ length: month.leadingDays }, (_, index) => <span className="calendar-blank" key={`blank-${index}`} />)}
                  {month.days.map((date) => {
                    const selected = selectedDate?.dateKey === date.dateKey
                    const future = isFutureLocalDate(date.dateKey, now)
                    const current = date.dateKey === localDateValue(now)
                    const label = `${month.label} ${date.day}${current ? ', current day' : ''}${date.count ? `, taken ${date.count} ${date.count === 1 ? 'time' : 'times'}` : ''}${date.missedCount ? `, missed ${date.missedCount}` : ''}`
                    return <div className={`calendar-day ${current ? 'current' : ''} ${date.count ? 'taken' : ''} ${date.missedCount ? 'missed' : ''}`} key={date.day}>
                      <button type="button" aria-label={label} aria-expanded={permissions.canEdit ? selected : undefined}
                        disabled={future || !permissions.canEdit}
                        onClick={() => selectHistoryDate(date, month.label)}>{date.day}</button>
                      {date.count > 1 && <small>{date.count} times</small>}
                      {date.count === 1 && date.injectionSites[0] && <small>{date.injectionSites[0]}</small>}
                    </div>
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>}
        {!permissions.canViewHistory && <section className="history-private" aria-label="Dose history access">
          <span className="eyebrow">Dose history</span>
          <p>The owner has kept dose history private.</p>
        </section>}
        {selectedDate && <div className="history-warning-backdrop" role="dialog" aria-modal="true"
          aria-labelledby="history-date-title" onMouseDown={(event) => event.target === event.currentTarget && closeHistoryDate()}>
          <div className="history-warning history-record-modal">
            <div className="history-time-head">
              <h3 className="modal-title" id="history-date-title">{formatLocalDateLong(selectedDate.dateKey)}</h3>
              <SmallIconButton label="Close date details" name="close" onClick={closeHistoryDate} />
            </div>
            <div className="history-record-list">
              {selectedDate.events.filter((event) => event.status === 'missed' || event.status === 'skipped').map((event, index) => (
                <span key={`${event.time}-${index}`}>Missed {new Date(event.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
              ))}
              {historyEdits.map((edit, index) => <fieldset className="history-dose-editor has-delete" key={edit.recordId}>
                <legend>{historyEdits.length > 1 ? `Taken dose ${index + 1}` : 'Taken dose'}</legend>
                <SmallIconButton label="Delete this dose" name="trash" className="danger history-delete"
                  onClick={() => {
                    setDeletedRecordIds((ids) => [...ids, edit.recordId])
                    setHistoryEdits((edits) => edits.filter((candidate) => candidate.recordId !== edit.recordId))
                  }} />
                <label>Taken date
                  <input type="date" value={edit.dateKey}
                    onChange={(event) => updateHistoryEdit(edit.recordId, { dateKey: event.target.value })} />
                </label>
                <div className="history-time-field">
                  <span>Taken time</span>
                  <TimeInput label="Taken time" value={edit.time}
                    onChange={(time) => updateHistoryEdit(edit.recordId, { time })} />
                </div>
                {medication.trackInjectionSite && <label>Injection site
                  <select value={edit.injectionSite}
                    onChange={(event) => updateHistoryEdit(edit.recordId, { injectionSite: event.target.value })}>
                    <option value="">Not recorded</option>
                    {injectionSites.map((site) => <option value={site.id} key={site.id}>{site.label} ({INJECTION_SITE_CODES[site.id]})</option>)}
                  </select>
                </label>}
              </fieldset>)}
              {deletedRecordIds.length > 0 && <span>{deletedRecordIds.length === 1 ? '1 dose will be deleted.' : `${deletedRecordIds.length} doses will be deleted.`}</span>}
              {!historyEdits.length && !deletedRecordIds.length && !newDose && <div className="history-add-prompt">
                <span>No dose is recorded for this date. Add one?</span>
                <SmallIconButton label="Add dose" name="plus" className="history-add-dose" onClick={startAddingDose} />
              </div>}
              {newDose && <fieldset className="history-dose-editor">
                <legend>Add dose</legend>
                <label>Taken date
                  <input type="date" value={newDose.dateKey}
                    onChange={(event) => setNewDose((dose) => ({ ...dose, dateKey: event.target.value }))} />
                </label>
                <div className="history-time-field">
                  <span>Taken time</span>
                  <TimeInput label="New dose taken time" value={newDose.time}
                    onChange={(time) => setNewDose((dose) => ({ ...dose, time }))} />
                </div>
                {medication.trackInjectionSite && <label>Injection site
                  <select value={newDose.injectionSite}
                    onChange={(event) => setNewDose((dose) => ({ ...dose, injectionSite: event.target.value }))}>
                    <option value="">Not recorded</option>
                    {injectionSites.map((site) => <option value={site.id} key={site.id}>{site.label} ({INJECTION_SITE_CODES[site.id]})</option>)}
                  </select>
                </label>}
              </fieldset>}
            </div>
            <div className="history-modal-actions">
              {!newDose && (historyEdits.length > 0 || deletedRecordIds.length > 0) && <SmallIconButton label="Add dose" name="plus" className="history-add-dose" onClick={startAddingDose} />}
              {(historyEdits.length > 0 || deletedRecordIds.length > 0 || newDose) && <SmallIconButton label="Save changes" name="save" className="history-save" onClick={saveHistoryEdits} />}
            </div>
          </div>
        </div>}
        {futureDateWarning && <div className="history-warning-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="future-date-warning">
          <div className="history-warning">
            <h3 className="modal-title" id="future-date-warning">Date not allowed</h3>
            <p>Taken dose cannot be a future date.</p>
            <button type="button" className="primary-btn" onClick={() => setFutureDateWarning(false)}>OK</button>
          </div>
        </div>}
      </article>
    </div>
  )
}

function InjectionSitePicker({ medication, onSelect, onClose }) {
  return (
    <div className="modal-backdrop">
      <div className="modal site-modal">
        <div className="modal-head">
          <h2 className="modal-title">Select injection site</h2>
          <SmallIconButton label="Close" name="close" onClick={onClose} />
        </div>
        <p className="site-instruction">Select the thigh section used for this dose.</p>
        <InjectionSiteMap medication={medication} onSelect={onSelect} />
      </div>
    </div>
  )
}

function SwapProfileIcon() {
  return (
    <svg className="profile-swap-icon" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="22" fill="#E3E3E3" />
      <path fill="#6B7280" d="M24 2a22 22 0 1 0 22 22A21.9 21.9 0 0 0 24 2Zm.3 29.5-4.9 4.9a1.9 1.9 0 0 1-2.8 0l-4.9-4.9a2.2 2.2 0 0 1-.4-2.7 2 2 0 0 1 3.1-.2l1.6 1.6V15a2 2 0 0 1 4 0v15.2l1.6-1.6a2 2 0 0 1 3.1.2 2.2 2.2 0 0 1-.4 2.7Zm12.4-12.3a2 2 0 0 1-3.1.2L32 17.8V33a2 2 0 0 1-4 0V17.8l-1.6 1.6a2 2 0 0 1-3.1-.2 2.1 2.1 0 0 1 .4-2.7l4.9-4.9a1.9 1.9 0 0 1 2.8 0l4.9 4.9a2.1 2.1 0 0 1 .4 2.7Z" />
    </svg>
  )
}

function MedicationProfileSwitcher({ profiles, selectedId, onSelect }) {
  const [open, setOpen] = useState(false)
  const selected = profiles.find((profile) => profile.ownerUserId === selectedId) || profiles[0]
  if (!selected || profiles.length < 2) return null

  return (
    <div className="medication-profile-switcher">
      <button type="button" className="medication-profile-trigger"
        aria-label={`Medication profile: ${selected.username}`}
        aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Avatar user={selected} size="medium" />
        <SwapProfileIcon />
      </button>
      {open && <div className="medication-profile-menu" role="menu">
        {profiles.map((profile) => {
          const permission = profile.role === 'owner'
            ? 'Your medication list'
            : `${profile.role === 'editor' ? 'Editor' : 'Viewer'} · ${
              profile.canViewHistory ? 'Dose history visible' : 'Schedule only'
            }`
          return <button type="button" role="menuitemradio"
            aria-checked={profile.ownerUserId === selected.ownerUserId}
            className={profile.ownerUserId === selected.ownerUserId ? 'active' : ''}
            key={profile.ownerUserId} onClick={() => {
              onSelect(profile.ownerUserId)
              setOpen(false)
            }}>
            <Avatar user={profile} size="medium" />
            <span><strong>@{profile.username}</strong><small>{permission}</small></span>
          </button>
        })}
      </div>}
    </div>
  )
}

function MedicationCardShell({
  medication,
  index,
  permissions,
  onOpen,
  onTogglePause,
  onEdit,
  onDelete,
  children,
}) {
  const [dx, setDx] = useState(0)
  const dxRef = useRef(0)
  const start = useRef(null)
  const base = useRef(0)
  const moved = useRef(false)
  const hasActions = permissions.canEdit || permissions.canDelete
  const REVEAL = 56

  const updateDx = (value) => {
    dxRef.current = value
    setDx(value)
  }
  const closeAndRun = (action) => {
    updateDx(0)
    action()
  }
  const onPointerDown = (event) => {
    if (!hasActions || event.target.closest('button')) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    start.current = event.clientX
    base.current = dxRef.current
    moved.current = false
  }
  const onPointerMove = (event) => {
    if (start.current == null) return
    const delta = event.clientX - start.current
    if (Math.abs(delta) > 6) moved.current = true
    updateDx(Math.max(-REVEAL, Math.min(0, base.current + delta)))
  }
  const onPointerEnd = () => {
    if (start.current == null) return
    updateDx(dxRef.current < -REVEAL / 2 ? -REVEAL : 0)
    start.current = null
  }
  const open = () => {
    if (moved.current) return
    if (dxRef.current !== 0) {
      updateDx(0)
      return
    }
    onOpen()
  }

  return (
    <div className={`card-wrap medication-card-wrap ${index % 2 ? 'purple' : ''} ${medication.paused ? 'paused' : ''}`}>
      {hasActions && <div className="med-card-actions">
        {permissions.canEdit && <PaperIconButton variant="swipe"
          label={`${medication.paused ? 'Resume' : 'Pause'} ${medication.name}`}
          icon={<Icon name={medication.paused ? 'play' : 'pause'} size={17} />}
          onFocus={() => updateDx(-REVEAL)}
          onClick={() => closeAndRun(onTogglePause)} />}
        {permissions.canEdit && <PaperIconButton variant="swipe"
          label={`Edit ${medication.name}`}
          icon={<Icon name="edit" size={17} />}
          onFocus={() => updateDx(-REVEAL)}
          onClick={() => closeAndRun(onEdit)} />}
        {permissions.canDelete && <PaperIconButton variant="swipe"
          label={`Delete ${medication.name}`}
          icon={<Icon name="trash" size={17} />}
          className="danger"
          onFocus={() => updateDx(-REVEAL)}
          onClick={() => closeAndRun(onDelete)} />}
      </div>}
      <article
        className="card med-card clickable"
        style={{ transform: `translateX(${dx}px)` }}
        tabIndex="0"
        aria-label={`View ${medication.name} details`}
        onClick={open}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={(event) => {
          if (event.currentTarget === event.target && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            open()
          }
        }}
      >
        {children}
      </article>
    </div>
  )
}

function SharedWith({ members }) {
  const [hovered, setHovered] = useState(null)
  const [selected, setSelected] = useState(null)
  return (
    <div className="shared-with">
      <span>Shared with</span>
      <div className="shared-avatar-list">
        {members.map((member) => {
          const visible = hovered === member.userId || selected === member.userId
          return <button type="button" className="shared-avatar" key={member.userId}
            aria-label={`Shared with @${member.username}`}
            aria-expanded={visible}
            onMouseEnter={() => setHovered(member.userId)}
            onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered(member.userId)}
            onBlur={() => setHovered(null)}
            onClick={() => setSelected((current) =>
              current === member.userId ? null : member.userId)}>
            <Avatar user={member} size="medium" />
            {visible && <span className="shared-avatar-tooltip" role="tooltip">
              @{member.username}
            </span>}
          </button>
        })}
      </div>
    </div>
  )
}

function App({ colorScheme = 'dark' }) {
  const [initialNavigation] = useState(loadMediraNavigation)
  const [medications, setMedications, medicationsLoaded, medicationSync] = useMedications()
  const [now, setNow] = useState(new Date())
  const [view, setView] = useState(initialNavigation.view)
  const [editing, setEditing] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [notice, setNotice] = useState('')
  const [pendingDose, setPendingDose] = useState(null)
  const [viewingMedication, setViewingMedication] = useState(null)
  const pendingViewingMedicationId = useRef(initialNavigation.viewingMedicationId)
  const [confirmingDelete, setConfirmingDelete] = useState(null)
  const [showSharing, setShowSharing] = useState(false)
  const [selectedProfileId, setSelectedProfileId] = useState(
    initialNavigation.selectedProfileId,
  )
  const [hasPushSubscription, setHasPushSubscription] = useState(false)
  const [deviceTimeZone, setDeviceTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  const sharing = useMedicationSharing(sharingEnabled)
  const medicationProfiles = sharing.profiles
  const ownProfile = medicationProfiles.find((profile) => profile.role === 'owner')
  const fallbackOwnerProfile = {
    ownerUserId: '',
    username: 'You',
    role: 'owner',
    canViewHistory: true,
  }
  const selectedProfile = medicationProfiles.find(
    (profile) => profile.ownerUserId === selectedProfileId,
  ) || ownProfile || fallbackOwnerProfile
  const visibleMedications = useMemo(() => {
    if (!selectedProfile.ownerUserId) {
      return medications.filter((medication) =>
        medicationPermissions(medication).role === 'owner')
    }
    return medications.filter((medication) => {
      const ownerUserId = medicationPermissions(medication).ownerUserId
      return ownerUserId
        ? ownerUserId === selectedProfile.ownerUserId
        : selectedProfile.role === 'owner'
    })
  }, [medications, selectedProfile])
  const ownMedications = useMemo(() => medications.filter((medication) => (
    medicationPermissions(medication).role === 'owner'
  )), [medications])

  useEffect(() => {
    if (sharing.status !== 'ready') return
    if (selectedProfile && selectedProfile.ownerUserId !== selectedProfileId) {
      setSelectedProfileId(selectedProfile.ownerUserId)
    }
  }, [selectedProfile, selectedProfileId, sharing.status])

  useEffect(() => {
    if (!medicationsLoaded || !pendingViewingMedicationId.current) return
    const medication = medications.find(
      (item) => item.id === pendingViewingMedicationId.current,
    )
    pendingViewingMedicationId.current = ''
    if (medication) setViewingMedication(medication)
  }, [medications, medicationsLoaded])

  useEffect(() => {
    saveMediraNavigation({
      view,
      selectedProfileId: selectedProfile?.ownerUserId || selectedProfileId,
      viewingMedicationId: viewingMedication?.id || pendingViewingMedicationId.current,
    })
  }, [selectedProfile, selectedProfileId, view, viewingMedication])

  useEffect(() => {
    const refreshSharedMedicationList = () => {
      medicationSync.refetch().catch(() => {})
      sharing.refresh().catch(() => {})
    }
    window.addEventListener('chrona:invite-accepted', refreshSharedMedicationList)
    return () => window.removeEventListener(
      'chrona:invite-accepted',
      refreshSharedMedicationList,
    )
  }, [medicationSync, sharing])

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
    const refreshSubscription = () => navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setHasPushSubscription(Boolean(subscription)))
      .catch((error) => console.error('Could not read the push subscription:', error))
    refreshSubscription()
    window.addEventListener('chrona-push-subscription-change', refreshSubscription)
    return () => window.removeEventListener('chrona-push-subscription-change', refreshSubscription)
  }, [])

  useEffect(() => {
    if (!hasPushSubscription) return
    const timer = setTimeout(() => {
      syncPushReminders(ownMedications).catch((error) => console.error('Could not sync medication reminders:', error))
    }, 500)
    return () => clearTimeout(timer)
  }, [deviceTimeZone, hasPushSubscription, ownMedications])

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000)
    const refresh = () => {
      setNow(new Date())
      setDeviceTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
    }
    window.addEventListener('focus', refresh)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [])

  const navigate = (nextView) => {
    setView(nextView)
    saveMediraView(nextView)
  }

  useEffect(() => {
    if (view === 'today' && selectedProfile
      && selectedProfile.role !== 'owner'
      && !selectedProfile?.canViewHistory) {
      navigate('medications')
    }
  }, [selectedProfile, view])

  const scheduleMedications = useMemo(() => visibleMedications.filter(
    (medication) => medicationPermissions(medication).canViewSchedule,
  ), [visibleMedications])
  const tomorrow = useMemo(() => {
    const date = new Date(now)
    date.setDate(date.getDate() + 1)
    return date
  }, [now])
  const todayDoses = useMemo(() => getActionableDoses(scheduleMedications, now), [scheduleMedications, now])
  const tomorrowDoses = useMemo(() => getDosesForDay(scheduleMedications, tomorrow), [scheduleMedications, tomorrow])
  const takenToday = todayDoses.filter((dose) => dose.record?.status === 'on-time' || dose.record?.status === 'late').length
  const next = useMemo(() => getNextDose(scheduleMedications, now), [scheduleMedications, now])
  const reminder = useMemo(() => getNextReminder(ownMedications, now), [ownMedications, now])
  useEffect(() => {
    if (hasPushSubscription || !reminder || !('Notification' in window) || Notification.permission !== 'granted') return
    const delay = reminder.alertAt - Date.now()
    if (delay < 0 || delay > 2_147_483_647) return
    const timer = setTimeout(async () => {
      const lead = reminder.advanceMinutes
      const prefix = formatReminderAdvance(lead)
      const options = { body: `${prefix} · ${reminder.medication.dose || reminder.medication.notes || ''}`, icon: reminder.medication.trackInjectionSite ? '/syringe-icon.svg' : '/medication-icon.png', tag: `dose-${reminder.medication.id}-${reminder.time}-${lead}` }
      const registration = await navigator.serviceWorker?.ready
      if (registration) registration.showNotification(reminder.medication.name, options)
      else new Notification(reminder.medication.name, options)
      setNow(new Date())
    }, delay)
    return () => clearTimeout(timer)
  }, [hasPushSubscription, reminder])

  const markTaken = (dose) => {
    const permissions = medicationPermissions(dose.medication)
    if (!permissions.canEdit || !permissions.canViewHistory) return
    if (dose.medication.trackInjectionSite) {
      setPendingDose(dose)
      return
    }
    completeTaken(dose)
  }

  const completeTaken = (dose, injectionSite = null) => {
    const permissions = medicationPermissions(dose.medication)
    if (!permissions.canEdit || !permissions.canViewHistory) return
    unlockSounds()
    const takenAt = new Date()
    const adjustment = adjustScheduleAfterDose(dose.medication, dose, takenAt)
    const scheduledAt = adjustment.scheduledAt.toISOString()
    const originalScheduledAt = adjustment.originalScheduledAt?.toISOString() || null
    setMedications((items) => items.map((med) => med.id !== dose.medication.id ? med : {
      ...med,
      history: [...med.history.filter((entry) => (entry.originalScheduledAt || entry.scheduledAt) !== dose.scheduledAt.toISOString()), {
        id: crypto.randomUUID(), scheduledAt, takenAt: takenAt.toISOString(),
        originalScheduledAt,
        status: isOnTime(dose.scheduledAt, takenAt) ? 'on-time' : 'late',
        injectionSite,
      }],
      times: adjustment.times,
      schedule: adjustment.schedule,
      inventory: med.inventory?.remaining == null ? med.inventory : {
        ...med.inventory,
        remaining: Math.max(0, inventoryInteger(med.inventory.remaining) - 1),
      },
    }))
    setPendingDose(null)
    playComplete()
  }

  const skipDose = (dose) => {
    const permissions = medicationPermissions(dose.medication)
    if (!permissions.canEdit || !permissions.canViewHistory) return
    const skippedAt = new Date().toISOString()
    setMedications((items) => items.map((medication) => medication.id !== dose.medication.id ? medication : {
      ...medication,
      history: [...medication.history.filter((entry) => entry.scheduledAt !== dose.scheduledAt.toISOString()), {
        id: crypto.randomUUID(),
        scheduledAt: dose.scheduledAt.toISOString(),
        skippedAt,
        status: 'skipped',
      }],
    }))
  }

  const undoTaken = (dose) => {
    const permissions = medicationPermissions(dose.medication)
    if (!permissions.canEdit || !permissions.canViewHistory) return
    setMedications((items) => items.map((medication) => {
      if (medication.id !== dose.medication.id) return medication
      const record = medication.history.find((entry) => entry.id === dose.record.id)
      if (!record) return medication
      return removeTakenHistoryRecord(medication, record.id)
    }))
    setNotice(dose.record.status === 'skipped' ? `${dose.medication.name} skip undone` : `${dose.medication.name} unchecked`)
    setTimeout(() => setNotice(''), 2600)
  }

  const overrideDoseTime = (dose, time) => {
    if (!medicationPermissions(dose.medication).canEdit) return
    setMedications((items) => items.map((medication) => (
      medication.id === dose.medication.id ? updateDoseTime(medication, dose, time) : medication
    )))
    setNotice(`${dose.medication.name} schedule updated`)
    setTimeout(() => setNotice(''), 2600)
  }

  const saveMedication = (form) => {
    if (editing) {
      setMedications((items) => items.map((med) => med.id === editing.id ? { ...med, ...form } : med))
    } else {
      setMedications((items) => [...items, {
        ...form, id: crypto.randomUUID(), createdAt: new Date().toISOString(), history: [],
        paused: false, pausePeriods: [],
      }])
    }
    setEditing(null)
    setShowForm(false)
  }

  const togglePause = (medication) => {
    if (!medicationPermissions(medication).canEdit) return
    const timestamp = new Date().toISOString()
    setMedications((items) => items.map((item) => {
      if (item.id !== medication.id) return item
      if (item.paused) {
        return {
          ...item,
          paused: false,
          pausePeriods: item.pausePeriods.map((period, index, periods) => index === periods.length - 1 && !period.end ? { ...period, end: timestamp } : period),
        }
      }
      return { ...item, paused: true, pausePeriods: [...item.pausePeriods, { start: timestamp, end: null }] }
    }))
    setNotice(`${medication.name} ${medication.paused ? 'resumed' : 'paused'}`)
    setTimeout(() => setNotice(''), 2600)
  }

  const adjustInventory = (medication, amount) => {
    if (!medicationPermissions(medication).canEdit) return
    setMedications((items) => items.map((item) => item.id !== medication.id ? item : {
      ...item,
      inventory: {
        ...item.inventory,
        remaining: Math.max(0, inventoryInteger(item.inventory?.remaining) + Math.round(amount)),
      },
    }))
  }

  const changeTakenHistory = (medication, edits, deletedRecordIds, newDose) => {
    const permissions = medicationPermissions(medication)
    if (!permissions.canEdit || !permissions.canViewHistory) return
    setMedications((items) => items.map((item) => (
      item.id === medication.id
        ? (() => {
            const edited = edits.reduce((updated, edit) => overrideTakenDate(updated, edit.recordId, edit.dateKey, edit.time, edit.injectionSite), item)
            const withoutDeleted = deletedRecordIds.reduce((updated, recordId) => removeTakenHistoryRecord(updated, recordId), edited)
            return newDose
              ? addTakenHistoryRecord(withoutDeleted, crypto.randomUUID(), newDose.dateKey, newDose.time, newDose.injectionSite, newDose.scheduledAt)
              : withoutDeleted
          })()
        : item
    )))
    setNotice(`${medication.name} history updated`)
    setTimeout(() => setNotice(''), 2600)
  }

  const copyMedicationList = async () => {
    if (!visibleMedications.length) {
      setNotice('No medications to copy')
      setTimeout(() => setNotice(''), 2600)
      return
    }
    const content = medicationListClipboardContent(visibleMedications)
    try {
      let copied = false
      if (navigator.clipboard?.write && window.ClipboardItem) {
        try {
          await navigator.clipboard.write([new window.ClipboardItem({
            'text/plain': new Blob([content.text], { type: 'text/plain' }),
            'text/html': new Blob([content.html], { type: 'text/html' }),
          })])
          copied = true
        } catch {
          copied = false
        }
      }
      if (!copied && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content.text)
        copied = true
      }
      if (!copied) throw new Error('Clipboard unavailable')
      setNotice('Copied!')
    } catch {
      setNotice('Medication list could not be copied')
    }
    setTimeout(() => setNotice(''), 2600)
  }

  const switchMedicationProfile = (ownerUserId) => {
    setSelectedProfileId(ownerUserId)
    const nextProfile = medicationProfiles.find((profile) =>
      profile.ownerUserId === ownerUserId)
    if (nextProfile?.role !== 'owner' && !nextProfile?.canViewHistory && view === 'today') {
      navigate('medications')
    }
    Promise.all([
      medicationSync.refetch(),
      sharing.refresh(),
    ]).catch(() => {
      // Existing synchronization feedback surfaces the request failure.
    })
  }

  return (
    <FluentProvider theme={colorScheme === 'light' ? mediraLightTheme : mediraTheme}
      className={`medira-shell ${colorScheme}`}>
      <div className="app">
      <div className="medira-main">
        {medicationSync.error && <div className="sync-conflict" role="alert">
          <span>{medicationSync.error.status === 409
            ? 'This medication changed elsewhere. Your view was reloaded with the latest version.'
            : 'Medication changes could not be synced.'}</span>
          <button type="button" className="secondary-action" onClick={() => medicationSync.refetch().catch(() => {})}>Reload</button>
        </div>}
        {view === 'today' && (
          <div className="view-anim forward">
            <div className="hero-copy">
              <div><span className="today-date">{now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</span>
                <h1 className="page-title">Today’s medications</h1>
                <p className="dose-count">{takenToday}/{todayDoses.length} taken</p>
              </div>
              <ProgressRing next={next} now={now} />
            </div>
            {todayDoses.length ? (
              <div className="card-wrap schedule-card-wrap"><div className="card dose-list">{todayDoses.map((dose) => <DoseCard key={dose.key} dose={dose}
                onTaken={markTaken} onSkip={skipDose} onUndo={undoTaken} onTimeChange={overrideDoseTime} onOpen={setViewingMedication} />)}</div></div>
            ) : (
              <div className="empty card-wrap schedule-card-wrap"><div className="card"><h3 className="card-title">No scheduled medications</h3><SmallIconButton label="Add medication" name="plus" className="add-medication-btn" onClick={() => setShowForm(true)} /></div></div>
            )}
            <section className="tomorrow-section" aria-labelledby="tomorrow-medications">
              <div className="tomorrow-head">
                <h2 className="section-title" id="tomorrow-medications">Tomorrow’s medications</h2>
                <span>{tomorrow.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</span>
              </div>
              {tomorrowDoses.length ? (
                <div className="card-wrap schedule-card-wrap"><div className="card dose-list">{tomorrowDoses.map((dose) => <DoseCard key={dose.key} dose={dose}
                  onTaken={markTaken} onSkip={skipDose} onUndo={undoTaken} onTimeChange={overrideDoseTime} onOpen={setViewingMedication} />)}</div></div>
              ) : (
                <div className="empty card-wrap schedule-card-wrap"><div className="card"><h3 className="card-title">No medications scheduled</h3></div></div>
              )}
            </section>
          </div>
        )}

        {view === 'medications' && (
          <div className="view-anim forward">
            <div className="page-head medication-list-head">
              <h1 className="page-title">Medication list</h1>
              <div className="medication-list-toolbar">
                <div className="medication-list-summary">
                  <p>{visibleMedications.filter((med) => !med.paused).length} active · {visibleMedications.filter((med) => med.paused).length} paused</p>
                  {selectedProfile?.role === 'owner' && sharing.members.length > 0 &&
                    <SharedWith members={sharing.members} />}
                </div>
              <div className="page-actions">
                {sharingEnabled && selectedProfile?.role === 'owner' &&
                  <SmallIconButton label="Share medication list" name="user-add" onClick={() => setShowSharing(true)} />}
                <SmallIconButton label="Copy medication list" name="copy" onClick={copyMedicationList} />
                {selectedProfile?.role !== 'viewer' && selectedProfile?.role !== 'editor' &&
                  <SmallIconButton label="Add medication" name="plus" className="add-medication-btn" onClick={() => setShowForm(true)} />}
              </div>
              </div>
            </div>
            <div className="med-grid">
              {visibleMedications.map((med, index) => {
                const permissions = medicationPermissions(med)
                const last = getLastTaken(med)
                const medNext = permissions.canViewSchedule ? getNextDose([med], now) : null
                const lowStock = med.inventory?.remaining != null
                  && inventoryInteger(med.inventory.remaining) <= inventoryInteger(med.inventory.refillAt)
                return <MedicationCardShell key={med.id} medication={med} index={index}
                  permissions={permissions}
                  onOpen={() => setViewingMedication(med)}
                  onTogglePause={() => togglePause(med)}
                  onEdit={() => setEditing(med)}
                  onDelete={() => setConfirmingDelete(med)}>
                  <div className="med-card-head"><div className="med-symbol"><Icon name={med.trackInjectionSite ? 'syringe' : 'pill'} size={20} /></div></div>
                  <div className="med-name-row"><h2 className="card-title">{med.name}</h2>{med.paused && <span className="paused-label">Paused</span>}</div><p className="dose-label">{med.dose || 'Dose not specified'}</p>
                  {med.notes && <div className="notes"><p>{med.notes}</p></div>}
                  <div className={`inventory-row ${lowStock ? 'low' : ''}`}>
                    <span>Inventory<strong>{med.inventory?.remaining == null ? 'Not tracked' : `${inventoryInteger(med.inventory.remaining)} ${med.inventory.unit}`}</strong></span>
                    {permissions.canEdit && <div className="inventory-controls" onClick={(event) => event.stopPropagation()}>
                      <SmallIconButton label={`Decrease ${med.name} inventory`} name="chevron-down" className="inventory-adjust" onClick={() => adjustInventory(med, -1)} />
                      <SmallIconButton label={`Increase ${med.name} inventory`} name="chevron-up" className="inventory-adjust" onClick={() => adjustInventory(med, 1)} />
                    </div>}
                  </div>
                  <div className="med-footer">
                    {permissions.canViewHistory && <span>Last taken<strong>{last ? formatDateTime(last.takenAt) : 'Not taken'}</strong></span>}
                    <span>Next dose<strong>{permissions.canViewSchedule ? med.paused ? 'Paused' : medNext ? formatDateTime(medNext.scheduledAt) : '—' : 'Not shared'}</strong></span>
                    <span>Frequency<strong>{permissions.canViewSchedule ? scheduleLabels(med)[0] : 'Not shared'}</strong></span>
                    {!permissions.canViewHistory && <span>History<strong>Private</strong></span>}
                  </div>
                </MedicationCardShell>
              })}
            </div>
          </div>
        )}

      </div>
      <div className={`medira-navigation ${medicationProfiles.length > 1 ? 'with-profiles' : ''}`}>
        <MedicationProfileSwitcher profiles={medicationProfiles}
          selectedId={selectedProfile?.ownerUserId} onSelect={switchMedicationProfile} />
        <nav className="bottom-nav" aria-label="Medication views">
          <button className={view === 'today' ? 'active' : ''}
            disabled={selectedProfile?.role !== 'owner' && !selectedProfile?.canViewHistory}
            onClick={() => navigate('today')}
            aria-label={selectedProfile?.role !== 'owner' && !selectedProfile?.canViewHistory
              ? 'Schedule is not shared for this profile'
              : 'Today’s schedule'}
            aria-current={view === 'today' ? 'page' : undefined}>
            <Icon name="clock" />
          </button>
          <button className={view === 'medications' ? 'active' : ''} onClick={() => navigate('medications')}
            aria-label="Medication list" aria-current={view === 'medications' ? 'page' : undefined}>
            <Icon name="list" />
          </button>
        </nav>
      </div>
      {(showForm || editing) && <MedicationForm initial={editing} onSave={saveMedication} onClose={() => { setShowForm(false); setEditing(null) }} />}
      {viewingMedication && <MedicationDetails
        medication={medications.find((medication) => medication.id === viewingMedication.id) || viewingMedication}
        now={now}
        onClose={() => setViewingMedication(null)}
        onAdjustInventory={adjustInventory}
        onOverrideTakenHistory={changeTakenHistory}
        onEdit={(medication) => { setViewingMedication(null); setEditing(medication) }} />}
      {sharingEnabled && showSharing && <SharingModal
        sharing={sharing} onClose={() => setShowSharing(false)} />}
      {pendingDose && <InjectionSitePicker medication={pendingDose.medication} onSelect={(site) => completeTaken(pendingDose, site)} onClose={() => setPendingDose(null)} />}
      {confirmingDelete && (
        <div className="modal-overlay" onClick={() => setConfirmingDelete(null)}>
          <div className="modal delete-confirm-modal" onClick={(event) => event.stopPropagation()}>
            <h3 className="modal-title">Delete medication?</h3>
            <p className="modal-body">
              “{confirmingDelete.name}” and its medication history will be permanently removed. This can’t be undone.
            </p>
            <div className="modal-actions">
              <button className="ghost-btn" onClick={() => setConfirmingDelete(null)}>Cancel</button>
              <button className="danger-btn" onClick={() => {
                setMedications((items) => items.filter((item) => item.id !== confirmingDelete.id))
                setConfirmingDelete(null)
              }}>Delete</button>
            </div>
          </div>
        </div>
      )}
      {notice && <div className={`toast ${notice === 'Copied!' ? 'neutral' : ''}`}>{notice}</div>}
    </div>
    </FluentProvider>
  )
}

export default App
