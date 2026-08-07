const DOSE_PATTERN = /\b\d+(?:\.\d+)?\s*(?:mcg|µg|mg|g|ml|units?|iu|%)(?:\s*\/\s*\d+(?:\.\d+)?\s*(?:ml|mg))?\b/i
const LABEL_NOISE = /\b(?:pharmacy|patient|prescriber|doctor|address|phone|refills?|quantity|qty|rx|warning|discard|expiration|expires|date|take|use|mouth|daily|times|morning|evening)\b/i
const DRUG_SUFFIX = /(?:cillin|cycline|prazole|pril|sartan|statin|olol|formin|oxetine|zepam|caine|vir|azole|mycin|mab|nib)\b/i

function titleCase(value) {
  if (value !== value.toUpperCase()) return value
  return value.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}

export function parseMedicationLabel(text) {
  const lines = text.split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 3)

  const dose = lines.map((line) => line.match(DOSE_PATTERN)?.[0]).find(Boolean) || ''
  const candidates = lines.map((line, index) => {
    const letters = line.replace(/[^a-z]/gi, '')
    const uppercaseRatio = letters ? letters.replace(/[^A-Z]/g, '').length / letters.length : 0
    let score = 0
    if (DOSE_PATTERN.test(line)) score += 5
    if (uppercaseRatio > .75) score += 3
    if (DRUG_SUFFIX.test(line)) score += 4
    if (/^[a-z][a-z .'-]+$/i.test(line)) score += 1
    if (LABEL_NOISE.test(line)) score -= 8
    if (line.length > 55 || line.length < 4) score -= 3
    score -= index * .05
    return { line, score }
  }).sort((a, b) => b.score - a.score)

  const best = candidates[0]
  const name = best && best.score > 0
    ? titleCase(best.line
      .replace(DOSE_PATTERN, '')
      .replace(/\b(?:tablets?|capsules?|solution|suspension|oral|topical|usp|extended release|delayed release|er|dr)\b/gi, '')
      .replace(/[^a-z0-9 .'-]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim())
    : ''

  return { name, dose, text }
}

export async function scanMedicationLabel(file, onProgress) {
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('eng', undefined, {
    logger: (message) => {
      if (message.status === 'recognizing text') onProgress(Math.round(message.progress * 100))
    },
  })
  try {
    const result = await worker.recognize(file, { rotateAuto: true })
    return { ...parseMedicationLabel(result.data.text), confidence: Math.round(result.data.confidence) }
  } finally {
    await worker.terminate()
  }
}
