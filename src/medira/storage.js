import { useEffect, useRef, useState } from 'react'
import { api, isLocalPreview } from '../auth.jsx'
import { inventoryInteger } from './lib'

const STORAGE_KEY = 'medira-medications-v1'
const LEGACY_STORAGE_KEY = 'dosewell-medications-v1'
const PREVIEW_SEED_KEY = 'medira-preview-seed-v1'

const PREVIEW_MEDICATIONS = [
  {
    id: 'preview-daily-metformin',
    name: 'Metformin',
    dose: '500 mg',
    notes: 'Take with breakfast and dinner.',
    times: ['08:00', '20:00'],
    schedule: { type: 'daily', intervalHours: 12, weekdays: [], anchorAt: null, changes: [] },
  },
  {
    id: 'preview-daily-lisinopril',
    name: 'Lisinopril',
    dose: '10 mg',
    notes: 'Take with water.',
    times: ['09:00'],
    schedule: { type: 'daily', intervalHours: 12, weekdays: [], anchorAt: null, changes: [] },
  },
  {
    id: 'preview-daily-sertraline',
    name: 'Sertraline',
    dose: '50 mg',
    notes: 'Take in the morning.',
    times: ['08:30'],
    schedule: { type: 'daily', intervalHours: 12, weekdays: [], anchorAt: null, changes: [] },
  },
  {
    id: 'preview-interval-amoxicillin',
    name: 'Amoxicillin',
    dose: '500 mg',
    notes: 'Take evenly throughout waking hours.',
    times: ['09:00', '17:00'],
    schedule: { type: 'interval', intervalHours: 8, weekdays: [], anchorAt: null, changes: [] },
  },
  {
    id: 'preview-interval-acetaminophen',
    name: 'Acetaminophen',
    dose: '500 mg',
    notes: 'Take as directed.',
    times: ['09:00', '15:00', '21:00'],
    schedule: { type: 'interval', intervalHours: 6, weekdays: [], anchorAt: null, changes: [] },
  },
  {
    id: 'preview-interval-gabapentin',
    name: 'Gabapentin',
    dose: '300 mg',
    notes: 'Space doses evenly.',
    times: ['09:00', '17:00'],
    schedule: { type: 'interval', intervalHours: 8, weekdays: [], anchorAt: null, changes: [] },
  },
  {
    id: 'preview-weekly-semaglutide',
    name: 'Semaglutide',
    dose: '0.5 mg',
    notes: 'Take every Monday.',
    times: ['09:00'],
    schedule: { type: 'weekly', intervalHours: 12, weekdays: [1], anchorAt: null, changes: [] },
    trackInjectionSite: true,
  },
  {
    id: 'preview-weekly-methotrexate',
    name: 'Methotrexate',
    dose: '10 mg',
    notes: 'Take every Wednesday.',
    times: ['18:00'],
    schedule: { type: 'weekly', intervalHours: 12, weekdays: [3], anchorAt: null, changes: [] },
  },
  {
    id: 'preview-weekly-vitamin-d',
    name: 'Vitamin D',
    dose: '50,000 IU',
    notes: 'Take every Friday with food.',
    times: ['12:00'],
    schedule: { type: 'weekly', intervalHours: 12, weekdays: [5], anchorAt: null, changes: [] },
  },
]

function normalizeMedication(medication) {
  const inventory = {
    remaining: null,
    perDose: 1,
    unit: 'doses',
    refillAt: 0,
    ...medication.inventory,
  }
  return {
    ...medication,
    paused: medication.paused ?? false,
    pausePeriods: medication.pausePeriods ?? [],
    inventory: {
      ...inventory,
      remaining: inventory.remaining == null ? null : inventoryInteger(inventory.remaining),
      perDose: 1,
      refillAt: inventoryInteger(inventory.refillAt),
    },
    notifications: {
      enabled: true,
      advanceMinutes: 0,
      ...medication.notifications,
    },
    schedule: {
      type: 'daily',
      intervalHours: 12,
      weekdays: [],
      anchorAt: null,
      changes: [],
      ...medication.schedule,
    },
    trackInjectionSite: medication.trackInjectionSite ?? false,
  }
}

function loadLocalMedications() {
  try {
    const current = localStorage.getItem(STORAGE_KEY)
    const saved = current ?? localStorage.getItem(LEGACY_STORAGE_KEY)
    if (current === null && saved !== null) {
      localStorage.setItem(STORAGE_KEY, saved)
      localStorage.removeItem(LEGACY_STORAGE_KEY)
    }
    const medications = saved ? JSON.parse(saved).map(normalizeMedication) : []
    if (!isLocalPreview || localStorage.getItem(PREVIEW_SEED_KEY)) return medications

    const createdAt = new Date().toISOString()
    const existingIds = new Set(medications.map((medication) => medication.id))
    const previewMedications = PREVIEW_MEDICATIONS
      .filter((medication) => !existingIds.has(medication.id))
      .map((medication) => normalizeMedication({
        ...medication,
        createdAt,
        history: [],
        paused: false,
        pausePeriods: [],
      }))
    const seededMedications = [...medications, ...previewMedications]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seededMedications))
    localStorage.setItem(PREVIEW_SEED_KEY, '1')
    return seededMedications
  } catch {
    return []
  }
}

export function useMedications() {
  const localMedications = useRef(loadLocalMedications())
  const [medications, setMedications] = useState(localMedications.current)
  const [loaded, setLoaded] = useState(false)
  const serverBacked = useRef(false)
  const saveTimer = useRef(null)

  useEffect(() => {
    if (isLocalPreview) {
      setLoaded(true)
      return
    }
    let active = true
    api('/api/medications')
      .then((data) => {
        if (!active) return
        serverBacked.current = true
        const serverMedications = Array.isArray(data?.medications)
          ? data.medications.map(normalizeMedication)
          : []
        setMedications(serverMedications.length ? serverMedications : localMedications.current)
      })
      .catch(() => {
        serverBacked.current = false
      })
      .finally(() => {
        if (active) setLoaded(true)
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!loaded) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(medications))
    if (!serverBacked.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      api('/api/medications', {
        method: 'PUT',
        body: JSON.stringify({ medications }),
      }).catch((error) => console.error('Could not save medications:', error))
    }, 400)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [loaded, medications])

  return [medications, setMedications, loaded]
}
