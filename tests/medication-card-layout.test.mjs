import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('medication list cards use their full width and show concise schedule details', async () => {
  const [app, css] = await Promise.all([
    readFile(new URL('../src/medira/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/medira/index.css', import.meta.url), 'utf8'),
  ])

  const card = app.slice(
    app.indexOf('className="card med-card clickable"'),
    app.indexOf('</article>', app.indexOf('className="card med-card clickable"')),
  )

  assert.match(card, /<span className="meta-pill">\{frequencyLabel\(med\)\}<\/span>/)
  assert.match(card, /<span>Frequency<strong>\{scheduleLabels\(med\)\[0\]\}<\/strong><\/span>/)
  assert.doesNotMatch(card, /How to take|Doses taken|Starts /)
  assert.match(
    css,
    /\.med-grid \.med-card \{[^}]*grid-template-columns: 36px minmax\(0, 1fr\);[^}]*column-gap: 8px;/,
  )
  assert.match(css, /\.med-grid \.med-card-head \{[^}]*grid-column: 1;[^}]*grid-row: 1;/)
  assert.match(
    css,
    /\.med-grid \.notes, \.med-grid \.inventory-row, \.med-grid \.med-footer \{[^}]*grid-column: 2;[^}]*width: 100%;/,
  )
})
