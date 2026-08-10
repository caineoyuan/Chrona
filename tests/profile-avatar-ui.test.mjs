import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  AVATAR_COLORS,
  avatarInkFor,
  cropGeometry,
  defaultAvatarFor,
} from '../src/profile-avatar.js'

test('client avatar defaults match the approved deterministic palette', () => {
  const user = { id: 21, username: 'profile.user', displayUsername: 'Profile User' }
  assert.deepEqual(defaultAvatarFor(user), defaultAvatarFor(user))
  assert.equal(defaultAvatarFor(user).initial, 'P')
  assert.ok(AVATAR_COLORS.includes(defaultAvatarFor(user).color))
  assert.equal(AVATAR_COLORS.length, 13)
  assert.equal(new Set(AVATAR_COLORS).size, AVATAR_COLORS.length)
  assert.deepEqual(AVATAR_COLORS, [
    '52AA8A', '52AA5E', '388659', 'E26D5C', 'FDB833',
    '1789FC', '4A5759', 'F26157', 'EF7B45', '5EB1BF',
    '94DDBC', '136F63', '465362',
  ])
  assert.equal(avatarInkFor('4A5759'), '#f0f0ed')
  assert.equal(avatarInkFor('FDB833'), '#151515')
})

test('fixed-circle crop geometry stays inside the source image', () => {
  const wide = cropGeometry({ width: 800, height: 400 }, 208, 1, 999, -999)
  assert.equal(wide.sourceY, 0)
  assert.ok(wide.sourceX >= 0)
  assert.ok(wide.sourceX + wide.sourceSize <= 800)

  const zoomed = cropGeometry({ width: 400, height: 800 }, 208, 2, -80, 60)
  assert.ok(zoomed.sourceX >= 0)
  assert.ok(zoomed.sourceY >= 0)
  assert.ok(zoomed.sourceX + zoomed.sourceSize <= 400)
  assert.ok(zoomed.sourceY + zoomed.sourceSize <= 800)
})

test('settings modal expands profile icon editing with canonical round actions', async () => {
  const [app, profile, auth, css] = await Promise.all([
    readFile(new URL('../src/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/Profile.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/auth.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/index.css', import.meta.url), 'utf8'),
  ])

  assert.match(app, /<Avatar user=\{user\} size="topbar" \/>/)
  assert.doesNotMatch(app, /className="profile-name-topbar"/)
  assert.doesNotMatch(app, /onMouseEnter=\{\(\) => setProfileOpen\(true\)\}/)
  assert.match(app, /aria-haspopup="dialog"/)
  assert.doesNotMatch(app, /<Icon name="gear"/)
  assert.doesNotMatch(profile, /fetch\('\/avatars\/manifest\.json'\)/)
  assert.match(profile, /aria-label="Avatar crop\. Drag the image, or use arrow keys/)
  assert.match(profile, /role="group"/)
  assert.match(profile, /<legend>Background color<\/legend>/)
  assert.match(profile, /<legend>Choose an image<\/legend>/)
  assert.doesNotMatch(profile, /Bundled icons|avatar-icon-grid/)
  assert.match(profile, /className="modal profile-modal"/)
  assert.match(profile, /className="profile-avatar-edit-trigger"/)
  assert.match(profile, /aria-expanded=\{avatarExpanded\}/)
  assert.match(profile, /avatarExpanded && <div id="profile-icon-settings">/)
  assert.match(profile, /Edit profile icon/)
  assert.match(profile, /Appearance/)
  assert.match(profile, /Notifications/)
  assert.match(profile, /Change password/)
  assert.match(profile, /className="avatar-round-action cancel"/)
  assert.match(profile, /className="avatar-round-action save"/)
  assert.match(profile, /<Icon name="checkmark" size=\{24\} \/>/)
  assert.match(profile, /className="profile-avatar-pencil"/)
  assert.match(profile, /<Icon name="edit" size=\{12\} \/>/)
  assert.match(profile, /Change username/)
  assert.match(profile, /updateUsername\(username\)/)
  assert.match(profile, /aria-label="Save username"/)
  assert.match(profile, /aria-busy=\{busy\}/)
  assert.match(profile, /role="alert"/)
  assert.match(auth, /setUser\(next\)/)
  assert.match(auth, /setUser\(data\)/)
  assert.match(auth, /\/api\/auth\/profile\/username/)
  assert.match(css, /\.profile-trigger \{[^}]*width: 40px;[^}]*height: 40px;[^}]*border: 0;[^}]*border-radius: 50%;/)
  assert.match(css, /\.profile-avatar-topbar \{[^}]*width: 32px;[^}]*height: 32px;[^}]*border: 0;[^}]*box-shadow: 0 2px 4px rgba\(0, 0, 0, 0\.38\);/)
  assert.match(css, /\.avatar-crop \{[^}]*width: 208px;[^}]*height: 208px;[^}]*border-radius: 50%;/)
  assert.match(css, /@media \(max-width: 360px\)/)
  assert.match(css, /\.profile-avatar \{[^}]*color: #fff;[^}]*font-family: var\(--serif\);[^}]*font-style: italic;/)
  assert.match(css, /\.profile-menu \{[^}]*margin-right: 16px;/)
  assert.match(css, /\.avatar-setting-grid \{[^}]*grid-template-columns: 1fr;/)
  assert.match(css, /\.avatar-color \{\s*color: #fff;/)
  assert.match(css, /\.avatar-color \{[^}]*font-style: italic;/)
  assert.match(css, /\.avatar-color \{[^}]*border: 1px solid transparent;/)
  assert.match(css, /\.avatar-color\[aria-pressed='true'\] \{\s*border-color: #e3e3e3;\s*box-shadow: none;/)
  assert.match(css, /\.avatar-round-action \{[^}]*width: 56px;[^}]*height: 56px;[^}]*border-radius: 50%;/)
  assert.match(css, /\.avatar-round-action\.save svg path \{\s*stroke: #fff;/)
  assert.match(css, /\.avatar-actions \{\s*display: flex;\s*justify-content: center;\s*gap: 8px;/)
  assert.doesNotMatch(profile, /'--avatar-ink'/)
  assert.match(css, /\.profile-form \{[^}]*overflow-y: auto;[^}]*touch-action: pan-y;/)
  assert.match(css, /\.profile-modal \{[^}]*width: min\(560px, 100%\);[^}]*max-width: 560px;/)
  assert.match(css, /\.profile-form::-webkit-scrollbar \{\s*width: 4px;/)
  assert.match(css, /\.profile-avatar-pencil \{[^}]*right: -1px;[^}]*bottom: -1px;/)
  assert.match(css, /\.profile-avatar-pencil \{[^}]*color: #deded9;[^}]*background: #4a4d4e;[^}]*border: 0;/)
  assert.match(css, /\.profile-id \.profile-avatar-pencil \.gi \{\s*color: inherit;/)
  assert.match(css, /html\[data-theme='light'\] \.profile-avatar-pencil \{[^}]*color: #777773;[^}]*background: #deded9;/)
  assert.match(css, /\.profile-avatar-edit-trigger \{[^}]*border-radius: 50%;/)
  assert.doesNotMatch(profile, /onDoubleClick|onDoubleTap/)
  assert.match(app, /appMode === 'chrona'/)
  assert.match(app, /appMode === 'medira'/)
  const topbar = app.slice(app.indexOf('<header className="topbar">'), app.indexOf('</header>'))
  assert.match(topbar, /<Avatar user=\{user\} size="topbar" \/>/)
  assert.match(topbar, /appMode === 'medira'/)
})
