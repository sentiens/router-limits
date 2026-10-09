// Where the plugin looks for things without the managed router runtime: the
// state directory, the Codex store, the routers' environment and executables.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { plugin, writeExecutable } from './helpers.mjs'

const { config, teamClaudeCommand, forecastCommand, searchDirs } = plugin

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'router-limits-env-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('the state, lock and probe marker do not depend on SwiftBar\'s per-plugin data path', (t) => {
  const h = home(t)
  const fixed = join(h, 'Library/Application Support/Router Limits/swiftbar')
  for (const env of [{ HOME: h }, { HOME: h, SWIFTBAR_PLUGIN_DATA_PATH: join(h, 'elsewhere') }]) {
    const cfg = config(env)
    assert.equal(cfg.stateDir, fixed)
    assert.equal(cfg.lockDir, join(fixed, 'lock'))
    assert.equal(cfg.markerPath, join(fixed, '.probe-owned'))
  }
})

test('the Codex store: CODEX_MULTI_AUTH_DIR, else $CODEX_HOME/multi-auth, else ~/.codex/multi-auth', (t) => {
  const h = home(t)
  assert.equal(config({ HOME: h }).codexDir, join(h, '.codex/multi-auth'))
  assert.equal(config({ HOME: h, CODEX_HOME: '/x/codex' }).codexDir, '/x/codex/multi-auth')
  assert.equal(config({ HOME: h, CODEX_HOME: '/x/codex', CODEX_MULTI_AUTH_DIR: '/y' }).codexDir, '/y')
})

test('the routers get their config, store and proxy variables, nothing else', (t) => {
  const h = home(t)
  const bin = join(h, 'bin')
  writeExecutable(join(bin, 'teamclaude'), '#!/bin/sh\n')
  writeExecutable(join(bin, 'codex-multi-auth'), '#!/bin/sh\n')
  const env = {
    HOME: h, ROUTER_LIMITS_BIN_PATH: bin, XDG_CONFIG_HOME: '/cfg', CODEX_HOME: '/codex', HTTPS_PROXY: 'http://proxy:8080',
    NO_PROXY: 'localhost', NODE_EXTRA_CA_CERTS: '/ca.pem', SECRET_TOKEN: 'not passed', SWIFTBAR: '1'
  }
  for (const cmd of [teamClaudeCommand(config(env), ['status', '--json']), forecastCommand(config(env))]) {
    assert.equal(cmd.env.XDG_CONFIG_HOME, '/cfg')
    assert.equal(cmd.env.CODEX_HOME, '/codex')
    assert.equal(cmd.env.HTTPS_PROXY, 'http://proxy:8080')
    assert.equal(cmd.env.NO_PROXY, 'localhost')
    assert.equal(cmd.env.NODE_EXTRA_CA_CERTS, '/ca.pem')
    assert.equal(cmd.env.SECRET_TOKEN, undefined)
    assert.equal(cmd.env.SWIFTBAR, undefined)
  }
})

test('routers installed through nvm, fnm or Volta are found', (t) => {
  const h = home(t)
  for (const v of ['v9.11.2', 'v22.11.0', 'v20.18.1']) mkdirSync(join(h, '.nvm/versions/node', v, 'bin'), { recursive: true })
  const dirs = searchDirs(config({ HOME: h, PATH: '' }))
  const nvm = dirs.filter((d) => d.includes('.nvm'))
  assert.deepEqual(nvm, ['v22.11.0', 'v20.18.1', 'v9.11.2'].map((v) => join(h, '.nvm/versions/node', v, 'bin')))
  assert.ok(dirs.includes(join(h, '.volta/bin')))
  assert.ok(dirs.includes(join(h, '.local/share/fnm/aliases/default/bin')))
  assert.ok(dirs.includes(join(h, 'Library/Application Support/fnm/aliases/default/bin')))
})
