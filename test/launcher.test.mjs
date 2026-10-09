// The first two lines are a zsh launcher that finds node even when it is not
// on SwiftBar's PATH; the same file is plain Node.js.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN, makeHome, writeExecutable } from './helpers.mjs'

const zsh = existsSync('/bin/zsh')

test('the file is valid JavaScript with the launcher in front', () => {
  const out = spawnSync(process.execPath, ['--check', PLUGIN])
  assert.equal(out.status, 0, out.stderr.toString())
  const [shebang, launcher] = readFileSync(PLUGIN, 'utf8').split('\n')
  assert.equal(shebang, '#!/bin/zsh')
  assert.match(launcher, /^':' \/\/;/)
})

test('under /bin/zsh with an empty PATH, node is found through the fallback list', { skip: !zsh }, (t) => {
  const h = makeHome(t, { teamclaude: false, codex: false })
  mkdirSync(join(h.home, '.volta/bin'), { recursive: true })
  symlinkSync(process.execPath, join(h.home, '.volta/bin/node'))
  const out = spawnSync('/bin/zsh', ['-fc', `path=(); ${JSON.stringify(PLUGIN)}`], {
    env: { HOME: h.home, ROUTER_LIMITS_BIN_PATH: '' }
  })
  assert.equal(out.status, 0, out.stderr.toString())
  assert.match(out.stdout.toString(), /^:gauge\.with\.needle: \| sfcolor=\S+ sfsize=16\n---\nClaude {3}not found/)
})

// The launcher line without the machine-wide candidates (Homebrew,
// /usr/local), which a test can't hide: only the per-user ones remain.
function userLauncher() {
  const line = readFileSync(PLUGIN, 'utf8').split('\n')[1]
  return line.replace(' /opt/homebrew/bin/node /usr/local/bin/node', '')
}

test('the launcher finds the newest nvm node when nothing else is there', { skip: !zsh }, (t) => {
  const h = makeHome(t, { teamclaude: false, codex: false })
  for (const v of ['v9.11.2', 'v22.11.0', 'v20.18.1']) {
    writeExecutable(join(h.home, '.nvm/versions/node', v, 'bin/node'), `#!/bin/sh\necho "nvm ${v} $1"\n`)
  }
  const out = spawnSync('/bin/zsh', ['-fc', `path=(); ${userLauncher()}`, PLUGIN], { env: { HOME: h.home } })
  assert.equal(out.stdout.toString(), `nvm v22.11.0 ${PLUGIN}\n`, out.stderr.toString())
})

test('the launcher finds fnm\'s default node, and says so when there is none', { skip: !zsh }, (t) => {
  const h = makeHome(t, { teamclaude: false, codex: false })
  const none = spawnSync('/bin/zsh', ['-fc', `path=(); ${userLauncher()}`, PLUGIN], { env: { HOME: h.home } })
  assert.equal(none.status, 0)
  assert.equal(none.stdout.toString(), '| sfimage=exclamationmark.triangle\n---\nRouter Limits needs Node.js 20 or newer (node not found)\n')
  writeExecutable(join(h.home, 'Library/Application Support/fnm/aliases/default/bin/node'), '#!/bin/sh\necho fnm\n')
  const fnm = spawnSync('/bin/zsh', ['-fc', `path=(); ${userLauncher()}`, PLUGIN], { env: { HOME: h.home } })
  assert.equal(fnm.stdout.toString(), 'fnm\n')
})

test('with the managed router runtime, its node is preferred', { skip: !zsh }, (t) => {
  const h = makeHome(t, { teamclaude: false, codex: false })
  mkdirSync(join(h.home, '.bin/lib'), { recursive: true })
  writeExecutable(join(h.home, '.bin/lib/agent-router-env.zsh'), '')
  writeExecutable(join(h.home, '.local/share/agent-router-runtime/current/bin/node'), '#!/bin/sh\necho "managed node $1 $2"\n')
  const out = spawnSync('/bin/zsh', [PLUGIN, 'check'], { env: { HOME: h.home, PATH: '/usr/bin:/bin' } })
  assert.equal(out.stdout.toString(), `managed node ${PLUGIN} check\n`)
})
