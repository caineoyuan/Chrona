// Shared one-shot sound effects.
let completeAudio = null

export function playComplete() {
  try {
    if (!completeAudio) completeAudio = new Audio('/complete.mp3')
    completeAudio.currentTime = 0
    completeAudio.play().catch(() => {})
  } catch {
    /* ignore */
  }
}
