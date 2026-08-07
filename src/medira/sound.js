const SOURCE = '/complete.wav'

let context = null
let buffer = null
let fallback = null

function getContext() {
  if (context) return context
  const AudioContext = window.AudioContext || window.webkitAudioContext
  if (!AudioContext) return null
  context = new AudioContext()
  return context
}

async function loadBuffer() {
  const audioContext = getContext()
  if (!audioContext || buffer) return
  try {
    const response = await fetch(SOURCE)
    const data = await response.arrayBuffer()
    buffer = await audioContext.decodeAudioData(data)
  } catch {
    // HTMLAudio remains available when Web Audio decoding fails.
  }
}

if (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) {
  Promise.resolve().then(loadBuffer)
}

export function unlockSounds() {
  const audioContext = getContext()
  if (audioContext) {
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {})
    const silent = audioContext.createBuffer(1, 1, 22050)
    const source = audioContext.createBufferSource()
    source.buffer = silent
    source.connect(audioContext.destination)
    source.start()
    loadBuffer()
    return
  }
  fallback ||= new Audio(SOURCE)
}

export function playComplete() {
  const audioContext = getContext()
  if (audioContext && buffer) {
    const source = audioContext.createBufferSource()
    source.buffer = buffer
    source.connect(audioContext.destination)
    source.start()
    return
  }
  fallback ||= new Audio(SOURCE)
  fallback.cloneNode().play().catch(() => {})
}
