import assert from 'node:assert/strict'
import test from 'node:test'
import {
  migrateStorageValue,
  readStorageJson,
  writeStorageJson,
} from '../src/storage-utils.js'

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries))
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  }
}

test('shared storage helpers read JSON and migrate legacy values', () => {
  const storage = memoryStorage({
    current: JSON.stringify({ enabled: true }),
    legacy: JSON.stringify({ migrated: true }),
  })

  assert.deepEqual(readStorageJson('current', {}, storage), { enabled: true })
  assert.deepEqual(readStorageJson('missing', [], storage), [])
  assert.equal(migrateStorageValue('next', 'legacy', storage), '{"migrated":true}')
  assert.deepEqual(readStorageJson('next', {}, storage), { migrated: true })
  assert.equal(storage.getItem('legacy'), null)
})

test('shared storage writes report unavailable storage without throwing', () => {
  let reported
  const storage = {
    setItem() {
      throw new Error('unavailable')
    },
  }

  assert.equal(writeStorageJson('key', { value: 1 }, {
    storage,
    onError: (error) => { reported = error },
  }), false)
  assert.equal(reported.message, 'unavailable')
})
