import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import cookieParser from 'cookie-parser'
import express from 'express'
import jwt from 'jsonwebtoken'
import sharp from 'sharp'
import { requireAuth } from '../server/auth.js'
import {
  AVATAR_COLORS,
  MAX_AVATAR_BYTES,
  createProfileRouter,
  defaultAvatarFor,
  normalizeAvatarColor,
  normalizeUploadedAvatar,
  profileFromRow,
} from '../server/profile.js'

process.env.JWT_SECRET = 'test-secret'

const testRoot = path.resolve('.test-avatar-data')

async function request(router, route = '/', options = {}) {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/profile', router)
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    const address = server.address()
    return await fetch(`http://127.0.0.1:${address.port}/api/profile${route}`, options)
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

function authHeaders(extra = {}) {
  const token = jwt.sign({ uid: 21 }, process.env.JWT_SECRET, { expiresIn: '1d' })
  return { Cookie: `chrona_token=${token}`, ...extra }
}

function memoryProfileQuery(initial = {}) {
  let row = {
    id: 21,
    username: 'profile.user',
    display_username: 'Profile User',
    timezone: 'UTC',
    avatar_kind: null,
    avatar_value: null,
    avatar_color: null,
    avatar_file: null,
    ...initial,
  }
  const calls = []
  return {
    calls,
    current: () => ({ ...row }),
    query: async (text, params) => {
      calls.push({ text, params })
      if (text.includes('UPDATE users')) {
        const replaced_avatar_file = row.avatar_file
        if (text.includes("avatar_kind = 'upload'")) {
          row = {
            ...row,
            avatar_kind: 'upload',
            avatar_value: null,
            avatar_color: null,
            avatar_file: params[0],
          }
        } else if (text.includes('avatar_kind = NULL')) {
          row = {
            ...row,
            avatar_kind: null,
            avatar_value: null,
            avatar_color: null,
            avatar_file: null,
          }
        } else {
          row = {
            ...row,
            avatar_kind: params[0],
            avatar_value: params[1],
            avatar_color: params[2],
            avatar_file: null,
          }
        }
        return { rows: [{ ...row, replaced_avatar_file }] }
      }
      if (text.includes('SELECT avatar_file FROM users')) {
        return { rows: row.avatar_kind === 'upload' ? [{ avatar_file: row.avatar_file }] : [] }
      }
      return { rows: [{ ...row }] }
    },
  }
}

test.after(async () => {
  await fs.rm(testRoot, { recursive: true, force: true })
})

test('default initial avatars and palette validation are deterministic', () => {
  const user = { id: 21, username: 'profile.user', display_username: 'Profile User' }
  assert.deepEqual(defaultAvatarFor(user), defaultAvatarFor(user))
  assert.match(defaultAvatarFor(user).initial, /^[A-Z]$/)
  assert.ok(AVATAR_COLORS.includes(defaultAvatarFor(user).color))
  assert.equal(normalizeAvatarColor('#52aa8a'), '52AA8A')
  assert.equal(normalizeAvatarColor('ffffff'), null)
  assert.equal(new Set(AVATAR_COLORS).size, 13)
  assert.deepEqual(AVATAR_COLORS, [
    '52AA8A', '52AA5E', '388659', 'E26D5C', 'FDB833',
    '1789FC', '4A5759', 'F26157', 'EF7B45', '5EB1BF',
    '94DDBC', '136F63', '465362',
  ])
})

test('profile serialization supports bundled and uploaded avatars without filesystem paths', () => {
  const base = {
    id: 21,
    username: 'profile.user',
    display_username: 'Profile User',
    timezone: 'UTC',
  }
  assert.deepEqual(profileFromRow({ ...base, avatar_kind: 'bundled', avatar_value: 'tiger' }).avatar, {
    type: 'bundled',
    id: 'tiger',
    url: '/avatars/tiger.svg',
  })
  const uploaded = profileFromRow({
    ...base,
    avatar_kind: 'upload',
    avatar_file: 'private-file.webp',
  })
  assert.deepEqual(uploaded.avatar, { type: 'upload', url: '/api/profile/avatar/21' })
  assert.equal(JSON.stringify(uploaded).includes('private-file'), false)
})

test('avatar choice API validates palette and manifest ids and requires authorization', async () => {
  const store = memoryProfileQuery()
  const router = createProfileRouter({
    queryFn: store.query,
    requireAuth,
    uploadDirectory: testRoot,
  })

  const unauthorized = await request(router, '/', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatar: { type: 'initial', color: '52AA8A' } }),
  })
  assert.equal(unauthorized.status, 401)
  assert.equal(store.calls.length, 0)

  const invalidColor = await request(router, '/', {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ avatar: { type: 'initial', color: 'FFFFFF' } }),
  })
  assert.equal(invalidColor.status, 400)

  const invalidId = await request(router, '/', {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ avatar: { type: 'bundled', id: '../secret' } }),
  })
  assert.equal(invalidId.status, 400)

  const valid = await request(router, '/', {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ avatar: { type: 'bundled', id: 'giraffe' } }),
  })
  assert.equal(valid.status, 200)
  assert.equal((await valid.json()).avatar.id, 'giraffe')
  assert.equal(store.current().avatar_value, 'giraffe')
})

test('all 13 initial colors persist exactly and survive a profile reload', async () => {
  const store = memoryProfileQuery()
  const router = createProfileRouter({
    queryFn: store.query,
    requireAuth,
    uploadDirectory: testRoot,
  })

  for (const color of AVATAR_COLORS) {
    const saved = await request(router, '/', {
      method: 'PATCH',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ avatar: { type: 'initial', color: `#${color.toLowerCase()}` } }),
    })
    assert.equal(saved.status, 200)
    assert.equal((await saved.json()).avatar.color, color)
    assert.equal(store.current().avatar_color, color)

    const reloaded = await request(router, '/', { headers: authHeaders() })
    assert.equal(reloaded.status, 200)
    assert.equal((await reloaded.json()).avatar.color, color)
  }
})

test('image normalization center-crops to a safe square WebP', async () => {
  const left = await sharp({
    create: { width: 200, height: 200, channels: 3, background: '#ff0000' },
  }).png().toBuffer()
  const right = await sharp({
    create: { width: 200, height: 200, channels: 3, background: '#0000ff' },
  }).png().toBuffer()
  const source = await sharp({
    create: { width: 400, height: 200, channels: 3, background: '#000000' },
  }).composite([
    { input: left, left: 0, top: 0 },
    { input: right, left: 200, top: 0 },
  ]).png().toBuffer()

  const normalized = await normalizeUploadedAvatar(source, 'image/png')
  const metadata = await sharp(normalized).metadata()
  assert.equal(metadata.format, 'webp')
  assert.equal(metadata.width, 256)
  assert.equal(metadata.height, 256)

  const { data, info } = await sharp(normalized).raw().toBuffer({ resolveWithObject: true })
  const leftPixel = data.subarray(info.channels * (128 * info.width + 10), info.channels * (128 * info.width + 10) + 3)
  const rightPixel = data.subarray(info.channels * (128 * info.width + 245), info.channels * (128 * info.width + 245) + 3)
  assert.ok(leftPixel[0] > leftPixel[2], 'left side should retain red center-crop content')
  assert.ok(rightPixel[2] > rightPixel[0], 'right side should retain blue center-crop content')
})

test('uploads reject mismatched signatures, SVG, and oversized input explicitly', async () => {
  await assert.rejects(
    normalizeUploadedAvatar(Buffer.from('<svg></svg>'), 'image/png'),
    /valid PNG, JPEG, or WebP/,
  )
  await assert.rejects(
    normalizeUploadedAvatar(Buffer.from('<svg></svg>'), 'image/svg+xml'),
    /SVG uploads are not allowed/,
  )
  await assert.rejects(
    normalizeUploadedAvatar(Buffer.alloc(MAX_AVATAR_BYTES + 1), 'image/png'),
    /5 MB or smaller/,
  )
})

test('upload API rejects unauthorized, unsupported, malformed, and oversized requests', async () => {
  const store = memoryProfileQuery()
  const router = createProfileRouter({
    queryFn: store.query,
    requireAuth,
    uploadDirectory: testRoot,
  })
  const valid = await sharp({
    create: { width: 32, height: 32, channels: 3, background: '#52AA8A' },
  }).png().toBuffer()

  const unauthorized = await request(router, '/avatar', {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: valid,
  })
  assert.equal(unauthorized.status, 401)

  const svg = await request(router, '/avatar', {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'image/svg+xml' }),
    body: '<svg/>',
  })
  assert.equal(svg.status, 415)

  const malformed = await request(router, '/avatar', {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'image/png' }),
    body: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from('not-an-image'),
    ]),
  })
  assert.equal(malformed.status, 400)

  const oversized = await request(router, '/avatar', {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'image/png' }),
    body: Buffer.alloc(MAX_AVATAR_BYTES + 1),
  })
  assert.equal(oversized.status, 413)
  assert.equal(store.current().avatar_file, null)
})

test('upload replacement and removal persist metadata and clean private files', async () => {
  const directory = path.join(testRoot, 'replacement')
  const store = memoryProfileQuery()
  const router = createProfileRouter({
    queryFn: store.query,
    requireAuth,
    uploadDirectory: directory,
  })
  const firstImage = await sharp({
    create: { width: 320, height: 200, channels: 3, background: '#52AA8A' },
  }).png().toBuffer()
  const secondImage = await sharp({
    create: { width: 200, height: 320, channels: 3, background: '#E26D5C' },
  }).jpeg().toBuffer()

  const first = await request(router, '/avatar', {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'image/png' }),
    body: firstImage,
  })
  assert.equal(first.status, 200)
  const firstFile = store.current().avatar_file
  assert.match(firstFile, /^[0-9a-f-]+\.webp$/)
  assert.equal((await fs.stat(path.join(directory, firstFile))).isFile(), true)

  const second = await request(router, '/avatar', {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'image/jpeg' }),
    body: secondImage,
  })
  assert.equal(second.status, 200)
  const secondFile = store.current().avatar_file
  await assert.rejects(fs.access(path.join(directory, firstFile)), /ENOENT/)
  assert.equal((await fs.stat(path.join(directory, secondFile))).isFile(), true)
  assert.deepEqual((await second.json()).avatar, {
    type: 'upload',
    url: '/api/profile/avatar/21',
  })

  const removed = await request(router, '/avatar', {
    method: 'DELETE',
    headers: authHeaders(),
  })
  assert.equal(removed.status, 200)
  assert.equal((await removed.json()).avatar.type, 'initial')
  assert.equal(store.current().avatar_file, null)
  await assert.rejects(fs.access(path.join(directory, secondFile)), /ENOENT/)
})

test('switching an upload to a bundled avatar cleans the replaced private file', async () => {
  const directory = path.join(testRoot, 'choice-cleanup')
  const store = memoryProfileQuery()
  const router = createProfileRouter({
    queryFn: store.query,
    requireAuth,
    uploadDirectory: directory,
  })
  const image = await sharp({
    create: { width: 100, height: 80, channels: 3, background: '#1789FC' },
  }).webp().toBuffer()

  const uploaded = await request(router, '/avatar', {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'image/webp' }),
    body: image,
  })
  assert.equal(uploaded.status, 200)
  const oldFile = store.current().avatar_file

  const selected = await request(router, '/', {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ avatar: { type: 'bundled', id: 'goat' } }),
  })
  assert.equal(selected.status, 200)
  assert.equal((await selected.json()).avatar.id, 'goat')
  await assert.rejects(fs.access(path.join(directory, oldFile)), /ENOENT/)
})

test('stored avatar reads stay authenticated and expose only normalized image bytes', async () => {
  const directory = path.join(testRoot, 'read')
  const store = memoryProfileQuery()
  const router = createProfileRouter({
    queryFn: store.query,
    requireAuth,
    uploadDirectory: directory,
  })
  const image = await sharp({
    create: { width: 90, height: 120, channels: 3, background: '#E26D5C' },
  }).jpeg().toBuffer()
  await request(router, '/avatar', {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'image/jpeg' }),
    body: image,
  })

  const unauthorized = await request(router, '/avatar/21')
  assert.equal(unauthorized.status, 401)
  const invalidId = await request(router, '/avatar/..%5Csecret', { headers: authHeaders() })
  assert.equal(invalidId.status, 400)

  const response = await request(router, '/avatar/21', { headers: authHeaders() })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/webp')
  assert.equal(response.headers.get('cache-control'), 'private, max-age=3600')
  assert.equal(response.headers.get('content-disposition'), null)
  const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata()
  assert.equal(metadata.width, 256)
  assert.equal(metadata.height, 256)
})

test('stored avatar reads reject traversal-like database values', async () => {
  const store = memoryProfileQuery({
    avatar_kind: 'upload',
    avatar_file: '..\\secret.webp',
  })
  const response = await request(createProfileRouter({
    queryFn: store.query,
    requireAuth,
    uploadDirectory: testRoot,
  }), '/avatar/21', { headers: authHeaders() })
  assert.equal(response.status, 404)
})
