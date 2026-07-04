// Shared one-shot sound effects.
//
// iOS Safari blocks programmatic playback of <audio> elements unless the exact
// element was started during a user gesture — and it never allows overlapping
// plays from a single element. The Web Audio API sidesteps both problems: after
// the AudioContext is unlocked once (on a tap), we can fire any number of
// overlapping BufferSource nodes with no further gestures.

const SOURCES = {
  countdown: '/countdown.wav',
  complete: '/complete.wav',
}

let ctx = null
const buffers = {} // kind -> decoded AudioBuffer
const htmlFallback = {} // kind -> HTMLAudioElement (used when Web Audio absent)

function getContext() {
  if (ctx) return ctx
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null
  ctx = new AC()
  return ctx
}

// Decode both buffers eagerly. Decoding works even while the context is
// suspended, so the sounds are ready the moment a gesture unlocks playback.
if (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) {
  Promise.resolve().then(() => {
    loadBuffer('countdown')
    loadBuffer('complete')
  })
}

async function loadBuffer(kind) {
  const context = getContext()
  if (!context || buffers[kind]) return
  try {
    const res = await fetch(SOURCES[kind])
    const data = await res.arrayBuffer()
    buffers[kind] = await new Promise((resolve, reject) =>
      context.decodeAudioData(data, resolve, reject),
    )
  } catch {
    /* ignore — will fall back to HTMLAudio */
  }
}

// Prime audio during a user gesture so later programmatic playback isn't
// blocked. Resumes/unlocks the AudioContext and pre-decodes both buffers.
export function unlockSounds() {
  const context = getContext()
  if (context) {
    if (context.state === 'suspended') context.resume().catch(() => {})
    // A silent 1-sample blip fully unlocks the context on iOS.
    try {
      const buf = context.createBuffer(1, 1, 22050)
      const src = context.createBufferSource()
      src.buffer = buf
      src.connect(context.destination)
      src.start(0)
    } catch {
      /* ignore */
    }
    loadBuffer('countdown')
    loadBuffer('complete')
    return
  }
  // No Web Audio: prime HTMLAudio elements instead.
  for (const kind of Object.keys(SOURCES)) {
    try {
      const a = htmlFallback[kind] || (htmlFallback[kind] = new Audio(SOURCES[kind]))
      a.muted = true
      a.play()
        .then(() => {
          a.pause()
          a.currentTime = 0
          a.muted = false
        })
        .catch(() => {
          a.muted = false
        })
    } catch {
      /* ignore */
    }
  }
}

function play(kind) {
  const context = getContext()
  if (context && buffers[kind]) {
    try {
      if (context.state === 'suspended') context.resume().catch(() => {})
      const src = context.createBufferSource()
      src.buffer = buffers[kind]
      src.connect(context.destination)
      src.start(0)
      return
    } catch {
      /* fall through to HTMLAudio */
    }
  }
  // Fallback: clone an HTMLAudio element for overlapping playback.
  try {
    const base = htmlFallback[kind] || (htmlFallback[kind] = new Audio(SOURCES[kind]))
    const a = base.cloneNode()
    a.play().catch(() => {})
  } catch {
    /* ignore */
  }
}

export function playCountdown() {
  play('countdown')
}

export function playComplete() {
  play('complete')
}

