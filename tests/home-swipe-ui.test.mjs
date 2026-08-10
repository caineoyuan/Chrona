import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('set cards use captured pointer gestures for reveal and completion swipes', async () => {
  const [source, css] = await Promise.all([
    readFile(new URL('../src/components/Home.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/index.css', import.meta.url), 'utf8'),
  ])

  assert.match(source, /const dxRef = useRef\(0\)/)
  assert.match(source, /setPointerCapture\(event\.pointerId\)/)
  assert.match(source, /onPointerMove=\{\(event\) => onMove\(event\.clientX\)\}/)
  assert.match(source, /onPointerUp=\{onEnd\}/)
  assert.match(source, /onPointerCancel=\{onCancel\}/)
  assert.match(css, /\.workspace-chrona \.card-wrap > \.card \{[^}]*touch-action: pan-y;/)
})
