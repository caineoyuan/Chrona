import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const publicDir = fileURLToPath(new URL('../public/', import.meta.url))
const manifestPath = path.join(publicDir, 'avatars', 'manifest.json')
const canonicalAssets = [
  {
    id: 'tiger',
    file: 'tiger.svg',
    sha256: '64ee0b9fc2efd0bfa1962e9b95267388d3a6c30320399aedb8a900f3737f6529',
  },
  {
    id: 'giraffe',
    file: 'giraffe.svg',
    sha256: '4aea6bdf6f9a7b44042df4177b6f28feb031ff3e45685492ea326e3cef43d064',
  },
  {
    id: 'goat',
    file: 'goat.svg',
    sha256: '3782c91f7782dcffef329c2ede43688d3e5d623347859efa7619e738578c6219',
  },
]

test('profile avatar manifest has unique, existing canonical assets', async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

  assert.equal(manifest.version, 1)
  assert.equal(manifest.basePath, '/avatars/')
  assert.equal(manifest.license.spdx, 'CC0-1.0')
  assert.deepEqual(
    manifest.avatars.map(({ id, file, sha256 }) => ({ id, file, sha256 })),
    canonicalAssets,
  )

  const ids = new Set()
  const files = new Set()
  const hashes = new Set()

  for (const avatar of manifest.avatars) {
    assert.match(avatar.id, /^[a-z][a-z0-9-]*$/)
    assert.match(avatar.file, /^[a-z][a-z0-9-]*\.svg$/)
    assert.equal(ids.has(avatar.id), false, `duplicate avatar id: ${avatar.id}`)
    assert.equal(files.has(avatar.file), false, `duplicate avatar file: ${avatar.file}`)
    assert.equal(hashes.has(avatar.sha256), false, `duplicate avatar content: ${avatar.file}`)
    ids.add(avatar.id)
    files.add(avatar.file)
    hashes.add(avatar.sha256)

    assert.match(avatar.source.url, /^https:\/\/www\.svgrepo\.com\/svg\/\d+\//)
    assert.match(avatar.source.originalSha256, /^[a-f0-9]{64}$/)

    const asset = await readFile(path.join(publicDir, 'avatars', avatar.file))
    const actualHash = createHash('sha256').update(asset).digest('hex')
    assert.equal(actualHash, avatar.sha256, `hash mismatch: ${avatar.file}`)
    const source = asset.toString('utf8')
    assert.match(source, new RegExp(`<svg[^>]+viewBox="${avatar.viewBox}"`))
    assert.doesNotMatch(
      source,
      /<script|foreignObject|(?:xlink:)?href\s*=|on\w+\s*=|javascript:|<!ENTITY/i,
    )
  }

  const bundledFiles = (await fs.readdir(path.join(publicDir, 'avatars')))
    .filter((file) => file.endsWith('.svg'))
    .sort()
  assert.deepEqual(bundledFiles, canonicalAssets.map(({ file }) => file).sort())
})
