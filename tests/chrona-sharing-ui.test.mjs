import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { activityClient } from '../src/activity-client.js'
import { buddyStreakClient } from '../src/buddy-streak-client.js'
import { invitationClient } from '../src/invitations.js'
import { completionMapForUser } from '../src/lib.js'

test('buddy client uses versioned member removal and manual ping endpoints', async () => {
  const calls = []
  const client = buddyStreakClient(async (path, options) => {
    calls.push({ path, options })
    return { ok: true }
  })

  await client.removeMember('12', '8', 4)
  await client.updateMember('12', '8', 5, 'observer')
  await client.ping('12', '8')

  assert.equal(calls[0].path, '/api/buddy-streaks/12/members/8')
  assert.deepEqual(JSON.parse(calls[0].options.body), { version: 4 })
  assert.equal(calls[1].path, '/api/buddy-streaks/12/members/8')
  assert.equal(calls[1].options.method, 'PATCH')
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    role: 'observer',
    version: 5,
  })
  assert.equal(calls[2].path, '/api/buddy-streaks/12/ping')
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    recipientUserId: '8',
  })
})

test('buddy client writes retroactive completion dates through one dated resource', async () => {
  const calls = []
  const client = buddyStreakClient(async (path, options) => {
    calls.push({ path, options })
    return { ok: true }
  })

  await client.setCompletionDate('12', '2026-08-16', true)
  await client.setCompletionDate('12', '2026-08-16', false)

  assert.deepEqual(calls.map(({ path, options }) => [path, options.method]), [
    ['/api/buddy-streaks/12/completions/2026-08-16', 'PUT'],
    ['/api/buddy-streaks/12/completions/2026-08-16', 'DELETE'],
  ])
})

test('shared streak calendar reads every personal completion from the shared source', () => {
  const completions = completionMapForUser([{
    userId: '7',
    periodKey: 'day:2026-08-16',
    localCompletedAt: '2026-08-16T18:30:00.000Z',
  }, {
    userId: '8',
    periodKey: 'day:2026-08-17',
    localCompletedAt: '2026-08-17T18:30:00.000Z',
  }], '7')

  assert.deepEqual(completions, { '2026-08-16': true })
})

test('Chrona integrates buddy and spectator sharing across home and run views', async () => {
  const [app, home, run, sharing, css] = await Promise.all([
    readFile(new URL('../src/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/Home.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/RunView.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/SharingUI.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/index.css', import.meta.url), 'utf8'),
  ])

  assert.match(app, /useBuddyStreaks\(\)/)
  assert.match(app, /buddySetForUser\(currentBuddy, user\.id, localCurrent\)/)
  assert.match(home, /label="Share streak"/)
  assert.doesNotMatch(home, /title="Duplicate"/)
  assert.doesNotMatch(home, /<Icon name="copy"/)
  assert.match(home, /!participant && <small>Spectator<\/small>/)
  assert.match(home, /className="ring-counter buddy-ring"/)
  assert.match(home, /<small className="ring-counter-label">friends<\/small>/)
  assert.match(home, /<small className="ring-counter-label">days<\/small>/)
  assert.match(home, /const participatingFriend = buddyStreak[\s\S]*hasParticipatingFriend\(buddyStreak, user\.id\)/)
  assert.match(home, /\{streakCounter\}[\s\S]*<FireStrip set=\{set\} compact \/>[\s\S]*className="card-ring-counters"[\s\S]*<WeeklyRing set=\{set\} \/>/)
  assert.match(css, /\.weekly-streak > \.fire-strip \{[^}]*margin-left: auto;/)
  assert.match(css, /\.card-streak\.weekly-streak \{[^}]*margin-top: 14px;/)
  assert.match(css, /\.fire-strip\.compact \.fire-cell \{[^}]*width: 16px;/)
  assert.match(home, /member\.role === 'participant'/)
  assert.match(home, /String\(id\) !== String\(userId\)/)
  assert.match(home, /run-person-state streak-person-state \$\{completed \? 'done' : 'waiting'\}/)
  assert.match(css, /\.streak-person-state \{[^}]*width: 16px;[^}]*height: 16px;/)
  assert.match(home, /nudges\.length > 0 && !doneToday && <div className="streak-nudge-stack">/)
  assert.match(home, /const bySender = new Map\(\)/)
  assert.match(home, /level: Math\.min\(3, event\.payload\?\.nudgeNumber \|\| 1\)/)
  assert.match(home, /className="streak-nudge-dismiss"/)
  assert.match(home, /activity\.markRead\(id\)/)
  assert.match(css, /\.streak-nudge-dismiss \{[^}]*color: #fff;[^}]*background: transparent;[^}]*border: 0;/)
  assert.match(css, /\.level-1 \.streak-nudge-dismiss \{[^}]*color: #725600;/)
  assert.match(css, /\.level-2 \.streak-nudge-dismiss \{[^}]*color: #ffe0bd;/)
  assert.match(css, /\.level-3 \.streak-nudge-dismiss \{[^}]*color: #ffd4d4;/)
  assert.match(css, /\.card-ring-counters \{[^}]*display: flex;[^}]*gap: 8px;/)
  assert.match(css, /\.run-page-dots button \{[^}]*width: 16px;[^}]*height: 40px;/)
  assert.match(run, /className=\{`streak-calendar-marker[\s\S]*size=\{40\}[\s\S]*className="streak-calendar-day-number"/)
  assert.match(css, /\.streak-calendar-day\.current button > \.streak-calendar-day-number::after,[\s\S]*\.streak-calendar-day\.current \.streak-calendar-marker::after \{[^}]*width: 4px;[^}]*height: 4px;[^}]*border-radius: 50%;/)
  assert.match(css, /\.streak-calendar-day\.current \.streak-calendar-marker::after \{[^}]*bottom: -6px;/)
  assert.match(css, /\.streak-calendar-marker \{[^}]*width: 44px;[^}]*height: 44px;/)
  assert.match(css, /\.streak-calendar-marker \.streak-calendar-day-number \{[^}]*color: #fff;[^}]*font-weight: 700;[^}]*text-shadow:/)
  assert.doesNotMatch(app, /Shutter icon by Flaticon/)
  assert.match(home, /’s streaks/)
  assert.match(home, /Number\(a\.buddyStreak\.currentOccurrence\?\.complete\) -/)
  assert.match(run, /className="run-shared-people"/)
  assert.match(run, /\{set\.name \|\| 'Untitled'\} calendar/)
  assert.match(run, /className="run-page-dots"/)
  assert.match(run, /setPage\('calendar'\)/)
  assert.match(run, /setPage\('set'\)/)
  assert.match(run, /name=\{day\.completed \? \(set\.trackStreak \? 'fire-element' : 'stone'\) : 'snowflake'\} size=\{40\}/)
  assert.match(run, /setCompletionForDate\(set, completionDate, completed\)/)
  assert.match(run, /run-person-state \$\{completed \? 'done' : 'waiting'\}/)
  assert.match(run, /title=\{`Nudge @\$\{member\.username\}`\}/)
  assert.match(run, /\(!buddyStreak \|\| buddyStreak\.canAdminister\) &&[\s\S]*<IconButton label="Share and manage people"/)
  assert.match(run, /name="edit" iconSize=\{18\}[\s\S]*iconClassName="action-glyph"/)
  assert.match(run, /label=\{buddyStreak \? 'Leave buddy streak' : 'Delete set'\}/)
  assert.match(home, /buddy\.leave\(confirming\.buddyStreak\.id, String\(user\.id\)\)/)
  assert.doesNotMatch(run, /\{set\.trackStreak && \(\s*<button\s+className=\{`freeze-btn/)
  assert.match(run, /className="meta-tag run-total-time"/)
  assert.match(sharing, /Buddy Streak/)
  assert.match(sharing, /Viewing/)
  assert.match(sharing, /member\.role === 'participant' \? 'Buddy' : 'Spectator'/)
  assert.match(sharing, /<h3 id="members-title">People with access<\/h3>/)
  assert.match(sharing, /className="share-row"/)
  assert.doesNotMatch(sharing, /className="member-role-toggle"/)
  assert.doesNotMatch(sharing, /actions\.updateMember/)
  assert.doesNotMatch(sharing, /Delete shared streak/)
  assert.doesNotMatch(sharing, /<span className="eyebrow">Buddy streak<\/span>/)
  assert.match(sharing, /<footer className="sharing-sheet-footer">/)
  assert.match(sharing, />Save<\/button>/)
  assert.match(css, /\.share-row \{[^}]*min-height: 56px;[^}]*border-bottom: 1px solid var\(--line\);/)
  assert.match(css, /\.share-row \.profile-avatar \{[^}]*width: 40px;[^}]*border-radius: 50%;[^}]*clip-path: circle\(50%\);/)
  assert.match(css, /\.chooser-btn \{[^}]*border: 0;[^}]*background: transparent;/)
  assert.match(sharing, /<em>Aggressively<\/em> nudge/)
  assert.match(sharing, /className="nudge-action cancel"/)
  assert.match(sharing, /className="nudge-action confirm"/)
  assert.match(sharing, /ArrowRightRegular fontSize=\{22\}/)
  assert.match(home, /streak-nudge-banner level-/)
  assert.match(home, /nudged you <em>again<\/em>/)
  assert.match(home, /is <em>aggressively<\/em> nudging you/)
  assert.match(css, /\.run-person-state\.done \{\s*background: var\(--accent-2\);/)
  assert.match(css, /\.run-person-state\.waiting \{\s*background: var\(--status-red\);/)
  assert.match(css, /\.profile-avatar \{[^}]*border: 0;/)
  assert.match(css, /\.profile-avatar-small \{[^}]*width: 32px;[^}]*height: 32px;/)
  assert.match(css, /\.run-person-state \{[^}]*color: #fff;[^}]*border: 0;/)
})

test('invitation client sends buddy participant and observer access', async () => {
  const calls = []
  const client = invitationClient(async (path, options) => {
    calls.push({ path, options })
    return { invitePath: '/?invite=token' }
  })

  await client.inviteUsername('12', 'exact.user', {
    role: 'participant',
  }, 'buddy_streak')
  await client.createLink('12', { role: 'observer' }, 'buddy_streak')
  await client.accept('91')

  assert.deepEqual(JSON.parse(calls[0].options.body), {
    resourceType: 'buddy_streak',
    resourceId: '12',
    permissions: { role: 'participant' },
    username: 'exact.user',
  })
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    resourceType: 'buddy_streak',
    resourceId: '12',
    permissions: { role: 'observer' },
  })
  assert.equal(calls[2].path, '/api/sharing/invitations/91/accept')
})

test('activity client exposes unread controls', async () => {
  const calls = []
  const client = activityClient(async (path, options) => {
    calls.push({ path, options })
    return path === '/api/activity/'
      ? { activities: [{ id: '1', readAt: null }] }
      : { ok: true }
  })

  assert.equal((await client.list()).length, 1)
  await client.read('1')
  await client.readAll()
  assert.deepEqual(calls.map(({ path }) => path), [
    '/api/activity/',
    '/api/activity/1/read',
    '/api/activity/read-all',
  ])
})

test('Chrona sharing UI includes role, conflict, completion, and throttle states', async () => {
  const source = await readFile(
    new URL('../src/components/SharingUI.jsx', import.meta.url),
    'utf8',
  )
  for (const copy of [
    'Participant',
    'Observer',
    'All members complete',
    'Invite by exact username',
    'Hourly ping limit reached',
    'changed elsewhere',
    'Mark all read',
  ]) {
    assert.match(source, new RegExp(copy))
  }
  assert.match(source, /aria-pressed=\{role === 'participant'\}/)
  assert.match(source, /aria-pressed=\{role === 'observer'\}/)
  assert.doesNotMatch(source, /onDoubleClick|onDoubleTap/)
})

test('sharing uses the monochrome user-add glyph in standard circular controls', async () => {
  const [sharing, medira, icons, runView, css] = await Promise.all([
    readFile(new URL('../src/components/SharingUI.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/medira/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/Icon.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/RunView.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/index.css', import.meta.url), 'utf8'),
  ])

  assert.match(sharing, /ButtonIcon name="user-add"/)
  assert.match(medira, /name="user-add"/)
  assert.doesNotMatch(sharing, /ShareRegular/)
  assert.doesNotMatch(medira, /ShareRegular/)
  const glyphStart = icons.indexOf("'user-add':")
  const glyph = icons.slice(glyphStart, icons.indexOf('  fire:', glyphStart))
  assert.match(glyph, /vb: '0 0 512\.005 512\.005'/)
  assert.match(glyph, /currentColor/)
  assert.equal((glyph.match(/opacity="0\.4"/g) || []).length, 2)
  assert.equal((glyph.match(/data-part="person"/g) || []).length, 2)
  assert.match(glyph, /<circle data-part="plus-circle"[^>]*fill="#fff"/)
  assert.doesNotMatch(glyph, /<circle[^>]*stroke=/)
  assert.doesNotMatch(glyph, /translate\(-20 0\)/)
  assert.match(glyph, /data-part="plus" fill="#7f8283"/)
  assert.match(runView, /name="user-add" iconSize=\{18\}[\s\S]*iconClassName="action-glyph"/)
  assert.match(runView, /name="arrow-left" iconSize=\{22\}[\s\S]*iconClassName="run-back-glyph"/)
  assert.match(runView, /normalizeSchedule\(set\)\.mode === 'weekly' \? 'week' : 'day'/)
  assert.match(runView, /<span className="meta-tag run-total-time">[\s\S]*<div className="run-meta-stats">/)
  assert.match(css, /\.run-streak-stat \{[^}]*font-size: var\(--font-sm\);/)
  assert.match(css, /html\[data-theme='light'\] \.workspace-chrona \.action-glyph \[data-part='person'\] \{[^}]*opacity: 1;[^}]*fill: #777773;/)
  assert.match(css, /html\[data-theme='light'\] \.run-back-glyph \{[^}]*color: #777773;/)
})

test('accepted link invitations trigger a buddy resource refresh', async () => {
  const auth = await readFile(new URL('../src/auth.jsx', import.meta.url), 'utf8')
  const buddy = await readFile(new URL('../src/buddy-streaks.js', import.meta.url), 'utf8')
  assert.match(auth, /chrona:invite-accepted/)
  assert.match(buddy, /addEventListener\('chrona:invite-accepted'/)
  assert.match(buddy, /steps: Array\.isArray\(definition\.steps\)/)
  assert.match(buddy, /new EventSource\('\/api\/buddy-streaks\/events'\)/)
  assert.match(buddy, /event\.change === 'completion'/)
})

test('buddy completion routes publish authenticated SSE updates', async () => {
  const source = await readFile(
    new URL('../server/buddy-streaks.js', import.meta.url),
    'utf8',
  )
  assert.match(source, /router\.get\('\/events', requireAuth/)
  assert.match(source, /'Content-Type': 'text\/event-stream'/)
  assert.match(source, /await publishBuddyChange\(poolFn, id, req\.userId/)
  assert.match(source, /completed: true/)
  assert.match(source, /completed: false/)
})

test('top bar invitation inbox uses the requested group art and circular decisions', async () => {
  const [app, inbox, groupIcon, css] = await Promise.all([
    readFile(new URL('../src/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/InvitationInbox.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/GroupInvitesIcon.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/index.css', import.meta.url), 'utf8'),
  ])
  assert.match(app, /<InvitationInbox activity=\{activity\} \/>/)
  assert.match(inbox, /No invites\./)
  assert.match(inbox, /Accepted!/)
  assert.match(inbox, /setTimeout\(\(\) => setAcceptedNotice\(false\), 1200\)/)
  assert.match(inbox, /className="invitation-count"/)
  assert.match(inbox, /className=\{`invitation-inbox-trigger \$\{open \? 'active' : ''\}`\}/)
  assert.match(inbox, /className="invitation-action accept"/)
  assert.match(inbox, /className="invitation-action reject"/)
  for (const color of ['#7FCDFF', '#95D895', '#80A1FF', '#46FFDE']) {
    assert.match(groupIcon, new RegExp(color))
  }
  assert.match(groupIcon, /#E3E3E3/)
  assert.match(groupIcon, /className="group-invites-heads"/)
  assert.match(groupIcon, /<g className="group-invites-head-shading" fill="#CECECE">/)
  assert.match(css, /html\[data-theme='light'\] \.group-invites-head-shading \{\s*display: none;/)
  assert.match(css, /html\[data-theme='light'\] \.group-invites-heads \{\s*fill: #cecece;/)
  assert.match(css, /\.app-switch-btn \{[^}]*opacity: 0\.58;/)
  assert.match(css, /\.invitation-inbox-trigger \{[^}]*opacity: 0\.58;/)
  assert.match(css, /\.invitation-inbox-trigger\.active \{\s*opacity: 1;/)
  assert.doesNotMatch(css, /\.invitation-inbox-trigger > svg \{[^}]*opacity:/)
  assert.match(groupIcon, /clipPath=\{`url\(#\$\{clipId\}-center-head\)`\}/)
  assert.doesNotMatch(groupIcon, /#9CA3AF|#6B7280|#EFC27B|#ECB45C/)
  assert.match(inbox, /className="invitation-modal-title"/)
  assert.match(inbox, /<GroupInvitesIcon size=\{32\} \/>/)
  assert.match(css, /\.invitation-inbox-trigger > svg \{[^}]*filter: drop-shadow\(0 2px 2px rgba\(0, 0, 0, 0\.35\)\);/)
  assert.match(css, /\.invitation-action \{[^}]*width: 40px;[^}]*height: 40px;[^}]*border-radius: 50%;/)
  assert.match(css, /\.invitation-action\.accept \{[^}]*background: var\(--accent-2\);/)
  assert.match(css, /\.invitation-action\.reject \{[^}]*background: var\(--danger\);/)
  assert.match(css, /\.invitation-action svg path \{[^}]*stroke: #fff;/)
  assert.match(css, /\.invitation-count \{[^}]*color: #fff;[^}]*background: var\(--danger\);/)
  assert.match(css, /\.profile-modal-overlay \{[\s\S]*align-items: center;/)
})
