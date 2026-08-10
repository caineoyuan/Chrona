import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const coverage = []

function covered(name) {
  coverage.push(name)
  console.log(`✓ ${name}`)
}

async function loadEnv() {
  const env = {}
  const raw = await readFile(path.join(root, '.env'), 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const equals = trimmed.indexOf('=')
    if (equals < 1) continue
    let value = trimmed.slice(equals + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    env[trimmed.slice(0, equals).trim()] = value
  }
  return env
}

async function availablePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()))
  return port
}

class Session {
  constructor(baseUrl) {
    this.baseUrl = baseUrl
    this.cookie = ''
  }

  async request(method, route, body) {
    const headers = {}
    if (this.cookie) headers.Cookie = this.cookie
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const options = { method, headers }
    if (body !== undefined) options.body = JSON.stringify(body)
    const response = await fetch(`${this.baseUrl}${route}`, options)
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) this.cookie = setCookie.split(';', 1)[0]
    const text = await response.text()
    let data = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }
    return { status: response.status, headers: response.headers, data }
  }
}

function status(result, expected, label) {
  assert.equal(
    result.status,
    expected,
    `${label}: expected ${expected}, got ${result.status}: ${JSON.stringify(result.data)}`,
  )
  return result.data
}

async function waitForServer(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early (${child.exitCode}).\n${logs.join('')}`)
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Server did not become healthy.\n${logs.join('')}`)
}

async function stopServer(child) {
  if (child.exitCode !== null) return
  child.kill()
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function main() {
  const fileEnv = await loadEnv()
  assert.ok(fileEnv.DATABASE_URL, 'DATABASE_URL must be configured in .env')
  assert.ok(fileEnv.REGISTRATION_KEY, 'REGISTRATION_KEY must be configured in .env')
  assert.ok(fileEnv.JWT_SECRET, 'JWT_SECRET must be configured in .env')

  const port = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const logs = []
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      ...fileEnv,
      PORT: String(port),
      NODE_ENV: 'development',
      SHARING_ENABLED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()))
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()))

  try {
    await waitForServer(baseUrl, child, logs)

    const anonymous = new Session(baseUrl)
    const alice = new Session(baseUrl)
    const bob = new Session(baseUrl)
    const carol = new Session(baseUrl)
    const suffix = Date.now().toString(36)
    const accounts = [
      [alice, `e2e.a.${suffix}`, 'UTC'],
      [bob, `e2e.b.${suffix}`, 'UTC'],
      [carol, `e2e.c.${suffix}`, 'UTC'],
    ]
    const password = `E2e-${suffix}-pass`

    for (const [session, username, timezone] of accounts) {
      status(await session.request('POST', '/api/auth/register', {
        username,
        password,
        confirm: password,
        key: fileEnv.REGISTRATION_KEY,
        timezone,
      }), 201, `register ${username}`)
    }
    const [aliceProfile, bobProfile, carolProfile] = await Promise.all(
      [alice, bob, carol].map(async (session) =>
        status(await session.request('GET', '/api/auth/me'), 200, 'load profile')),
    )
    assert.equal(status(
      await anonymous.request('GET', '/api/buddy-streaks'),
      401,
      'anonymous buddy privacy',
    ).error, 'Not authenticated')
    covered('three newly registered accounts with isolated HTTP cookie jars')

    const definition = {
      name: `Three-person streak ${suffix}`,
      createdAt: new Date().toISOString(),
      schedule: { freq: 'weekly', interval: 1, days: [0, 1, 2, 3, 4, 5, 6] },
    }
    const buddy = status(
      await alice.request('POST', '/api/buddy-streaks', { definition }),
      201,
      'create buddy streak',
    )
    assert.equal(
      (await carol.request('GET', `/api/buddy-streaks/${buddy.id}`)).status,
      404,
    )

    status(await alice.request('POST', '/api/sharing/invitations/username', {
      resourceType: 'buddy_streak',
      resourceId: buddy.id,
      username: bobProfile.username,
      permissions: { role: 'participant' },
    }), 202, 'invite buddy by username')
    const bobInvites = status(
      await bob.request('GET', '/api/sharing/invitations'),
      200,
      'list username invitations',
    )
    const bobBuddyInvite = bobInvites.invitations.find(
      (invite) => invite.resourceType === 'buddy_streak' &&
        invite.resourceId === buddy.id,
    )
    assert.ok(bobBuddyInvite)
    status(
      await bob.request(
        'POST',
        `/api/sharing/invitations/${bobBuddyInvite.id}/accept`,
      ),
      200,
      'accept username invitation',
    )

    const carolLink = status(
      await alice.request('POST', '/api/sharing/invitations/link', {
        resourceType: 'buddy_streak',
        resourceId: buddy.id,
        permissions: { role: 'participant' },
        maxUses: 1,
      }),
      201,
      'create buddy link invitation',
    )
    status(await carol.request('POST', '/api/sharing/invitations/accept', {
      token: carolLink.token,
    }), 200, 'accept buddy link invitation')

    const threePerson = status(
      await alice.request('GET', `/api/buddy-streaks/${buddy.id}`),
      200,
      'load three-person buddy streak',
    )
    assert.deepEqual(
      threePerson.members.map((member) => member.role),
      ['participant', 'participant', 'participant'],
    )
    assert.deepEqual(
      new Set(threePerson.members.map((member) => member.userId)),
      new Set([String(aliceProfile.id), String(bobProfile.id), String(carolProfile.id)]),
    )
    covered('username and link invitations form one three-participant buddy streak')

    const aliceCompletion = status(
      await alice.request('PUT', `/api/buddy-streaks/${buddy.id}/completion`),
      200,
      'Alice completion',
    )
    let occurrence = status(
      await bob.request('GET', `/api/buddy-streaks/${buddy.id}`),
      200,
      'load after first completion',
    )
    assert.equal(occurrence.currentPeriodKey, aliceCompletion.periodKey)
    assert.equal(occurrence.completions.length, 1)
    assert.equal(occurrence.currentOccurrence.participantIds.length, 3)
    occurrence = occurrence.currentOccurrence
    assert.equal(occurrence.completedParticipantIds.length, 1)
    assert.equal(occurrence.complete, false)

    status(
      await bob.request('PUT', `/api/buddy-streaks/${buddy.id}/completion`),
      200,
      'Bob completion',
    )
    occurrence = status(
      await carol.request('GET', `/api/buddy-streaks/${buddy.id}`),
      200,
      'load after second completion',
    ).currentOccurrence
    assert.equal(occurrence.completedParticipantIds.length, 2)
    assert.equal(occurrence.complete, false)
    covered('group occurrence stays incomplete until every participant completes')

    for (let count = 1; count <= 3; count++) {
      status(await alice.request('POST', `/api/buddy-streaks/${buddy.id}/ping`, {
        recipientUserId: String(carolProfile.id),
      }), 201, `allowed ping ${count}`)
    }
    const limitedPing = await alice.request(
      'POST',
      `/api/buddy-streaks/${buddy.id}/ping`,
      { recipientUserId: String(carolProfile.id) },
    )
    status(limitedPing, 429, 'throttled ping')
    assert.match(limitedPing.headers.get('retry-after') || '', /^\d+$/)
    covered('per-sender/recipient/resource ping throttling allows three then returns 429')

    status(
      await carol.request('PUT', `/api/buddy-streaks/${buddy.id}/completion`),
      200,
      'Carol completion',
    )
    const completedBuddy = status(
      await bob.request('GET', `/api/buddy-streaks/${buddy.id}`),
      200,
      'load completed buddy streak',
    )
    assert.equal(completedBuddy.currentOccurrence.complete, true)
    assert.equal(completedBuddy.currentOccurrence.completedParticipantIds.length, 3)
    status(await alice.request('POST', `/api/buddy-streaks/${buddy.id}/ping`, {
      recipientUserId: String(carolProfile.id),
    }), 409, 'reject ping to completed participant')

    const renamed = status(
      await alice.request('PATCH', `/api/buddy-streaks/${buddy.id}`, {
        version: completedBuddy.version,
        definition: { ...definition, name: `${definition.name} persisted` },
      }),
      200,
      'update buddy streak',
    )
    const staleBuddy = await bob.request('PATCH', `/api/buddy-streaks/${buddy.id}`, {
      version: completedBuddy.version,
      definition: { ...definition, name: 'stale buddy write' },
    })
    status(staleBuddy, 409, 'reject stale buddy write')
    assert.equal(staleBuddy.data.currentVersion, renamed.version)
    covered('buddy completion, completed-recipient ping rejection, and stale-write conflict')

    const observerBuddy = status(
      await alice.request('POST', '/api/buddy-streaks', {
        definition: { ...definition, name: `Observer streak ${suffix}` },
      }),
      201,
      'create observer streak',
    )
    status(await alice.request('POST', '/api/sharing/invitations/username', {
      resourceType: 'buddy_streak',
      resourceId: observerBuddy.id,
      username: carolProfile.username,
      permissions: { role: 'observer' },
    }), 202, 'invite observer')
    const observerInvite = status(
      await carol.request('GET', '/api/sharing/invitations'),
      200,
      'list observer invitations',
    ).invitations.find((invite) =>
      invite.resourceType === 'buddy_streak' &&
      invite.resourceId === observerBuddy.id)
    assert.ok(observerInvite)
    status(
      await carol.request(
        'POST',
        `/api/sharing/invitations/${observerInvite.id}/accept`,
      ),
      200,
      'accept observer invitation',
    )
    status(
      await alice.request(
        'PUT',
        `/api/buddy-streaks/${observerBuddy.id}/completion`,
      ),
      200,
      'complete observer-visible streak',
    )
    const observerView = status(
      await carol.request('GET', `/api/buddy-streaks/${observerBuddy.id}`),
      200,
      'observer reads streak',
    )
    assert.equal(observerView.requestingRole, 'observer')
    assert.equal(observerView.canAdminister, false)
    assert.equal(observerView.currentOccurrence.complete, true)
    status(
      await carol.request(
        'PUT',
        `/api/buddy-streaks/${observerBuddy.id}/completion`,
      ),
      403,
      'observer cannot complete',
    )
    assert.equal(
      (await bob.request('GET', `/api/buddy-streaks/${observerBuddy.id}`)).status,
      404,
    )
    covered('observer can see participant status but cannot complete or administer')

    const firstMedication = status(
      await alice.request('POST', '/api/medications/resources', {
        medication: {
          id: `med-primary-${suffix}`,
          name: 'Primary private medication',
          dosage: 'sensitive dosage',
          times: ['08:00'],
          schedule: { freq: 'daily', interval: 1 },
          notifications: { enabled: true },
          paused: false,
          pausePeriods: [],
          inventory: { remaining: 12 },
        },
      }),
      201,
      'create primary medication',
    ).medication
    const firstHistory = status(
      await alice.request(
        'POST',
        `/api/medications/resources/${firstMedication.id}/dose-events`,
        {
          version: firstMedication.version,
          doseEvent: {
            id: `dose-primary-${suffix}`,
            scheduledAt: '2026-08-09T16:00:00.000Z',
            takenAt: '2026-08-09T16:02:00.000Z',
            status: 'on-time',
          },
        },
      ),
      201,
      'create primary medication history',
    )

    status(await alice.request('POST', '/api/sharing/invitations/username', {
      resourceType: 'medication_list',
      resourceId: aliceProfile.id,
      username: bobProfile.username,
      permissions: { role: 'viewer', canViewHistory: false },
    }), 202, 'invite viewer without history')
    const viewerInvite = status(
      await bob.request('GET', '/api/sharing/invitations'),
      200,
      'list medication viewer invitation',
    ).invitations.find((invite) =>
      invite.resourceType === 'medication_list' &&
      invite.resourceId === String(aliceProfile.id))
    assert.ok(viewerInvite)
    status(
      await bob.request(
        'POST',
        `/api/sharing/invitations/${viewerInvite.id}/accept`,
      ),
      200,
      'accept viewer invitation',
    )

    const editorLink = status(
      await alice.request('POST', '/api/sharing/invitations/link', {
        resourceType: 'medication_list',
        resourceId: aliceProfile.id,
        permissions: { role: 'editor', canViewHistory: true },
      }),
      201,
      'create editor history link',
    )
    status(await carol.request('POST', '/api/sharing/invitations/accept', {
      token: editorLink.token,
    }), 200, 'accept editor history link')

    const viewerResource = status(
      await bob.request(
        'GET',
        `/api/medications/resources/${firstMedication.id}`,
      ),
      200,
      'viewer reads medication',
    ).medication
    assert.deepEqual(viewerResource.access, {
      role: 'viewer',
      canViewHistory: false,
      canViewSchedule: false,
      canShare: false,
      ownerUserId: String(aliceProfile.id),
      ownerUsername: aliceProfile.username,
    })
    assert.equal('history' in viewerResource.data, false)
    for (const key of ['times', 'schedule', 'notifications', 'paused', 'pausePeriods']) {
      assert.equal(key in viewerResource.data, false)
    }
    status(
      await bob.request(
        'GET',
        `/api/medications/resources/${firstMedication.id}/dose-events`,
      ),
      403,
      'viewer history privacy',
    )
    status(
      await bob.request(
        'PATCH',
        `/api/medications/resources/${firstMedication.id}`,
        {
          version: firstHistory.version,
          medication: { ...viewerResource.data, name: 'viewer write' },
        },
      ),
      403,
      'viewer cannot edit',
    )

    const editorHistory = status(
      await carol.request(
        'GET',
        `/api/medications/resources/${firstMedication.id}/dose-events`,
      ),
      200,
      'editor reads shared history',
    )
    assert.equal(editorHistory.doseEvents.length, 1)
    const editorResource = status(
      await carol.request(
        'GET',
        `/api/medications/resources/${firstMedication.id}`,
      ),
      200,
      'editor reads medication',
    ).medication
    assert.equal(editorResource.access.canViewSchedule, true)
    const editedMedication = status(
      await carol.request(
        'PATCH',
        `/api/medications/resources/${firstMedication.id}`,
        {
          version: editorResource.version,
          medication: {
            ...editorResource.data,
            name: 'Editor-persisted medication',
          },
        },
      ),
      200,
      'editor updates medication',
    ).medication
    const staleMedication = await alice.request(
      'PATCH',
      `/api/medications/resources/${firstMedication.id}`,
      {
        version: editorResource.version,
        medication: {
          ...editorResource.data,
          name: 'stale medication write',
        },
      },
    )
    status(staleMedication, 409, 'reject stale medication write')
    assert.equal(staleMedication.data.currentVersion, editedMedication.version)
    const secondDose = status(
      await carol.request(
        'POST',
        `/api/medications/resources/${firstMedication.id}/dose-events`,
        {
          version: editedMedication.version,
          doseEvent: {
            id: `dose-editor-${suffix}`,
            scheduledAt: '2026-08-10T16:00:00.000Z',
            takenAt: '2026-08-10T16:04:00.000Z',
            status: 'on-time',
          },
        },
      ),
      201,
      'editor adds history',
    )
    covered('Medira viewer/no-history and editor/history permissions plus conflict handling')

    const secondMedication = status(
      await alice.request('POST', '/api/medications/resources', {
        medication: {
          id: `med-combos-${suffix}`,
          name: 'Permission combinations',
          inventory: { remaining: 4 },
        },
      }),
      201,
      'create combinations medication',
    ).medication
    const secondHistory = status(
      await alice.request(
        'POST',
        `/api/medications/resources/${secondMedication.id}/dose-events`,
        {
          version: secondMedication.version,
          doseEvent: {
            id: `dose-combos-${suffix}`,
            scheduledAt: '2026-08-11T08:00:00.000Z',
            skippedAt: '2026-08-11T08:01:00.000Z',
            status: 'skipped',
          },
        },
      ),
      201,
      'create combinations history',
    )
    const viewerHistoryLink = status(
      await alice.request('POST', '/api/sharing/invitations/link', {
        resourceType: 'medication_list',
        resourceId: aliceProfile.id,
        permissions: { role: 'viewer', canViewHistory: true },
      }),
      201,
      'invite viewer with history',
    )
    status(await bob.request('POST', '/api/sharing/invitations/accept', {
      token: viewerHistoryLink.token,
    }), 200, 'accept viewer history invitation')
    status(await alice.request('POST', '/api/sharing/invitations/username', {
      resourceType: 'medication_list',
      resourceId: aliceProfile.id,
      username: carolProfile.username,
      permissions: { role: 'editor', canViewHistory: false },
    }), 202, 'invite editor without history')
    const editorNoHistoryInvite = status(
      await carol.request('GET', '/api/sharing/invitations'),
      200,
      'list editor no-history invitation',
    ).invitations.find((invite) =>
      invite.resourceType === 'medication_list' &&
      invite.resourceId === String(aliceProfile.id))
    assert.ok(editorNoHistoryInvite)
    status(
      await carol.request(
        'POST',
        `/api/sharing/invitations/${editorNoHistoryInvite.id}/accept`,
      ),
      200,
      'accept editor no-history invitation',
    )
    status(
      await bob.request(
        'GET',
        `/api/medications/resources/${secondMedication.id}/dose-events`,
      ),
      200,
      'viewer with history reads history',
    )
    const secondViewer = status(
      await bob.request(
        'GET',
        `/api/medications/resources/${secondMedication.id}`,
      ),
      200,
      'viewer with history reads resource',
    ).medication
    status(
      await bob.request(
        'PATCH',
        `/api/medications/resources/${secondMedication.id}`,
        {
          version: secondViewer.version,
          medication: { ...secondViewer.data, name: 'viewer cannot write' },
        },
      ),
      403,
      'viewer with history cannot edit',
    )
    const noHistoryEditor = status(
      await carol.request(
        'GET',
        `/api/medications/resources/${secondMedication.id}`,
      ),
      200,
      'editor without history reads resource',
    ).medication
    const noHistoryEdited = status(
      await carol.request(
        'PATCH',
        `/api/medications/resources/${secondMedication.id}`,
        {
          version: noHistoryEditor.version,
          medication: {
            ...noHistoryEditor.data,
            name: 'Editor without history persisted',
          },
        },
      ),
      200,
      'editor without history edits resource',
    ).medication
    status(
      await carol.request(
        'GET',
        `/api/medications/resources/${secondMedication.id}/dose-events`,
      ),
      403,
      'editor without history cannot read history',
    )
    status(
      await carol.request(
        'POST',
        `/api/medications/resources/${secondMedication.id}/dose-events`,
        {
          version: noHistoryEdited.version,
          doseEvent: {
            scheduledAt: '2026-08-12T08:00:00.000Z',
            status: 'scheduled',
          },
        },
      ),
      403,
      'editor without history cannot mutate history',
    )
    covered('Medira viewer/history and editor/no-history combinations')

    const revokedLink = status(
      await alice.request('POST', '/api/sharing/invitations/link', {
        resourceType: 'medication_list',
        resourceId: aliceProfile.id,
        permissions: { role: 'viewer', canViewHistory: false },
      }),
      201,
      'create revocable invitation',
    )
    const pendingShare = status(
      await alice.request(
        'GET',
        '/api/medications/list/shares',
      ),
      200,
      'list pending medication invitations',
    ).invitations.find((invite) => invite.useCount === 0 && invite.username === null)
    assert.ok(pendingShare)
    status(
      await alice.request(
        'DELETE',
        `/api/sharing/invitations/${pendingShare.id}`,
      ),
      200,
      'revoke pending invitation',
    )
    status(await bob.request('POST', '/api/sharing/invitations/accept', {
      token: revokedLink.token,
    }), 404, 'reject revoked invitation')

    const freshBob = new Session(baseUrl)
    const freshCarol = new Session(baseUrl)
    for (const [session, username] of [
      [freshBob, bobProfile.username],
      [freshCarol, carolProfile.username],
    ]) {
      status(await session.request('POST', '/api/auth/login', {
        username,
        password,
        remember: false,
      }), 200, `fresh login ${username}`)
    }
    const reloadedBuddy = status(
      await freshBob.request('GET', `/api/buddy-streaks/${buddy.id}`),
      200,
      'reload buddy persistence',
    )
    assert.equal(reloadedBuddy.currentOccurrence.complete, true)
    assert.equal(reloadedBuddy.definition.name, `${definition.name} persisted`)
    const reloadedMedication = status(
      await freshCarol.request(
        'GET',
        `/api/medications/resources/${secondMedication.id}`,
      ),
      200,
      'reload medication persistence',
    ).medication
    assert.equal(reloadedMedication.data.name, 'Editor without history persisted')
    covered('fresh login sessions preserve buddy and Medira state')

    const privateMedication = status(
      await bob.request('POST', '/api/medications/resources', {
        medication: {
          id: `med-private-${suffix}`,
          name: 'Bob-only secret',
          notes: 'must not leak',
        },
      }),
      201,
      'create private medication',
    ).medication
    assert.equal(
      (await alice.request(
        'GET',
        `/api/medications/resources/${privateMedication.id}`,
      )).status,
      404,
    )
    assert.equal(
      (await carol.request(
        'GET',
        `/api/medications/resources/${privateMedication.id}`,
      )).status,
      404,
    )
    assert.equal(
      (await anonymous.request('GET', '/api/medications/resources')).status,
      401,
    )
    covered('unshared and unauthenticated medication privacy')

    const currentList = status(
      await alice.request(
        'GET',
        '/api/medications/list/shares',
      ),
      200,
      'load version before access revocation',
    )
    const bobRevoked = status(
      await alice.request(
        'DELETE',
        `/api/medications/list/shares/${bobProfile.id}`,
        { version: currentList.version },
      ),
      200,
      'revoke viewer access',
    )
    assert.equal(
      (await bob.request(
        'GET',
        `/api/medications/resources/${firstMedication.id}`,
      )).status,
      404,
    )
    status(
      await alice.request(
        'DELETE',
        `/api/medications/list/shares/${carolProfile.id}`,
        { version: bobRevoked.version },
      ),
      200,
      'revoke editor access',
    )
    assert.equal(
      (await carol.request(
        'GET',
        `/api/medications/resources/${firstMedication.id}`,
      )).status,
      404,
    )
    covered('pending invitation and accepted viewer/editor access revocation')

    assert.equal(secondHistory.version, 2)
    assert.equal(secondDose.version, 4)
    console.log(`\nPASS: ${coverage.length} scenario groups`)
  } finally {
    await stopServer(child)
  }
}

main().catch((error) => {
  console.error(error.stack || error)
  process.exitCode = 1
})
