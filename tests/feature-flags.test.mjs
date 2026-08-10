import assert from 'node:assert/strict'
import test from 'node:test'
import cookieParser from 'cookie-parser'
import express from 'express'
import { envFlag, featureUnavailable } from '../server/feature-flags.js'
import { createMedicationsRouter } from '../server/medications.js'

test('server sharing flag supports an enabled production default and explicit kill switch', () => {
  for (const value of [undefined, '', '0', 'false', 'disabled', ' true-ish ']) {
    assert.equal(envFlag(value), false)
  }
  assert.equal(envFlag(undefined, true), true)
  assert.equal(envFlag('', true), true)
  assert.equal(envFlag('false', true), false)
  for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) {
    assert.equal(envFlag(value), true)
  }
})

test('disabled feature middleware returns a generic 404', () => {
  const response = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
  }
  featureUnavailable({}, response)
  assert.equal(response.statusCode, 404)
  assert.deepEqual(response.body, { error: 'Not found.' })
})

test('disabled medication sharing rejects share management before database access', async () => {
  let queried = false
  const pool = {
    query: async () => {
      queried = true
      throw new Error('database must not be queried')
    },
  }
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/medications', createMedicationsRouter(pool, { sharing: false }))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    const { port } = server.address()
    const response = await fetch(
      `http://127.0.0.1:${port}/api/medications/list/shares`,
    )
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'Not found.' })
    assert.equal(queried, false)
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    )
  }
})

test('client sharing flag is enabled unless explicitly disabled at every entry point', async () => {
  const { readFile } = await import('node:fs/promises')
  const files = await Promise.all([
    readFile(new URL('../src/feature-flags.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/auth.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/Home.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/medira/App.jsx', import.meta.url), 'utf8'),
  ])
  assert.match(files[0], /VITE_SHARING_ENABLED/)
  assert.match(files[0], /sharingSetting !== 'false'/)
  for (const source of files.slice(1)) assert.match(source, /sharingEnabled/)
})
