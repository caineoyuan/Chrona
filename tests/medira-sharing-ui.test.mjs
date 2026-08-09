import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { invitationClient } from '../src/invitations.js'
import {
  medicationPermissions,
  medicationResourceClient,
} from '../src/medira/scoped-medications.js'

test('medication permissions keep viewer history and editing independently gated', () => {
  assert.deepEqual(medicationPermissions({
    resourceAccess: {
      role: 'viewer',
      canViewHistory: true,
      canShare: false,
      ownerUsername: 'Owner',
    },
  }), {
    role: 'viewer',
    canEdit: false,
    canDelete: false,
    canShare: false,
    canViewHistory: true,
    canViewSchedule: true,
    ownerUserId: null,
    ownerUsername: 'Owner',
  })
  assert.equal(medicationPermissions({
    resourceAccess: { role: 'editor', canViewHistory: false },
  }).canEdit, true)
  assert.equal(medicationPermissions({
    resourceAccess: { role: 'editor', canViewHistory: false },
  }).canViewSchedule, false)
})

test('Medira invitation client sends source-accurate medication permission payloads', async () => {
  const calls = []
  const client = invitationClient(async (path, options) => {
    calls.push({ path, options })
    return { ok: true }
  })
  await client.inviteUsername('7', 'exact.user', {
    role: 'editor',
    canViewHistory: false,
  }, 'medication_list')

  assert.equal(calls[0].path, '/api/sharing/invitations/username')
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    resourceType: 'medication_list',
    resourceId: '7',
    username: 'exact.user',
    permissions: { role: 'editor', canViewHistory: false },
  })
})

test('scoped medication client manages members with optimistic versions', async () => {
  const calls = []
  const client = medicationResourceClient(async (path, options) => {
    calls.push({ path, options })
    return { ok: true, version: 6 }
  })

  await client.listShares()
  await client.revokeShare('9', 5)

  assert.equal(calls[0].path, '/api/medications/list/shares')
  assert.equal(calls[1].path, '/api/medications/list/shares/9')
  assert.deepEqual(JSON.parse(calls[1].options.body), { version: 5 })
})

test('Medira sharing modal preserves mobile scrolling and accessible controls', async () => {
  const [source, css] = await Promise.all([
    readFile(new URL('../src/medira/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/medira/index.css', import.meta.url), 'utf8'),
  ])
  assert.match(source, /aria-pressed=\{role === value\}/)
  assert.match(source, /role="radiogroup"/)
  assert.equal((source.match(/type="radio" name="history-access"/g) || []).length, 2)
  assert.match(source, /Share medication list, dose history &amp; schedule/)
  assert.doesNotMatch(source, /Medication sharing|Separately allows calendars and dose records|type="checkbox" checked=\{canViewHistory\}/)
  assert.match(source, /label="Copy invitation link"/)
  assert.match(source, /label=\{`Revoke access for \$\{member\.username\}`\}/)
  assert.match(source, /className="medication-profile-trigger"/)
  assert.match(source, /<SwapProfileIcon \/>/)
  assert.match(source, /function SharedWith\(\{ members \}\)/)
  assert.match(source, /onMouseEnter=\{\(\) => setHovered\(member\.userId\)\}/)
  assert.match(source, /onClick=\{\(\) => setSelected/)
  assert.match(source, /className="medication-list-toolbar"/)
  assert.match(source, /const switchMedicationProfile = \(ownerUserId\) =>/)
  assert.match(source, /Promise\.all\(\[\s*medicationSync\.refetch\(\),\s*sharing\.refresh\(\),/)
  assert.match(source, /onSelect=\{switchMedicationProfile\}/)
  assert.match(source, /disabled=\{selectedProfile\?\.role !== 'owner' && !selectedProfile\?\.canViewHistory\}/)
  assert.match(source, /navigate\('medications'\)/)
  assert.match(css, /\.bottom-nav button:disabled \{[^}]*color: var\(--muted\);[^}]*border-color: var\(--line\);/)
  assert.match(css, /\.medira-shell\.light \.action-glyph \[data-part='person'\] \{[^}]*opacity: 1;[^}]*fill: #777773;/)
  assert.match(css, /\.medira-shell\.light \.action-glyph \[data-part='plus-circle'\] \{[^}]*fill: color-mix\(in srgb, #777773 40%, var\(--button-neutral\)\);/)
  assert.match(css, /--card: #eeeeea;\s*--card-2: #e7e7e2;/)
  assert.match(css, /\.medira-shell\.light \.action-glyph \[data-part='plus'\] \{[^}]*fill: #777773;/)
  assert.match(source, /permissions\.canViewSchedule \? scheduleLabels\(med\)\[0\] : 'Not shared'/)
  assert.match(source, /<button className=\{`taken-toggle \$\{readOnlyToggleClass\}`\}/)
  assert.match(source, /<span className="read-only-label">Read only<\/span>/)
  assert.match(css, /\.taken-toggle \{[^}]*color: var\(--muted\);[^}]*border: 2px solid var\(--button-neutral-border\);/)
  assert.match(css, /\.taken-toggle\.complete \{[^}]*background: var\(--accent-2\);[^}]*border: 0;[^}]*outline: none;/)
  assert.match(css, /\.taken-toggle\.overdue \{[^}]*color: var\(--muted\);[^}]*border-color: var\(--button-neutral-border\);/)
  assert.match(source, /role="menuitemradio"/)
  assert.match(source, /Share medication list/)
  assert.doesNotMatch(source, /Share \$\{med\.name\}|Share medication"/)
  assert.match(css, /\.sharing-modal \{[^}]*overflow-x: clip;[^}]*overflow-y: auto;[^}]*touch-action: pan-y;/)
  assert.match(css, /\.medira-navigation\.with-profiles \{[^}]*background: rgba\(30,30,30,\.96\);/)
  assert.match(css, /\.medication-profile-trigger \{[^}]*background: transparent;[^}]*border: 0;/)
  assert.match(css, /\.medication-profile-trigger \.profile-avatar \{[^}]*border: 0;[^}]*box-shadow: 0 2px 4px rgba\(0,0,0,\.38\);/)
  assert.match(css, /\.profile-swap-icon \{[^}]*right: 0;[^}]*bottom: 0;/)
  assert.match(css, /\.shared-with \{[^}]*font-size: var\(--font-sm\);/)
  assert.match(css, /\.shared-avatar \{[^}]*width: 36px;[^}]*height: 36px;/)
  assert.doesNotMatch(css, /\.bottom-nav button:not\(\.active\)/)
  assert.doesNotMatch(source, /onDoubleClick|onDoubleTap/)
})
