const API_URL = 'https://api.fda.gov/drug/label.json'

function first(value) {
  return Array.isArray(value) ? value[0] : ''
}

function extractStrength(label) {
  const text = first(label.active_ingredient) || first(label.description) || ''
  return text.match(/\b\d+(?:\.\d+)?\s*(?:mcg|µg|mg|g|ml|units?|iu|%)(?:\s*\/\s*\d+(?:\.\d+)?\s*(?:ml|mg))?\b/i)?.[0] || ''
}

export function inferScheduleRecommendation(value) {
  const text = String(value || '').toLowerCase()
  const everyHours = text.match(/\bevery\s+(3|4|5|6|7|8|9|10|11|12|24)\s*(?:hours?|hrs?)\b/)
  if (everyHours) {
    const intervalHours = Number(everyHours[1])
    return intervalHours === 24
      ? { type: 'daily', intervalHours: 24, times: ['11:00'], weekdays: [] }
      : { type: 'interval', intervalHours, times: [], weekdays: [] }
  }

  if (/\b(?:four|4)\s+times?\s+(?:a\s+day|daily|per\s+day)\b|\bfour\s+times\s+daily\b/.test(text)) {
    return { type: 'interval', intervalHours: 6, times: [], weekdays: [] }
  }
  if (/\b(?:three|3)\s+times?\s+(?:a\s+day|daily|per\s+day)\b|\bthree\s+times\s+daily\b/.test(text)) {
    return { type: 'interval', intervalHours: 8, times: [], weekdays: [] }
  }
  if (/\b(?:twice|two|2)\s+(?:times?\s+)?(?:a\s+day|daily|per\s+day)\b|\btwice\s+daily\b/.test(text)) {
    return { type: 'interval', intervalHours: 12, times: [], weekdays: [] }
  }
  if (/\b(?:three|3)\s+times?\s+(?:a|per)\s+week\b/.test(text)) {
    return { type: 'weekly', intervalHours: 56, times: ['11:00'], weekdays: [1, 3, 5] }
  }
  if (/\b(?:twice|two|2)\s+(?:times?\s+)?(?:a|per)\s+week\b/.test(text)) {
    return { type: 'weekly', intervalHours: 84, times: ['11:00'], weekdays: [1, 4] }
  }
  if (/\b(?:once\s+)?weekly\b|\bonce\s+(?:a|per)\s+week\b|\bevery\s+week\b/.test(text)) {
    return { type: 'weekly', intervalHours: 168, times: ['11:00'], weekdays: [1] }
  }
  if (/\bonce\s+daily\b|\bonce\s+a\s+day\b|\bevery\s+day\b|\bdaily\b/.test(text)) {
    return { type: 'daily', intervalHours: 24, times: ['11:00'], weekdays: [] }
  }
  return null
}

function mapLabel(label) {
  const data = label.openfda || {}
  const brandName = first(data.brand_name)
  const genericName = first(data.generic_name) || first(data.substance_name)
  const route = first(data.route)
  const form = first(data.dosage_form)
  const manufacturer = first(data.manufacturer_name)
  const dosageInstructions = first(label.dosage_and_administration)
  return {
    id: label.id || `${brandName}-${genericName}-${manufacturer}`,
    name: brandName || genericName,
    genericName,
    dose: extractStrength(label),
    route,
    form,
    manufacturer,
    scheduleRecommendation: inferScheduleRecommendation(dosageInstructions),
    notes: [route && `Route: ${route.toLowerCase()}`, form && `Form: ${form.toLowerCase()}`].filter(Boolean).join('. '),
  }
}

export async function searchOpenFda(query, signal) {
  const term = query.trim().replace(/["\\]/g, '')
  if (term.length < 2) return []
  const searches = [`openfda.brand_name:"${term}"`, `openfda.generic_name:"${term}"`]
  const responses = await Promise.all(searches.map(async (search) => {
    const url = new URL(API_URL)
    url.searchParams.set('search', search)
    url.searchParams.set('limit', '5')
    const response = await fetch(url, { signal })
    if (response.status === 404) return []
    if (!response.ok) throw new Error(`OpenFDA request failed with ${response.status}`)
    return (await response.json()).results || []
  }))
  const unique = new Map()
  responses.flat().map(mapLabel).filter((result) => result.name).forEach((result) => {
    const key = `${result.name}|${result.genericName}|${result.dose}`.toLowerCase()
    if (!unique.has(key)) unique.set(key, result)
  })
  return [...unique.values()].slice(0, 6)
}
