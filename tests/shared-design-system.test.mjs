import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Chrona and Medira consume one shared design-system source', async () => {
  const [main, tokens, primitives, chronaCss, mediraCss, mediraApp, storage, mediraStorage] =
    await Promise.all([
      readFile(new URL('../src/main.jsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/styles/paper-tokens.css', import.meta.url), 'utf8'),
      readFile(new URL('../src/styles/paper-primitives.css', import.meta.url), 'utf8'),
      readFile(new URL('../src/index.css', import.meta.url), 'utf8'),
      readFile(new URL('../src/medira/index.css', import.meta.url), 'utf8'),
      readFile(new URL('../src/medira/App.jsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/storage.js', import.meta.url), 'utf8'),
      readFile(new URL('../src/medira/storage.js', import.meta.url), 'utf8'),
    ])

  assert.match(main, /import '\.\/styles\/paper-tokens\.css'/)
  assert.match(main, /import '\.\/styles\/paper-primitives\.css'/)
  for (const token of ['--bg', '--line', '--text', '--muted', '--font-xs']) {
    assert.match(tokens, new RegExp(`${token}:`))
    assert.doesNotMatch(chronaCss, new RegExp(`${token}:`))
    assert.doesNotMatch(mediraCss, new RegExp(`${token}:`))
  }
  assert.match(tokens, /--card:/)
  assert.match(primitives, /\.card-wrap > \.card/)
  assert.match(primitives, /\.icon-btn \{/)
  assert.match(primitives, /\.modal \{/)
  assert.match(mediraApp, /import Icon from '\.\.\/components\/PaperIcon'/)
  assert.doesNotMatch(mediraApp, /function Icon\(/)
  assert.match(storage, /from '\.\/storage-utils\.js'/)
  assert.match(mediraStorage, /from '\.\.\/storage-utils\.js'/)
})
