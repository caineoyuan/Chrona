import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Medira identifies today and explains its bold calendar treatment', async () => {
  const [source, css] = await Promise.all([
    readFile(new URL('../src/medira/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/medira/index.css', import.meta.url), 'utf8'),
  ])

  assert.match(source, /Current day is bolded\./)
  assert.match(source, /date\.dateKey === localDateValue\(now\)/)
  assert.match(source, /current \? 'current' : ''/)
  assert.match(css, /\.calendar-day\.current > button \{ font-weight: 700; \}/)
})

test('Medira names weekly repeat days and fits multi-day countdowns', async () => {
  const [source, css] = await Promise.all([
    readFile(new URL('../src/medira/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/medira/index.css', import.meta.url), 'utf8'),
  ])

  assert.match(source, /function weeklyFrequency\(weekdays\)/)
  assert.match(source, /return weeklyFrequency\(schedule\.weekdays\)/)
  assert.match(css, /\.ring-center strong\.extra-long \{[^}]*max-width: 104px;[^}]*font-size: var\(--font-sm\);/)
  assert.match(css, /strong\.extra-long \{[^}]*max-width: 80px;[^}]*font-size: var\(--font-xs\);/)
})
