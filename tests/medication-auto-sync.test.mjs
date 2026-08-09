import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('medications automatically refresh while a shared list is visible', async () => {
  const source = await readFile(
    new URL('../src/medira/storage.js', import.meta.url),
    'utf8',
  )

  assert.match(source, /const SHARED_SYNC_INTERVAL_MS = 300_000/)
  assert.match(source, /mutationQueue\.current\s*\.catch\(\(\) => \{\}\)\s*\.then\(async \(\) =>/)
  assert.match(source, /if \(document\.visibilityState === 'hidden'\) return/)
  assert.match(source, /window\.setInterval\(\s*refreshVisibleMedications,\s*SHARED_SYNC_INTERVAL_MS,/)
  assert.match(source, /window\.addEventListener\('focus', refreshVisibleMedications\)/)
  assert.match(source, /document\.addEventListener\('visibilitychange', refreshVisibleMedications\)/)
  assert.match(source, /if \(refreshInFlight\.current\) return refreshInFlight\.current/)
  assert.match(source, /new EventSource\('\/api\/medications\/events'\)/)
  assert.match(source, /event\.resourceId\s*\? refetchChangedResource\(event\.resourceId\)\s*: refetch\(\)/)
  assert.match(source, /events\?\.close\(\)/)
})
