import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import './index.css'
import { FluentProvider, Spinner, Switch, webDarkTheme, webLightTheme } from '@fluentui/react-components'
import { AddFilled } from '@fluentui/react-icons/svg/add'
import { AppsListRegular } from '@fluentui/react-icons/svg/apps-list'
import { BoxRegular } from '@fluentui/react-icons/svg/box'
import { CameraRegular } from '@fluentui/react-icons/svg/camera'
import { ChevronDownRegular } from '@fluentui/react-icons/svg/chevron-down'
import { ChevronUpRegular } from '@fluentui/react-icons/svg/chevron-up'
import { CheckmarkFilled } from '@fluentui/react-icons/svg/checkmark'
import { ClockRegular } from '@fluentui/react-icons/svg/clock'
import { DismissRegular } from '@fluentui/react-icons/svg/dismiss'
import { PlayRegular } from '@fluentui/react-icons/svg/play'
import { SearchRegular } from '@fluentui/react-icons/svg/search'
import { SaveRegular } from '@fluentui/react-icons/svg/save'
import ChronaIcon from '../components/Icon'
import {
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
  overrideScheduledTime,
  overrideTakenDate,
  parsePastedTime,
  reminderOffsets,
  timesForScheduleType,
  toTwelveHourTime,
  toTwentyFourHourTime,
  undoScheduleAfterDose,
  wakingHourSchedule,
} from './lib'
import { scanMedicationLabel } from './labelOcr'
import { searchOpenFda } from './openFda'
import { playComplete, unlockSounds } from './sound'
import { useMedications } from './storage'
import { syncPushReminders } from './push'

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

const VIEW_STORAGE_KEY = 'medira-last-view'
const LEGACY_VIEW_STORAGE_KEY = 'dosewell-last-view'
const REMINDER_PRESETS = [
  { value: 0, label: 'At time' },
  { value: 5, label: '5 min' },
  { value: 10, label: '10 min' },
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hour' },
]
const REMINDER_PRESET_VALUES = REMINDER_PRESETS.map(({ value }) => value)

function loadMediraView() {
  try {
    const savedView = localStorage.getItem(VIEW_STORAGE_KEY)
      ?? localStorage.getItem(LEGACY_VIEW_STORAGE_KEY)
    if (localStorage.getItem(VIEW_STORAGE_KEY) === null && savedView !== null) {
      localStorage.setItem(VIEW_STORAGE_KEY, savedView)
      localStorage.removeItem(LEGACY_VIEW_STORAGE_KEY)
    }
    return savedView === 'medications' ? 'medications' : 'today'
  } catch {
    return 'today'
  }
}

function formatTime(time) {
  return new Date(`2000-01-01T${time}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function scheduleLabels(medication) {
  const schedule = { type: 'daily', intervalHours: 12, intervalDays: 7, weekdays: [], ...medication.schedule }
  let frequency
  if (schedule.type === 'interval') frequency = `Every ${schedule.intervalHours} hours`
  else if (schedule.type === 'day-interval') frequency = `Every ${schedule.intervalDays} days at ${formatTime(medication.times[0])}`
  else if (schedule.type === 'weekly') {
    const frequency = schedule.weekdays.length > 1 ? `${schedule.weekdays.length}× weekly` : 'Weekly'
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
  if (schedule.type === 'weekly') return schedule.weekdays.length === 1 ? 'Weekly' : `${schedule.weekdays.length}× weekly`
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
    const count = medicationTakenCount(medication)
    const since = new Date(medication.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
    return { medication, dose, schedule, count, since }
  })
  return {
    text: ['Medication list', ...entries.map(({ medication, dose, schedule, count, since }) => (
      `• ${medication.name}\n  ◦ Dose: ${dose}\n  ◦ Schedule: ${schedule}\n  ◦ ${count} ${count === 1 ? 'dose' : 'doses'} taken since ${since}`
    ))].join('\n'),
    html: `<h2>Medication list</h2><ul>${entries.map(({ medication, dose, schedule, count, since }) => (
      `<li><strong>${escapeHtml(medication.name)}</strong><ul><li>Dose: ${escapeHtml(dose)}</li><li>Schedule: ${escapeHtml(schedule)}</li><li>${count} ${count === 1 ? 'dose' : 'doses'} taken since ${escapeHtml(since)}</li></ul></li>`
    )).join('')}</ul>`,
  }
}

function Icon({ name, size = 20 }) {
  if (name === 'pill' || name === 'syringe') {
    return <img className="medication-icon" src={name === 'syringe' ? '/syringe-icon.svg' : '/medication-icon.png'} width={size} height={size} alt="" aria-hidden="true" />
  }
  if (name === 'edit' || name === 'copy' || name === 'trash') {
    return <ChronaIcon name={name} size={size} className="icon action-glyph" />
  }
  if (name === 'pause') {
    return (
      <svg className="icon action-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="3" width="5" height="18" rx="1" fill="currentColor" />
        <rect x="14" y="3" width="5" height="18" rx="1" fill="currentColor" />
      </svg>
    )
  }
  const icons = {
    plus: AddFilled,
    check: CheckmarkFilled,
    clock: ClockRegular,
    close: DismissRegular,
    camera: CameraRegular,
    play: PlayRegular,
    box: BoxRegular,
    list: AppsListRegular,
    search: SearchRegular,
    save: SaveRegular,
    chevron: ChevronDownRegular,
    'chevron-down': ChevronDownRegular,
    'chevron-up': ChevronUpRegular,
  }
  const FluentIcon = icons[name]
  return FluentIcon ? <FluentIcon className="icon" fontSize={size} aria-hidden="true" /> : null
}

function SmallIconButton({ label, name, size = 17, className = '', ...props }) {
  return (
    <button type="button" className={`icon-btn ${className}`} aria-label={label} title={label} {...props}>
      <Icon name={name} size={size} />
    </button>
  )
}

function TimeInput({ value, onChange, onComplete, label, compact = false }) {
  const inputs = useRef([])
  const [parts, setParts] = useState(() => toTwelveHourTime(value))

  useEffect(() => setParts(toTwelveHourTime(value)), [value])

  const enterPart = (index, rawValue) => {
    const nextPart = rawValue.replace(/\D/g, '').slice(-2)
    const field = index === 0 ? 'hours' : 'minutes'
    const nextParts = { ...parts, [field]: nextPart }
    setParts(nextParts)
    if (nextPart.length !== 2) {
      requestAnimationFrame(() => inputs.current[index]?.setSelectionRange(nextPart.length, nextPart.length))
      return
    }
    const next = toTwentyFourHourTime(nextParts.hours, nextParts.minutes, nextParts.period)
    if (!next) {
      setParts(toTwelveHourTime(value))
      return
    }
    onChange(next)
    if (index === 1) onComplete?.(next)
    inputs.current[index + 1]?.focus()
  }

  const handleKey = (event, index) => {
    const part = index === 0 ? parts.hours : parts.minutes
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
    const part = index === 0 ? parts.hours : parts.minutes
    if (!part || part.length === 2) return
    enterPart(index, part.padStart(2, '0'))
  }

  const handlePaste = (event) => {
    const time = parsePastedTime(event.clipboardData.getData('text'))
    if (!time) return
    event.preventDefault()
    onChange(time)
    onComplete?.(time)
    setParts(toTwelveHourTime(time))
    inputs.current[1]?.focus()
  }

  const selectPeriod = (period) => {
    const nextParts = { ...parts, period }
    setParts(nextParts)
    const next = toTwentyFourHourTime(nextParts.hours, nextParts.minutes, period)
    if (!next) return
    onChange(next)
    onComplete?.(next)
  }

  return (
    <div className={`time-input ${compact ? 'compact' : ''}`} role="group" aria-label={label} onPaste={handlePaste}>
      {[0, 1].map((index) => (
        <span key={index}>
          {index === 1 && <b aria-hidden="true">:</b>}
          <input ref={(element) => { inputs.current[index] = element }} value={index === 0 ? parts.hours : parts.minutes}
            inputMode="numeric" pattern="[0-9]*" maxLength="2" aria-label={`${label}, ${index === 0 ? 'hours' : 'minutes'}`}
            onFocus={(event) => event.target.select()} onChange={(event) => enterPart(index, event.target.value)}
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

function DoseTimeEditor({ dose, onChange }) {
  const initial = dose.scheduledAt.toTimeString().slice(0, 5)
  const [value, setValue] = useState(initial)
  return (
    <div className="dose-time-editor" onClick={(event) => event.stopPropagation()}>
      <TimeInput compact label={`Scheduled time for ${dose.medication.name}`} value={value}
        onChange={setValue} onComplete={(time) => onChange(dose, time)} />
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
        <strong>{next ? formatRelative(next.scheduledAt, now) : 'All done'}</strong>
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
              {[['daily', 'Daily'], ['interval', 'Hourly'], ['weekly', 'Weekly']].map(([value, label]) => (
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
  const width = () => rowRef.current?.offsetWidth || 320

  const startSwipe = (event) => {
    if (dose.record) return
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
      <div className="dose-skip-fill" style={{ opacity: Math.pow(skipProgress, 4) }}>
        <span>Skip</span><Icon name="close" size={22} />
      </div>
      <div className={`dose-row ${status} clickable`} role="button" tabIndex="0"
        style={{ transform: `translateX(${dragX}px)`, transition: dragX ? 'none' : 'transform .2s ease' }}
        aria-label={`View ${dose.medication.name} details`}
        onClick={() => { if (!moved.current) onOpen(dose.medication) }}
        onTouchStart={startSwipe} onTouchMove={moveSwipe} onTouchEnd={endSwipe} onTouchCancel={endSwipe}
        onKeyDown={(event) => { if (event.currentTarget === event.target && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen(dose.medication) } }}>
        <div className="dose-time-column">
          {isTaken && <span className="dose-time-label">Taken at:</span>}
          <DoseTimeEditor dose={dose} onChange={onTimeChange} />
        </div>
        <div className="dose-dot"><span /></div>
        <div className="dose-info">
          <strong>{dose.medication.name}</strong>
          {isSkipped && <span className="skipped-at">Skipped {new Date(dose.record.skippedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
          <span>{dose.medication.dose || 'Dose not set'} · {frequencyLabel(dose.medication)}</span>
        </div>
        <div className="dose-action-column">
          {isSkipped ? (
            <button className="taken-toggle skipped" title="Undo skip" aria-label="Undo skip"
              onClick={(event) => { event.stopPropagation(); onUndo(dose) }}><Icon name="close" size={20} /></button>
          ) : isTaken ? (
            <button className="taken-toggle complete" title="Undo taken" aria-label="Undo taken" aria-pressed="true"
              onClick={(event) => { event.stopPropagation(); onUndo(dose) }}><Icon name="check" size={20} /></button>
          ) : (
            <button className={`taken-toggle ${isMissed ? 'overdue' : ''}`} title="Mark taken" aria-label="Mark taken" aria-pressed="false"
              onClick={(event) => { event.stopPropagation(); onTaken(dose) }}><Icon name="check" size={20} /></button>
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

function MedicationDetails({ medication, now, onClose, onEdit, onAdjustInventory, onOverrideTakenDate }) {
  const [pastMonths, setPastMonths] = useState(6)
  const [futureMonths, setFutureMonths] = useState(6)
  const [selectedDate, setSelectedDate] = useState(null)
  const [overrideRecord, setOverrideRecord] = useState(null)
  const [pendingOverride, setPendingOverride] = useState(null)
  const [futureDateWarning, setFutureDateWarning] = useState(false)
  const calendarScrollRef = useRef(null)
  const calendarLoad = useRef(null)
  const doseTap = useRef({ recordId: null, at: 0 })
  const currentMonthKey = `${now.getFullYear()}-${now.getMonth()}`
  const next = getNextDose([medication], now)
  const calendarMonths = medicationCalendarMonths(medication, now, { pastMonths, futureMonths })

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
    if (overrideRecord) {
      if (isFutureLocalDate(date.dateKey, now)) {
        setFutureDateWarning(true)
        return
      }
      const record = medication.history.find((entry) => entry.id === overrideRecord.recordId)
      const takenAt = new Date(record?.takenAt)
      const time = Number.isNaN(takenAt.getTime())
        ? '08:00'
        : `${String(takenAt.getHours()).padStart(2, '0')}:${String(takenAt.getMinutes()).padStart(2, '0')}`
      setPendingOverride({ recordId: overrideRecord.recordId, dateKey: date.dateKey, time })
      return
    }
    if (!date.events.length) return
    setSelectedDate(selectedDate?.dateKey === date.dateKey ? null : { ...date, monthLabel })
  }

  const handleDoseTap = (event) => {
    if (!event.recordId || event.status === 'missed' || event.status === 'skipped') return
    const tappedAt = Date.now()
    if (doseTap.current.recordId === event.recordId && tappedAt - doseTap.current.at <= 320) {
      setOverrideRecord(event)
      setSelectedDate(null)
      doseTap.current = { recordId: null, at: 0 }
      return
    }
    doseTap.current = { recordId: event.recordId, at: tappedAt }
  }

  return (
    <div className="modal-backdrop details-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <article className="modal details-modal">
        <div className="medication-actions details-actions">
          <SmallIconButton label="Edit medication" name="edit" onClick={() => onEdit(medication)} />
          <SmallIconButton label="Close" name="close" onClick={onClose} />
        </div>
        <div className="modal-head">
          <div>{medication.paused && <span className="eyebrow">Paused</span>}<h2 className="modal-title">{medication.name}</h2><p className="detail-dose">{medication.dose || 'Dose not set'}</p></div>
        </div>
        <div className="detail-list">
          <div><span>Schedule</span><strong>{scheduleLabels(medication).join(' · ')}</strong></div>
          <div><span>Next dose</span><strong>{medication.paused ? 'Paused' : next ? formatDateTime(next.scheduledAt) : '—'}</strong></div>
          <div className="detail-inventory"><span>Inventory</span>
            <strong>{medication.inventory?.remaining == null ? 'Not tracked' : `${inventoryInteger(medication.inventory.remaining)} ${medication.inventory.unit}`}</strong>
            <div className="detail-inventory-controls">
              <SmallIconButton label={`Decrease ${medication.name} inventory`} name="chevron-down" className="inventory-adjust"
                onClick={() => onAdjustInventory(medication, -1)} />
              <SmallIconButton label={`Increase ${medication.name} inventory`} name="chevron-up" className="inventory-adjust"
                onClick={() => onAdjustInventory(medication, 1)} />
            </div>
          </div>
        </div>
        {medication.trackInjectionSite && <section className="detail-site-map">
          <InjectionSiteMap medication={medication} compact />
        </section>}
        {medication.notes && <section className="detail-instructions"><span>Instructions</span><p>{medication.notes}</p></section>}
        <section className="medication-calendar">
          <div className="calendar-heading"><span className="eyebrow">Dose history</span><small>Scroll for past and future months</small></div>
          {overrideRecord && <div className="history-override-banner">
            <span>Select the new taken date.</span>
            <button type="button" onClick={() => { setOverrideRecord(null); setPendingOverride(null) }}>Cancel</button>
          </div>}
          <div className="calendar-scroll" ref={calendarScrollRef} onScroll={loadCalendarAtEdge}>
            {calendarMonths.map((month) => (
              <div className="calendar-month" data-month={month.key} key={month.key}>
                <h4>{month.label}</h4>
                <div className="calendar-grid">
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => <span className="calendar-weekday" key={day}>{day.slice(0, 1)}</span>)}
                  {Array.from({ length: month.leadingDays }, (_, index) => <span className="calendar-blank" key={`blank-${index}`} />)}
                  {month.days.map((date) => {
                    const selected = selectedDate?.dateKey === date.dateKey
                    const label = `${month.label} ${date.day}${date.count ? `, taken ${date.count} ${date.count === 1 ? 'time' : 'times'}` : ''}${date.missedCount ? `, missed ${date.missedCount}` : ''}`
                    return <div className={`calendar-day ${date.count ? 'taken' : ''} ${date.missedCount ? 'missed' : ''}`} key={date.day}>
                      <button type="button" aria-label={label} aria-expanded={selected}
                        disabled={!overrideRecord && !date.events.length}
                        onClick={() => selectHistoryDate(date, month.label)}>{date.day}</button>
                      {date.count > 1 && <small>{date.count} times</small>}
                      {date.count === 1 && date.injectionSites[0] && <small>{date.injectionSites[0]}</small>}
                    </div>
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
        {selectedDate && <div className="history-warning-backdrop" role="dialog" aria-modal="true"
          aria-labelledby="history-date-title" onMouseDown={(event) => event.target === event.currentTarget && setSelectedDate(null)}>
          <div className="history-warning history-record-modal">
            <div className="history-time-head">
              <h3 className="modal-title" id="history-date-title">{formatLocalDateLong(selectedDate.dateKey)}</h3>
              <SmallIconButton label="Close date details" name="close" onClick={() => setSelectedDate(null)} />
            </div>
            <div className="history-record-list">
              {selectedDate.events.map((event, index) => (
                event.status === 'missed' || event.status === 'skipped'
                  ? <span key={`${event.time}-${index}`}>Missed {new Date(event.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                  : <button type="button" className="history-dose" key={`${event.time}-${index}`}
                    title="Double tap to change taken date" onClick={() => handleDoseTap(event)}>
                    Taken {new Date(event.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    {event.injectionSite ? ` · ${INJECTION_SITE_CODES[event.injectionSite]}` : ''}
                  </button>
              ))}
            </div>
            {selectedDate.events.some((event) => event.recordId) && <small>Double tap a taken dose to change its date.</small>}
          </div>
        </div>}
        {pendingOverride && <div className="history-warning-backdrop" role="dialog" aria-modal="true" aria-labelledby="override-time-title">
          <div className="history-warning history-time-modal">
            <div className="history-time-head">
              <h3 className="modal-title" id="override-time-title">Confirm taken time</h3>
              <SmallIconButton label="Cancel date override" name="close" onClick={() => setPendingOverride(null)} />
            </div>
            <p>{formatLocalDate(pendingOverride.dateKey)}</p>
            <div className="history-time-field">
              <span>Taken time</span>
              <TimeInput label="Override taken time" value={pendingOverride.time}
                onChange={(time) => setPendingOverride((current) => ({ ...current, time }))} />
            </div>
            <button type="button" className="primary-btn wide" onClick={() => {
              onOverrideTakenDate(medication, pendingOverride.recordId, pendingOverride.dateKey, pendingOverride.time)
              setPendingOverride(null)
              setOverrideRecord(null)
              setSelectedDate(null)
            }}>Confirm taken date and time</button>
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

function App({ colorScheme = 'dark' }) {
  const [medications, setMedications] = useMedications()
  const [now, setNow] = useState(new Date())
  const [view, setView] = useState(loadMediraView)
  const [editing, setEditing] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [notice, setNotice] = useState('')
  const [pendingDose, setPendingDose] = useState(null)
  const [viewingMedication, setViewingMedication] = useState(null)
  const [confirmingDelete, setConfirmingDelete] = useState(null)
  const [hasPushSubscription, setHasPushSubscription] = useState(false)
  const [deviceTimeZone, setDeviceTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')

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
      syncPushReminders(medications).catch((error) => console.error('Could not sync medication reminders:', error))
    }, 500)
    return () => clearTimeout(timer)
  }, [deviceTimeZone, hasPushSubscription, medications])

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
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, nextView)
    } catch {
      // Navigation still works when storage is unavailable.
    }
  }

  const tomorrow = useMemo(() => {
    const date = new Date(now)
    date.setDate(date.getDate() + 1)
    return date
  }, [now])
  const todayDoses = useMemo(() => getActionableDoses(medications, now), [medications, now])
  const tomorrowDoses = useMemo(() => getDosesForDay(medications, tomorrow), [medications, tomorrow])
  const takenToday = todayDoses.filter((dose) => dose.record?.status === 'on-time' || dose.record?.status === 'late').length
  const next = useMemo(() => getNextDose(medications, now), [medications, now])
  const reminder = useMemo(() => getNextReminder(medications, now), [medications, now])
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
    if (dose.medication.trackInjectionSite) {
      setPendingDose(dose)
      return
    }
    completeTaken(dose)
  }

  const completeTaken = (dose, injectionSite = null) => {
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
    setMedications((items) => items.map((medication) => {
      if (medication.id !== dose.medication.id) return medication
      const record = medication.history.find((entry) => entry.id === dose.record.id)
      if (!record) return medication
      const restored = undoScheduleAfterDose(medication, record)
      return {
        ...medication,
        times: restored.times,
        schedule: restored.schedule,
        history: medication.history.filter((entry) => entry.id !== record.id),
        inventory: record.status === 'skipped' || medication.inventory?.remaining == null ? medication.inventory : {
          ...medication.inventory,
          remaining: inventoryInteger(medication.inventory.remaining) + 1,
        },
      }
    }))
    setNotice(dose.record.status === 'skipped' ? `${dose.medication.name} skip undone` : `${dose.medication.name} unchecked`)
    setTimeout(() => setNotice(''), 2600)
  }

  const overrideDoseTime = (dose, time) => {
    setMedications((items) => items.map((medication) => {
      if (medication.id !== dose.medication.id) return medication
      const restored = dose.record?.originalScheduledAt
        ? undoScheduleAfterDose(medication, dose.record)
        : { times: medication.times, schedule: medication.schedule }
      const base = { ...medication, times: restored.times, schedule: restored.schedule }
      const baseScheduledAt = new Date(dose.record?.originalScheduledAt || dose.scheduledAt)
      const overridden = overrideScheduledTime(base, { ...dose, scheduledAt: baseScheduledAt }, time)
      return {
        ...base,
        times: overridden.times,
        schedule: overridden.schedule,
        history: base.history.map((record) => record.id !== dose.record?.id ? record : {
          ...record,
          scheduledAt: overridden.scheduledAt.toISOString(),
          originalScheduledAt: null,
          status: record.status === 'skipped' ? 'skipped' : isOnTime(overridden.scheduledAt, new Date(record.takenAt)) ? 'on-time' : 'late',
        }),
      }
    }))
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
    setMedications((items) => items.map((item) => item.id !== medication.id ? item : {
      ...item,
      inventory: {
        ...item.inventory,
        remaining: Math.max(0, inventoryInteger(item.inventory?.remaining) + Math.round(amount)),
      },
    }))
  }

  const changeTakenDate = (medication, recordId, dateKey, time) => {
    setMedications((items) => items.map((item) => (
      item.id === medication.id ? overrideTakenDate(item, recordId, dateKey, time) : item
    )))
    setNotice(`${medication.name} taken date updated`)
    setTimeout(() => setNotice(''), 2600)
  }

  const copyMedicationList = async () => {
    if (!medications.length) {
      setNotice('No medications to copy')
      setTimeout(() => setNotice(''), 2600)
      return
    }
    const content = medicationListClipboardContent(medications)
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

  return (
    <FluentProvider theme={colorScheme === 'light' ? mediraLightTheme : mediraTheme}
      className={`medira-shell ${colorScheme}`}>
      <div className="app">
      <div className="medira-main">
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
            <div className="page-head"><div><h1 className="page-title">Medication list</h1><p>{medications.filter((med) => !med.paused).length} active · {medications.filter((med) => med.paused).length} paused</p></div>
              <div className="page-actions">
                <SmallIconButton label="Copy medication list" name="copy" onClick={copyMedicationList} />
                <SmallIconButton label="Add medication" name="plus" className="add-medication-btn" onClick={() => setShowForm(true)} />
              </div>
            </div>
            <div className="med-grid">
              {medications.map((med, index) => {
                const last = getLastTaken(med)
                const medNext = getNextDose([med], now)
                const takenCount = medicationTakenCount(med)
                const addedDate = new Date(med.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
                const lowStock = med.inventory?.remaining != null
                  && inventoryInteger(med.inventory.remaining) <= inventoryInteger(med.inventory.refillAt)
                return <div className={`card-wrap ${index % 2 ? 'purple' : ''} ${med.paused ? 'paused' : ''}`} key={med.id}><article
                  className="card med-card clickable" tabIndex="0" aria-label={`View ${med.name} details`}
                  onClick={() => setViewingMedication(med)}
                  onKeyDown={(event) => { if (event.currentTarget === event.target && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setViewingMedication(med) } }}>
                  <div className="med-card-head"><div className="med-symbol"><Icon name={med.trackInjectionSite ? 'syringe' : 'pill'} size={20} /></div><div className="medication-actions" onClick={(event) => event.stopPropagation()}>
                    <SmallIconButton label={`${med.paused ? 'Resume' : 'Pause'} ${med.name}`} name={med.paused ? 'play' : 'pause'} className={med.paused ? 'resume' : ''} onClick={() => togglePause(med)} />
                    <SmallIconButton label={`Edit ${med.name}`} name="edit" onClick={() => setEditing(med)} />
                    <SmallIconButton label={`Delete ${med.name}`} name="trash" className="danger" onClick={() => setConfirmingDelete(med)} />
                  </div></div>
                  <div className="med-name-row"><h2 className="card-title">{med.name}</h2>{med.paused && <span className="paused-badge">Paused</span>}</div><p className="dose-label">{med.dose || 'Dose not specified'}</p>
                  <div className="meta-row">{scheduleLabels(med).map((label) => <span className="meta-pill" key={label}>{label}</span>)}{med.trackInjectionSite && <span className="meta-pill injection">Injection</span>}</div>
                  {med.notes && <div className="notes"><span>How to take</span><p>{med.notes}</p></div>}
                  <div className={`inventory-row ${lowStock ? 'low' : ''}`}>
                    <span>Inventory<strong>{med.inventory?.remaining == null ? 'Not tracked' : `${inventoryInteger(med.inventory.remaining)} ${med.inventory.unit}`}</strong></span>
                    <div className="inventory-controls" onClick={(event) => event.stopPropagation()}>
                      <SmallIconButton label={`Decrease ${med.name} inventory`} name="chevron-down" className="inventory-adjust" onClick={() => adjustInventory(med, -1)} />
                      <SmallIconButton label={`Increase ${med.name} inventory`} name="chevron-up" className="inventory-adjust" onClick={() => adjustInventory(med, 1)} />
                    </div>
                  </div>
                  <div className="med-footer"><span>Last taken<strong>{last ? formatDateTime(last.takenAt) : 'Not taken'}</strong></span><span>Next dose<strong>{med.paused ? 'Paused' : medNext ? formatDateTime(medNext.scheduledAt) : '—'}</strong></span><span>Doses taken<strong>{takenCount} since {addedDate}</strong></span></div>
                </article></div>
              })}
            </div>
          </div>
        )}

      </div>
      <nav className="bottom-nav" aria-label="Medication views">
        <button className={view === 'today' ? 'active' : ''} onClick={() => navigate('today')}
          aria-label="Today’s schedule" aria-current={view === 'today' ? 'page' : undefined}>
          <Icon name="clock" />
        </button>
        <button className={view === 'medications' ? 'active' : ''} onClick={() => navigate('medications')}
          aria-label="Medication list" aria-current={view === 'medications' ? 'page' : undefined}>
          <Icon name="list" />
        </button>
      </nav>
      {(showForm || editing) && <MedicationForm initial={editing} onSave={saveMedication} onClose={() => { setShowForm(false); setEditing(null) }} />}
      {viewingMedication && <MedicationDetails
        medication={medications.find((medication) => medication.id === viewingMedication.id) || viewingMedication}
        now={now}
        onClose={() => setViewingMedication(null)}
        onAdjustInventory={adjustInventory}
        onOverrideTakenDate={changeTakenDate}
        onEdit={(medication) => { setViewingMedication(null); setEditing(medication) }} />}
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
