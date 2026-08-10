import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Chrona restores valid set pages and falls back when the set no longer exists', async () => {
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')

  assert.match(source, /const NAVIGATION_STORAGE_KEY = 'chrona-navigation-state'/)
  assert.match(source, /const \[initialNavigation\] = useState\(loadNavigation\)/)
  assert.match(source, /JSON\.stringify\(\{ appMode, view \}\)/)
  assert.match(source, /loaded && buddy\.loaded && view\.name !== 'home'/)
  assert.match(source, /!sets\.some\(\(set\) => set\.id === view\.id\) && !savedBuddyExists/)
  assert.match(source, /get\('buddyStreak'\)/)
  assert.match(source, /view: \{ name: 'run', buddyId \}/)
  assert.match(source, /window\.history\.replaceState\(\{ view, profileOpen: false, appMode \}/)
})

test('Medira restores its tab, shared profile, and open medication details', async () => {
  const source = await readFile(
    new URL('../src/medira/App.jsx', import.meta.url),
    'utf8',
  )

  assert.match(source, /const NAVIGATION_STORAGE_KEY = 'medira-navigation-state'/)
  assert.match(source, /const \[initialNavigation\] = useState\(loadMediraNavigation\)/)
  assert.match(source, /initialNavigation\.selectedProfileId/)
  assert.match(source, /pendingViewingMedicationId = useRef\(initialNavigation\.viewingMedicationId\)/)
  assert.match(source, /if \(medication\) setViewingMedication\(medication\)/)
  assert.match(source, /viewingMedicationId: viewingMedication\?\.id \|\| pendingViewingMedicationId\.current/)
  assert.match(source, /if \(view === 'today' && selectedProfile\s*&& selectedProfile\.role !== 'owner'/)
})
