import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import cookieParser from 'cookie-parser'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import {
  createAuthRouter,
  normalizeTimezone,
  profileFromRow,
} from '../server/auth.js'

process.env.JWT_SECRET = 'test-secret'
process.env.REGISTRATION_KEY = 'test-registration-key'

async function request(router, path, options = {}) {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/auth', router)
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    const address = server.address()
    return await fetch(`http://127.0.0.1:${address.port}/api/auth${path}`, options)
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

test('timezone validation accepts IANA zones and rejects invalid values', () => {
  assert.equal(normalizeTimezone('America/Los_Angeles'), 'America/Los_Angeles')
  assert.equal(normalizeTimezone('not/a-zone'), null)
  assert.equal(normalizeTimezone(undefined, 'UTC'), 'UTC')
})

test('profile response contains stable account fields', () => {
  assert.deepEqual(
    profileFromRow({
      id: 7,
      username: 'local-name',
      display_username: 'Display Name',
      timezone: 'Europe/Paris',
    }),
    {
      id: 7,
      username: 'local-name',
      displayUsername: 'Display Name',
      timezone: 'Europe/Paris',
      avatar: { type: 'initial', initial: 'D', color: '1789FC' },
    },
  )
})

test('/me returns the authenticated account profile', async () => {
  const query = async (_text, params) => {
    assert.deepEqual(params, [11])
    return {
      rows: [{
        id: 11,
        username: 'account',
        display_username: 'Account',
        timezone: 'Europe/London',
      }],
    }
  }
  const token = jwt.sign({ uid: 11 }, process.env.JWT_SECRET, { expiresIn: '1d' })
  const response = await request(createAuthRouter(query), '/me', {
    headers: { Cookie: `chrona_token=${token}` },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    id: 11,
    username: 'account',
    displayUsername: 'Account',
    timezone: 'Europe/London',
    avatar: { type: 'initial', initial: 'A', color: '5EB1BF' },
  })
})

test('/me reloads a persisted avatar selection without exposing storage metadata', async () => {
  const query = async () => ({
    rows: [{
      id: 11,
      username: 'account',
      display_username: 'Account',
      timezone: 'Europe/London',
      avatar_kind: 'upload',
      avatar_value: null,
      avatar_color: null,
      avatar_file: 'private-storage-name.webp',
    }],
  })
  const token = jwt.sign({ uid: 11 }, process.env.JWT_SECRET, { expiresIn: '1d' })
  const response = await request(createAuthRouter(query), '/me', {
    headers: { Cookie: `chrona_token=${token}` },
  })
  const profile = await response.json()

  assert.equal(response.status, 200)
  assert.deepEqual(profile.avatar, { type: 'upload', url: '/api/profile/avatar/11' })
  assert.equal(JSON.stringify(profile).includes('private-storage-name'), false)
})

test('authenticated users can change their username and local login identity', async () => {
  const calls = []
  const query = async (text, params) => {
    calls.push({ text, params })
    return {
      rows: [{
        id: 11,
        username: 'new.name',
        display_username: 'new.name',
        timezone: 'Europe/London',
      }],
    }
  }
  const token = jwt.sign({ uid: 11 }, process.env.JWT_SECRET, { expiresIn: '1d' })
  const response = await request(createAuthRouter(query), '/profile/username', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `chrona_token=${token}`,
    },
    body: JSON.stringify({ username: ' New.Name ' }),
  })

  assert.equal(response.status, 200)
  assert.equal((await response.json()).username, 'new.name')
  assert.deepEqual(calls[0].params, ['new.name', 11])
  assert.match(calls[0].text, /SET username = \$1, display_username = \$1/)
  assert.match(calls[0].text, /UPDATE user_identities/)
  assert.match(calls[0].text, /SET provider_subject = \$1/)
})

test('register creates the user and local identity together without replacing user id', async () => {
  const calls = []
  const query = async (text, params) => {
    calls.push({ text, params })
    return {
      rows: [{
        id: 42,
        username: 'new.user',
        display_username: 'new.user',
        timezone: 'America/New_York',
      }],
    }
  }

  const response = await request(createAuthRouter(query), '/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'New.User',
      password: 'long-enough-password',
      confirm: 'long-enough-password',
      key: 'test-registration-key',
      timezone: 'America/New_York',
    }),
  })

  assert.equal(response.status, 201)
  assert.deepEqual(await response.json(), {
    id: 42,
    username: 'new.user',
    displayUsername: 'new.user',
    timezone: 'America/New_York',
    avatar: { type: 'initial', initial: 'N', color: '465362' },
  })
  assert.match(response.headers.get('set-cookie'), /chrona_token=/)
  assert.match(calls[0].text, /INSERT INTO user_identities/)
  assert.match(calls[0].text, /SELECT id, 'local', \$1, \$2 FROM new_user/)
  assert.equal(calls[0].params[0], 'new.user')
  assert.equal(calls[0].params[2], 'America/New_York')
})

test('legacy password login backfills a local identity and keeps JWT cookie behavior', async () => {
  const passwordHash = await bcrypt.hash('legacy-password', 4)
  const calls = []
  const query = async (text, params) => {
    calls.push({ text, params })
    if (text.includes('FROM users u')) {
      return {
        rows: [{
          id: 9,
          username: 'legacy',
          display_username: 'legacy',
          timezone: 'UTC',
          status: 'active',
          identity_id: null,
          password_hash: passwordHash,
        }],
      }
    }
    return { rows: [] }
  }

  const response = await request(createAuthRouter(query), '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'legacy',
      password: 'legacy-password',
      remember: true,
    }),
  })

  assert.equal(response.status, 200)
  assert.equal((await response.json()).username, 'legacy')
  assert.match(response.headers.get('set-cookie'), /chrona_token=/)
  assert.match(response.headers.get('set-cookie'), /Max-Age=2592000/)
  assert.match(calls[1].text, /INSERT INTO user_identities/)
  assert.deepEqual(calls[1].params, [9, 'legacy', passwordHash])
})

test('profile timezone API validates and persists an IANA timezone', async () => {
  const calls = []
  const query = async (text, params) => {
    calls.push({ text, params })
    return {
      rows: [{
        id: 5,
        username: 'profile',
        display_username: 'Profile',
        timezone: params[0],
      }],
    }
  }
  const token = jwt.sign({ uid: 5 }, process.env.JWT_SECRET, { expiresIn: '1d' })
  const headers = {
    'Content-Type': 'application/json',
    Cookie: `chrona_token=${token}`,
  }

  const invalid = await request(createAuthRouter(query), '/profile/timezone', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ timezone: 'Mars/Olympus_Mons' }),
  })
  assert.equal(invalid.status, 400)
  assert.equal(calls.length, 0)

  const valid = await request(createAuthRouter(query), '/profile/timezone', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ timezone: 'Asia/Tokyo' }),
  })
  assert.equal(valid.status, 200)
  assert.equal((await valid.json()).timezone, 'Asia/Tokyo')
  assert.match(calls[0].text, /UPDATE users SET timezone/)
  assert.deepEqual(calls[0].params, ['Asia/Tokyo', 5])
})
