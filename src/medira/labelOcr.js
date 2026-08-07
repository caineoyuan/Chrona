const DOSE_PATTERN = /\b\d+(?:\.\d+)?\s*(?:mcg|µg|mg|g|ml|units?|iu|%)(?:\s*\/\s*\d+(?:\.\d+)?\s*(?:ml|mg))?\b/i
const LABEL_NOISE = /\b(?:pharmacy|patient|prescriber|doctor|address|phone|refills?|quantity|qty|rx|warning|discard|expiration|expires|date|take|use|mouth|daily|times|morning|evening)\b/i
const DRUG_SUFFIX = /(?:cillin|cycline|prazole|pril|sartan|statin|olol|formin|oxetine|zepam|caine|vir|azole|mycin|mab|nib)\b/i
const MAX_IMAGE_EDGE = 2000
const MIN_OCR_CONFIDENCE = 40

function titleCase(value) {
  if (value !== value.toUpperCase()) return value
  return value.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}

function plausibleMedicationName(value) {
  const letters = value.replace(/[^a-z]/gi, '')
  const tokens = value.match(/[a-z]{2,}/gi) || []
  if (letters.length < 4 || letters.length > 45 || !tokens.length) return false
  if (!tokens.some((token) => token.length >= 4) && !/^[A-Z]{2,6}$/.test(value)) return false
  return /[aeiouy]/i.test(letters) || /^[A-Z]{2,6}$/.test(value)
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
    const visibleCharacters = line.replace(/\s/g, '')
    const alphaNumericRatio = visibleCharacters
      ? visibleCharacters.replace(/[^a-z0-9]/gi, '').length / visibleCharacters.length
      : 0
    if (alphaNumericRatio < .75) score -= 6
    if ((line.match(/\b[a-z]\b/gi) || []).length >= 3) score -= 5
    if (!/[a-z]{4,}/i.test(line)) score -= 5
    score -= index * .05
    return { line, score }
  }).sort((a, b) => b.score - a.score)

  const best = candidates[0]
  const cleanedName = best && best.score > 1
    ? best.line
      .replace(DOSE_PATTERN, '')
      .replace(/\b(?:tablets?|capsules?|solution|suspension|oral|topical|usp|extended release|delayed release|er|dr)\b/gi, '')
      .replace(/[^a-z0-9 .'-]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    : ''
  const name = plausibleMedicationName(cleanedName) ? titleCase(cleanedName) : ''

  return { name, dose, text }
}

async function prepareOcrImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    bitmap.close()
    throw new Error('Canvas image processing is unavailable.')
  }
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, height)
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  const image = context.getImageData(0, 0, width, height)
  const histogram = new Uint32Array(256)
  for (let index = 0; index < image.data.length; index += 4) {
    const gray = Math.round(image.data[index] * .299 + image.data[index + 1] * .587 + image.data[index + 2] * .114)
    histogram[gray] += 1
  }
  const pixels = width * height
  const percentile = (ratio) => {
    const target = pixels * ratio
    let count = 0
    for (let value = 0; value < histogram.length; value += 1) {
      count += histogram[value]
      if (count >= target) return value
    }
    return 255
  }
  const low = percentile(.02)
  const high = Math.max(low + 1, percentile(.98))
  for (let index = 0; index < image.data.length; index += 4) {
    const gray = image.data[index] * .299 + image.data[index + 1] * .587 + image.data[index + 2] * .114
    const normalized = Math.max(0, Math.min(255, (gray - low) * 255 / (high - low)))
    const enhanced = Math.max(0, Math.min(255, (normalized - 128) * 1.2 + 128))
    image.data[index] = enhanced
    image.data[index + 1] = enhanced
    image.data[index + 2] = enhanced
  }
  context.putImageData(image, 0, 0)
  return canvas
}

export async function scanMedicationLabel(file, onProgress) {
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('eng', undefined, {
    logger: (message) => {
      if (message.status === 'recognizing text') onProgress(Math.round(message.progress * 100))
    },
  })
  try {
    await worker.setParameters({
      preserve_interword_spaces: '1',
      tessedit_pageseg_mode: '11',
      user_defined_dpi: '300',
    })
    const image = await prepareOcrImage(file)
    const result = await worker.recognize(image, { rotateAuto: true })
    const confidence = Math.round(result.data.confidence)
    const parsed = parseMedicationLabel(result.data.text)
    return {
      ...parsed,
      name: confidence >= MIN_OCR_CONFIDENCE ? parsed.name : '',
      dose: confidence >= MIN_OCR_CONFIDENCE ? parsed.dose : '',
      confidence,
    }
  } finally {
    await worker.terminate()
  }
}
