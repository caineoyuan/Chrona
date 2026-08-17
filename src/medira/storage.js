import { useCallback, useEffect, useRef, useState } from 'react'
import { api, isLocalPreview } from '../auth.jsx'
import { sharingEnabled } from '../feature-flags.js'
import {
  migrateStorageValue,
  parseStoredJson,
  readStorageValue,
  writeStorageJson,
  writeStorageValue,
} from '../storage-utils.js'
import { inventoryInteger, reminderOffsets, repairDynamicSchedule, takenRecordStatus } from './lib'
import {
  medicationData,
  medicationResourceClient,
  privateMedicationSnapshot,
} from './scoped-medications.js'

const STORAGE_KEY = 'medira-medications-v1'
const LEGACY_STORAGE_KEY = 'dosewell-medications-v1'
const PREVIEW_SEED_KEY = 'medira-preview-seed-v1'
const SHARED_SYNC_INTERVAL_MS = 300_000

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
  const notifications = {
    enabled: true,
    advanceMinutes: [0],
    ...medication.notifications,
  }
  const advanceMinutes = reminderOffsets(notifications)
  return repairDynamicSchedule({
    ...medication,
    history: (medication.history || []).map((record) => ({ ...record, status: takenRecordStatus(record) })),
    paused: medication.paused ?? false,
    pausePeriods: medication.pausePeriods ?? [],
    inventory: {
      ...inventory,
      remaining: inventory.remaining == null ? null : inventoryInteger(inventory.remaining),
      perDose: 1,
      refillAt: inventoryInteger(inventory.refillAt),
    },
    notifications: {
      ...notifications,
      advanceMinutes: notifications.enabled !== false && !advanceMinutes.length ? [0] : advanceMinutes,
    },
    schedule: {
      type: 'daily',
      intervalHours: 12,
      weekdays: [],
      anchorAt: null,
      startDate: null,
      changes: [],
      ...medication.schedule,
    },
    trackInjectionSite: medication.trackInjectionSite ?? false,
  })
}

function resourceMedication(resource) {
  return normalizeMedication({
    ...resource.data,
    resourceId: resource.id,
    resourceVersion: resource.version,
    resourceAccess: resource.access,
  })
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function loadLocalMedications() {
  try {
    const saved = migrateStorageValue(STORAGE_KEY, LEGACY_STORAGE_KEY)
    const medications = parseStoredJson(saved, []).map(normalizeMedication)
    if (!isLocalPreview || readStorageValue(PREVIEW_SEED_KEY)) return medications

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
    writeStorageJson(STORAGE_KEY, seededMedications)
    writeStorageValue(PREVIEW_SEED_KEY, '1')
    return seededMedications
  } catch {
    return []
  }
}

export function useMedications() {
  const localMedications = useRef(loadLocalMedications())
  const [medications, setMedications] = useState(
    isLocalPreview ? localMedications.current : [],
  )
  const [loaded, setLoaded] = useState(false)
  const serverBacked = useRef(false)
  const latestMedications = useRef(medications)
  const resourceStates = useRef(new Map())
  const generations = useRef(new Map())
  const mutationQueue = useRef(Promise.resolve())
  const refreshInFlight = useRef(null)
  const client = useRef(medicationResourceClient(api))
  const [syncError, setSyncError] = useState(null)

  useEffect(() => {
    latestMedications.current = medications
  }, [medications])

  const rememberResource = useCallback((medication) => {
    resourceStates.current.set(medication.id, {
      id: medication.resourceId,
      version: medication.resourceVersion,
      access: medication.resourceAccess,
    })
  }, [])

  const loadResource = useCallback(async (resource) => {
    return resourceMedication(resource)
  }, [])

  const refetchResource = useCallback(async (clientId, resourceId) => {
    try {
      const resource = await client.current.get(resourceId)
      const refreshed = await loadResource(resource)
      rememberResource(refreshed)
      latestMedications.current = latestMedications.current.map((item) =>
        item.id === clientId ? refreshed : item)
      setMedications(latestMedications.current)
      return refreshed
    } catch (error) {
      if (error.status === 404) {
        resourceStates.current.delete(clientId)
        latestMedications.current = latestMedications.current.filter(
          (item) => item.id !== clientId,
        )
        setMedications(latestMedications.current)
        return null
      }
      throw error
    }
  }, [loadResource, rememberResource])

  const createResource = useCallback(async (medication) => {
    const resource = await client.current.create(medicationData(medication))
    const state = {
      id: resource.id,
      version: resource.version,
      access: resource.access,
    }
    resourceStates.current.set(medication.id, state)
    return state
  }, [])

  useEffect(() => {
    if (isLocalPreview) {
      setLoaded(true)
      return
    }
    let active = true
    client.current.list()
      .then(async (resources) => {
        if (!active) return
        serverBacked.current = true
        let serverMedications = await Promise.all(resources.map(loadResource))
        if (!active) return
        for (const medication of serverMedications) rememberResource(medication)
        latestMedications.current = serverMedications
        setMedications(serverMedications)
      })
      .catch((error) => {
        serverBacked.current = false
        setSyncError(error)
      })
      .finally(() => {
        if (active) setLoaded(true)
      })
    return () => { active = false }
  }, [loadResource, rememberResource])

  useEffect(() => {
    if (!loaded || !isLocalPreview) return
    writeStorageJson(STORAGE_KEY, privateMedicationSnapshot(medications), {
      onError: (error) => console.error('Could not save private medication cache:', error),
    })
  }, [loaded, medications])

  const syncChange = useCallback(async (previous, next, generation) => {
    if ((generations.current.get(next?.id || previous.id) || 0) !== generation) return
    const clientId = next?.id || previous.id
    let state = resourceStates.current.get(clientId)
    try {
      if (!previous) {
        await createResource(next)
        return
      }
      if (!next) {
        if (!state) return
        await client.current.remove(state.id, state.version)
        resourceStates.current.delete(clientId)
        return
      }
      if (!state) state = await createResource(previous)

      if (!sameValue(medicationData(previous), medicationData(next))) {
        const updated = await client.current.update(
          state.id,
          state.version,
          medicationData(next),
        )
        state.version = updated.version
        state.access = updated.access
      }
      setSyncError(null)
    } catch (error) {
      setSyncError(error)
      generations.current.set(clientId, generation + 1)
      if (state?.id) {
        try {
          await refetchResource(clientId, state.id)
        } catch {
          latestMedications.current = previous
            ? latestMedications.current.map((item) =>
                item.id === clientId ? previous : item)
            : latestMedications.current.filter((item) => item.id !== clientId)
          setMedications(latestMedications.current)
        }
      } else {
        latestMedications.current = previous
          ? latestMedications.current.map((item) =>
              item.id === clientId ? previous : item)
          : latestMedications.current.filter((item) => item.id !== clientId)
        setMedications(latestMedications.current)
      }
      throw error
    }
  }, [createResource, refetchResource])

  const updateMedications = useCallback((update) => {
    const previousItems = latestMedications.current
    const nextItems = typeof update === 'function' ? update(previousItems) : update
    if (!Array.isArray(nextItems) || nextItems === previousItems) return
    latestMedications.current = nextItems
    setMedications(nextItems)
    if (!serverBacked.current) return

    const previousById = new Map(previousItems.map((item) => [item.id, item]))
    const nextById = new Map(nextItems.map((item) => [item.id, item]))
    const changedIds = new Set([...previousById.keys(), ...nextById.keys()])
    for (const id of changedIds) {
      const previous = previousById.get(id)
      const next = nextById.get(id)
      if (previous === next || (previous && next && sameValue(previous, next))) continue
      const generation = generations.current.get(id) || 0
      mutationQueue.current = mutationQueue.current
        .catch(() => {})
        .then(() => syncChange(previous, next, generation))
        .catch((error) => {
          if (error.status !== 409) {
            console.error('Could not sync medication resource:', error)
          }
        })
    }
  }, [syncChange])

  const refetch = useCallback(async () => {
    if (refreshInFlight.current) return refreshInFlight.current
    const refresh = mutationQueue.current
      .catch(() => {})
      .then(async () => {
        const resources = await client.current.list()
        const refreshed = await Promise.all(resources.map(loadResource))
        resourceStates.current.clear()
        for (const medication of refreshed) rememberResource(medication)
        latestMedications.current = refreshed
        setMedications(refreshed)
        setSyncError(null)
        return refreshed
      })
      .finally(() => {
        if (refreshInFlight.current === refresh) refreshInFlight.current = null
      })
    refreshInFlight.current = refresh
    return refresh
  }, [loadResource, rememberResource])

  const refetchChangedResource = useCallback(async (resourceId) => {
    await mutationQueue.current.catch(() => {})
    const match = [...resourceStates.current.entries()].find(
      ([, state]) => String(state.id) === String(resourceId),
    )
    if (!match) return refetch()
    return refetchResource(match[0], match[1].id)
  }, [refetch, refetchResource])

  useEffect(() => {
    if (!loaded || isLocalPreview || !serverBacked.current) return
    const refreshVisibleMedications = () => {
      if (document.visibilityState === 'hidden') return
      refetch().catch(setSyncError)
    }
    const timer = window.setInterval(
      refreshVisibleMedications,
      SHARED_SYNC_INTERVAL_MS,
    )
    const events = sharingEnabled && 'EventSource' in window
      ? new EventSource('/api/medications/events')
      : null
    if (events) {
      events.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data)
          const refresh = event.resourceId
            ? refetchChangedResource(event.resourceId)
            : refetch()
          refresh.catch(setSyncError)
        } catch (error) {
          console.error('Could not process medication sync event:', error)
        }
      }
    }
    window.addEventListener('focus', refreshVisibleMedications)
    window.addEventListener('chrona:timezone-updated', refreshVisibleMedications)
    document.addEventListener('visibilitychange', refreshVisibleMedications)
    return () => {
      window.clearInterval(timer)
      events?.close()
      window.removeEventListener('focus', refreshVisibleMedications)
      window.removeEventListener('chrona:timezone-updated', refreshVisibleMedications)
      document.removeEventListener('visibilitychange', refreshVisibleMedications)
    }
  }, [loaded, refetch, refetchChangedResource])

  return [
    medications,
    updateMedications,
    loaded,
    { error: syncError, refetch },
  ]
}
