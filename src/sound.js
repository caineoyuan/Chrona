// Shared one-shot sound effects.
let completeAudio = null

export function playComplete() {
  try {
    if (!completeAudio) completeAudio = new Audio('/complete.wav')
    completeAudio.currentTime = 0
    completeAudio.play().catch(() => {})
  } catch {
    /* ignore */
  }
}
