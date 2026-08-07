import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMedicationLabel } from '../src/medira/labelOcr.js'

test('extracts a medication name and dose from a typical pharmacy label', () => {
  const result = parseMedicationLabel([
    'MAIN STREET PHARMACY',
    'METFORMIN 500 MG TABLETS',
    'Take one tablet by mouth twice daily',
    'Qty 60',
  ].join('\n'))

  assert.equal(result.name, 'Metformin')
  assert.equal(result.dose, '500 MG')
})

test('rejects noisy OCR fragments instead of using them as a medication name', () => {
  const result = parseMedicationLabel([
    '| i l @ #',
    'rn n i vv',
    '---- 1 1 ----',
  ].join('\n'))

  assert.equal(result.name, '')
  assert.equal(result.dose, '')
})
