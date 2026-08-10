import {
  migrateStorageValue,
  readStorageJson,
  writeStorageJson,
  writeStorageValue,
} from '../storage-utils.js'

export const VIEW_STORAGE_KEY = 'medira-last-view'
export const LEGACY_VIEW_STORAGE_KEY = 'dosewell-last-view'
export const NAVIGATION_STORAGE_KEY = 'medira-navigation-state'

export function loadMediraView() {
  const savedView = migrateStorageValue(VIEW_STORAGE_KEY, LEGACY_VIEW_STORAGE_KEY)
  return savedView === 'medications' ? 'medications' : 'today'
}

export function loadMediraNavigation() {
  const fallback = {
    view: loadMediraView(),
    selectedProfileId: '',
    viewingMedicationId: '',
  }
  const saved = readStorageJson(NAVIGATION_STORAGE_KEY, null)
  return {
    view: ['today', 'medications'].includes(saved?.view)
      ? saved.view
      : fallback.view,
    selectedProfileId: typeof saved?.selectedProfileId === 'string'
      ? saved.selectedProfileId
      : '',
    viewingMedicationId: typeof saved?.viewingMedicationId === 'string'
      ? saved.viewingMedicationId
      : '',
  }
}

export function saveMediraNavigation(navigation) {
  return writeStorageJson(NAVIGATION_STORAGE_KEY, navigation)
}

export function saveMediraView(view) {
  return writeStorageValue(VIEW_STORAGE_KEY, view)
}
