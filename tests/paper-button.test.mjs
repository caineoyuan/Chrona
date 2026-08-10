import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('Chrona and Medira share the Paper control primitives', async () => {
  const [button, controlsCss, css, medira, sharing, run, home, icons] = await Promise.all([
    readFile(new URL('../src/components/PaperButton.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/paper-buttons.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/index.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/medira/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/SharingUI.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/RunView.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/Home.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/Icon.jsx', import.meta.url), 'utf8'),
  ])

  assert.match(button, /export function IconButton/)
  assert.match(button, /variant === 'swipe' \? 'swipe-act' : 'icon-btn'/)
  assert.match(button, /<Icon name=\{name\} size=\{iconSize\} className=\{iconClassName\}/)
  assert.match(medira, /IconButton as PaperIconButton/)
  assert.match(medira, /<PaperIconButton label=\{label\}/)
  assert.match(sharing, /IconButton as ButtonIcon/)
  assert.match(run, /import \{ IconButton \} from '\.\/PaperButton\.jsx'/)
  assert.match(home, /variant="swipe"/)
  assert.equal((home.match(/iconSize=\{17\} iconClassName="action-glyph"/g) || []).length, 3)
  assert.match(controlsCss, /\.swipe-act\.danger \{[^}]*color: #fff;/)
  assert.match(css, /html\[data-theme='light'\] \.workspace-chrona \.swipe-act,[\s\S]*color: #fff;[\s\S]*background: rgba\(255, 255, 255, 0\.18\);[\s\S]*border: 0;/)
  assert.match(controlsCss, /\.swipe-act \.action-glyph \[data-part='person'\],[\s\S]*\.swipe-act \.action-glyph \[data-part='plus'\] \{[^}]*opacity: 1;[^}]*fill: #fff;/)
  assert.match(controlsCss, /\.swipe-act \.action-glyph \[data-part='plus-circle'\] \{[^}]*opacity: \.4;[^}]*fill: #fff;/)
  assert.match(button, /export function CheckCircleButton/)
  assert.match(button, /import \{ CheckmarkFilled \} from '@fluentui\/react-icons\/svg\/checkmark'/)
  assert.match(button, /<CheckmarkFilled className="icon" fontSize=\{20\}/)
  assert.match(button, /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/)
  assert.match(button, /onChange\?\.\(!complete\)/)
  assert.match(medira, /<CheckCircleButton/)
  assert.match(medira, /function MedicationCardShell/)
  assert.match(medira, /className="med-card-actions"/)
  assert.equal((medira.match(/<PaperIconButton variant="swipe"/g) || []).length, 3)
  assert.match(await readFile(new URL('../src/medira/index.css', import.meta.url), 'utf8'),
    /\.medira-shell\.dark \.med-card-actions \.swipe-act,[\s\S]*background: rgba\(0, 0, 0, \.3\);/)
  assert.match(home, /<CheckCircleButton/)
  assert.match(controlsCss, /\.taken-toggle\.complete/)
  assert.match(home, /!set\.trackStreak && !buddyStreak/)
  assert.match(home, /Object\.values\(set\.completions \|\| \{\}\)/)
  assert.match(home, /<span className="streak-label">times completed<\/span>/)
  assert.match(icons, /stone: \{ img: '\/stone-icon\.svg' \}/)
  assert.match(css, /html\[data-theme='light'\] img\[src\$='stone-icon\.svg'\],[\s\S]*html\[data-theme='light'\] \.streak-flame \{[\s\S]*drop-shadow/)
})
