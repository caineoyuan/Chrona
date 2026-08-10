function browserStorage(storage) {
  return storage || globalThis.localStorage
}

export function parseStoredJson(value, fallback) {
  if (value == null) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export function readStorageValue(key, fallback = null, storage) {
  try {
    return browserStorage(storage)?.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

export function writeStorageValue(key, value, { onError, storage } = {}) {
  try {
    browserStorage(storage)?.setItem(key, value)
    return true
  } catch (error) {
    onError?.(error)
    return false
  }
}

export function removeStorageValue(key, { onError, storage } = {}) {
  try {
    browserStorage(storage)?.removeItem(key)
    return true
  } catch (error) {
    onError?.(error)
    return false
  }
}

export function readStorageJson(key, fallback, storage) {
  return parseStoredJson(readStorageValue(key, null, storage), fallback)
}

export function writeStorageJson(key, value, options) {
  return writeStorageValue(key, JSON.stringify(value), options)
}

export function migrateStorageValue(currentKey, legacyKey, storage) {
  const current = readStorageValue(currentKey, null, storage)
  if (current !== null) return current
  const legacy = readStorageValue(legacyKey, null, storage)
  if (legacy === null) return null
  if (writeStorageValue(currentKey, legacy, { storage })) {
    removeStorageValue(legacyKey, { storage })
  }
  return legacy
}
