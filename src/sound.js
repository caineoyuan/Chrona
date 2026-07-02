// Shared one-shot sound effects.
let completeAudio = null
let countdownAudio = null

function get(kind) {
  if (kind === 'complete') {
    if (!completeAudio) completeAudio = new Audio('/complete.wav')
    return completeAudio
  }
  if (!countdownAudio) countdownAudio = new Audio('/countdown.wav')
  return countdownAudio
}

// Prime audio elements during a user gesture so later programmatic playback
// (e.g. the completion chime at the end of a run) isn't blocked by autoplay
// policies — notably on iOS, where each element must be unlocked by a gesture.
export function unlockSounds() {
  for (const kind of ['complete', 'countdown']) {
    try {
      const a = get(kind)
      const wasMuted = a.muted
      a.muted = true
      a.play()
        .then(() => {
          a.pause()
          a.currentTime = 0
          a.muted = wasMuted
        })
        .catch(() => {
          a.muted = wasMuted
        })
    } catch {
      /* ignore */
    }
  }
}

export function playComplete() {
  try {
    // Clone a fresh element (like the countdown chime) so playback isn't
    // affected by the shared element's state/unlock priming.
    const a = get('complete').cloneNode()
    a.currentTime = 0
    a.play().catch(() => {})
  } catch {
    /* ignore */
  }
}

// Returns the shared countdown element for cloning (overlapping plays).
export function countdownElement() {
  return get('countdown')
}

