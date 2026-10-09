// Check Now against fake routers: the probe safety end to end (signals, retry,
// marker, operator probe), the never-auto rule, the cooldown and the lock.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ms, makeHome, runPlugin, waitFor, writeJson, writeExecutable, normalFleet, claudeStatus, claudeAccount, weekly, fiveHour
} from './helpers.mjs'

const FORECAST_OK = {
  command: 'forecast',
  liveProbe: true,
  accounts: [{ index: 0, availability: 'ready', liveQuota: { status: 200, planType: 'pro', primary: fiveHour(20, '2026-10-08T20:00:00Z'), secondary: weekly(40, '2026-10-15T07:00:00Z') } }]
}

const PROBE = (h) => [
  'teamclaude status --json',
  'teamclaude probe 3600',
  'teamclaude status --json',
  'teamclaude probe off',
  'probe off done'
].every((call) => h.calls().includes(call))

test('the menu run never asks the accounts: no probe, no forecast', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  h.fake('forecast.json', FORECAST_OK)
  for (let i = 0; i < 3; i++) assert.equal((await runPlugin(h)).code, 0)
  assert.deepEqual(h.calls(), ['teamclaude status --json', 'teamclaude status --json', 'teamclaude status --json'])
})

test('Check Now: one probe run switched off again, one forecast, results and cooldown recorded', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  h.fake('forecast.json', FORECAST_OK)
  const result = await runPlugin(h, ['check'])
  assert.equal(result.code, 0, result.stderr)
  const calls = h.calls()
  assert.equal(calls.find((c) => c.startsWith('teamclaude')), 'teamclaude status --json')
  assert.equal(calls.filter((c) => c === 'teamclaude probe 3600').length, 1)
  assert.deepEqual(calls.filter((c) => c.startsWith('teamclaude probe')).at(-1), 'teamclaude probe off')
  assert.ok(calls.includes('codex-multi-auth forecast --live --json --model gpt-6-astra'))
  assert.ok(PROBE(h))
  const state = h.readState()
  assert.equal(state.running, undefined)
  assert.equal(state.lastCheck.failed, undefined)
  assert.equal(state.cooldownUntil, ms('2026-10-08T16:36:00Z'))
  const x = Object.values(state.providers.codex.accounts)[0]
  assert.deepEqual(x.windows.week, { usedPercent: 40, resetAt: ms('2026-10-15T07:00:00Z') })
  assert.equal(existsSync(join(h.stateDir, '.probe-owned')), false)
  assert.equal(existsSync(join(h.stateDir, 'lock')), false)
  // The menu shows it, with the cooldown.
  const menu = (await runPlugin(h, [], { now: '2026-10-08T16:27:00.000Z' })).stdout
  assert.match(menu, /\nCodex {3}60% left/)
  assert.match(menu, /\nCheck Now \| color=#8e8e93,#98989d bash=\S+ param1=check terminal=false refresh=true\nchecked 18:25 · next 18:36 \| size=11\n/)
})

test('a second check inside the cooldown is refused without asking anything', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  h.fake('forecast.json', FORECAST_OK)
  await runPlugin(h, ['check'])
  const before = h.calls().length
  const second = await runPlugin(h, ['check'], { now: '2026-10-08T16:30:00.000Z' })
  assert.equal(second.code, 0)
  assert.match(second.stdout, /cooldown: the next check can run at 18:36/)
  assert.equal(h.calls().length, before)
  const third = await runPlugin(h, ['check'], { now: '2026-10-08T16:36:00.000Z' })
  assert.equal(third.code, 0)
  assert.ok(h.calls().length > before)
})

test('the Codex probe model can be set; no model is ever shown', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  h.fake('forecast.json', FORECAST_OK)
  await runPlugin(h, ['check'], { env: { ROUTER_LIMITS_CODEX_PROBE_MODEL: 'gpt-5.6-sol' } })
  assert.ok(h.calls().includes('codex-multi-auth forecast --live --json --model gpt-5.6-sol'))
  const menu = (await runPlugin(h)).stdout
  assert.doesNotMatch(menu, /gpt|Sol|Astra/i)
})

test('a Codex 429 with windows is a reading: the account is exhausted', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  h.fake('forecast.json', { ...FORECAST_OK, accounts: [{ index: 0, availability: 'unavailable', liveQuota: { status: 429, planType: 'pro', primary: fiveHour(100, '2026-10-08T19:00:00Z'), secondary: weekly(100, '2026-10-15T07:00:00Z') } }] })
  await runPlugin(h, ['check'])
  const menu = (await runPlugin(h, [], { now: '2026-10-08T16:27:00.000Z' })).stdout
  assert.match(menu, /\nCodex {3}0% left · back Oct 15 \| color=#d70015/)
  assert.match(menu, /--Router reported unavailable at 18:25\n/)
  assert.equal(menu.split('\n')[0], ':gauge.with.dots.needle.0percent: | sfcolor=#d70015,#ff6961 sfsize=16')
})

test('failed accounts are named under Check Now; their values stay', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  h.fake('teamclaude.json', { probe: { statuses: { 'alpha@example.com': 'timeout' } } })
  h.fake('forecast.json', { ...FORECAST_OK, accounts: [{ index: 0, liveQuota: { status: 500 } }] })
  await runPlugin(h, ['check'])
  const state = h.readState()
  assert.deepEqual(state.lastCheck.failed.length, 2)
  const menu = (await runPlugin(h, [], { now: '2026-10-08T16:27:00.000Z' })).stdout
  assert.match(menu, /checked 18:25 · alpha, xray failed · next 18:36/)
  assert.match(menu, /--Check 18:25 failed: timeout\n/)
  assert.match(menu, /--Check 18:25 failed: HTTP 500\n/)
  assert.match(menu, /○ alpha {3}76%/)
  assert.match(menu, /● xray {3}100%/)
})

test('an operator\'s periodic probe is respected and never toggled', async (t) => {
  const h = makeHome(t)
  const accounts = [claudeAccount('bravo@example.com', { week: [0.3, '2026-10-12T19:00:00Z'], lastUsed: '2026-10-08T16:23:00.000Z' })]
  h.fake('claude-status.json', claudeStatus(accounts, {
    probe: { enabled: true, intervalSeconds: 300, lastRunStartedAt: '2026-10-08T16:20:00Z', lastRunFinishedAt: '2026-10-08T16:20:01Z', accounts: [{ name: 'bravo@example.com', status: 'ok', lastProbedAt: '2026-10-08T16:20:01Z' }] }
  }))
  writeJson(join(h.stateDir, '.probe-owned'), { at: '2026-10-01T00:00:00Z', intervalSeconds: 3600 })
  await runPlugin(h, ['check'])
  assert.deepEqual(h.calls().filter((c) => c.startsWith('teamclaude')), ['teamclaude status --json'])
  assert.equal(existsSync(join(h.stateDir, '.probe-owned')), false, 'the stale marker is dropped')
  assert.equal(h.readState().lastCheck.failed, undefined)
})

test('a probe left on at 3600 s is switched off first, then one fresh run', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  h.fake('probe-state.json', { enabled: true, intervalSeconds: 3600, lastRunStartedAt: '2026-10-08T15:00:00Z', lastRunFinishedAt: '2026-10-08T15:00:01Z', accounts: [] })
  h.fake('forecast.json', FORECAST_OK)
  await runPlugin(h, ['check'])
  const claude = h.calls().filter((c) => c.startsWith('teamclaude probe'))
  assert.deepEqual([claude[0], claude[1]], ['teamclaude probe off', 'teamclaude probe 3600'])
  assert.equal(claude.at(-1), 'teamclaude probe off')
})

test('probe off is retried once; when it fails twice the marker stays for the next check', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  h.fake('forecast.json', FORECAST_OK)
  h.fake('teamclaude.json', { probe: { offFailures: 1 } })
  await runPlugin(h, ['check'])
  assert.equal(h.calls().filter((c) => c === 'teamclaude probe off').length, 2)
  assert.equal(existsSync(join(h.stateDir, '.probe-owned')), false)

  const h2 = makeHome(t)
  normalFleet(h2)
  h2.fake('forecast.json', FORECAST_OK)
  await runPlugin(h2)
  h2.fake('teamclaude.json', { probe: { offFailures: 2 } })
  await runPlugin(h2, ['check'])
  assert.equal(existsSync(join(h2.stateDir, '.probe-owned')), true)
  assert.match(h2.readState().providers.claude.accounts['claude:bravo@example.com'].checkError.value, /probe off failed/)
})

for (const name of ['SIGTERM', 'SIGINT']) {
  test(`${name} during a probe run sends probe off before the check exits`, async (t) => {
    const h = makeHome(t)
    normalFleet(h)
    h.fake('teamclaude.json', { probe: { run: 'never' } })
    h.fake('forecast.json', FORECAST_OK)
    let child
    const done = runPlugin(h, ['check'], { onSpawn: (c) => { child = c } })
    await waitFor(() => h.calls().includes('teamclaude probe 3600'))
    assert.equal(existsSync(join(h.stateDir, '.probe-owned')), true)
    child.kill(name)
    const result = await done
    assert.equal(result.signal, name)
    const calls = h.calls()
    assert.deepEqual(calls.slice(-2), ['teamclaude probe off', 'probe off done'])
    assert.equal(calls.filter((c) => c === 'teamclaude probe off').length, 1)
    assert.equal(existsSync(join(h.stateDir, '.probe-owned')), false)
    assert.equal(existsSync(join(h.stateDir, 'lock')), false)
    assert.equal(h.readState().running, undefined)
  })
}

test('a second Ctrl-C to the whole process group does not cut probe off short', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  h.fake('teamclaude.json', { probe: { run: 'never', offDelayMs: 1500 } })
  h.fake('forecast.json', FORECAST_OK)
  let child
  const done = runPlugin(h, ['check'], { onSpawn: (c) => { child = c } })
  await waitFor(() => h.calls().includes('teamclaude probe 3600'))
  process.kill(-child.pid, 'SIGINT')
  await waitFor(() => h.calls().includes('teamclaude probe off'))
  process.kill(-child.pid, 'SIGINT') // the terminal's foreground group, again
  const result = await done
  assert.equal(result.signal, 'SIGINT')
  const calls = h.calls()
  assert.deepEqual(calls.slice(-2), ['teamclaude probe off', 'probe off done'])
  assert.equal(calls.filter((c) => c === 'teamclaude probe off').length, 1)
  assert.equal(existsSync(join(h.stateDir, '.probe-owned')), false)
})

test('the lock: a check waits for it, a menu run does not, a dead owner\'s lock is taken over', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  h.fake('forecast.json', FORECAST_OK)
  const owner = join(h.stateDir, 'lock', 'owner.json')
  writeJson(owner, { pid: process.pid, startedAt: Date.now(), children: [] })
  // Busy: the menu shows the stored state and reads nothing.
  await runPlugin(h)
  assert.deepEqual(h.calls(), [])
  // A check that can't get the lock in time doesn't run and says so.
  const refused = await runPlugin(h, ['check'], { env: { ROUTER_LIMITS_LOCK_WAIT_MS: '600' } })
  assert.match(refused.stdout, /another check is running/)
  assert.deepEqual(h.calls(), [])
  assert.match((await runPlugin(h)).stdout, /\n\d\d:\d\d didn't run: another check is running \| size=11/)
  // A check waits for the lock to be released.
  const waiting = runPlugin(h, ['check'])
  setTimeout(() => writeJson(owner, { pid: 999999, startedAt: Date.now(), children: [] }), 700)
  assert.equal((await waiting).code, 0)
  assert.ok(PROBE(h))
  // A lock whose owner (and children) are gone is stale.
  writeJson(owner, { pid: 999999, startedAt: Date.now(), children: [999998] })
  assert.equal((await runPlugin(h)).code, 0)
  assert.equal(h.calls().at(-1), 'teamclaude status --json')
})

test('the managed router runtime: queries go through ~/.bin/lib/agent-router-env.zsh', { skip: !existsSync('/bin/zsh') }, async (t) => {
  const h = makeHome(t, { teamclaude: true, codex: true })
  normalFleet(h)
  h.fake('forecast.json', FORECAST_OK)
  const lib = join(h.home, '.bin/lib/agent-router-env.zsh')
  mkdirSync(join(h.home, '.bin/lib'), { recursive: true })
  writeFileSync(lib, `
router_direct_network() { print -r -- "direct-network PATH=$PATH" >> "$HOME/fake/calls.log" }
router_managed_node_bin() { print -r -- ${JSON.stringify(process.execPath)} }
router_require_managed_node() { [[ -x "$1" ]] }
router_managed_teamclaude_script() { print -r -- "$HOME/bin/teamclaude" }
router_managed_codex_manager_script() { print -r -- "$HOME/bin/codex-multi-auth" }
router_require_managed_script() { [[ -r "$1" ]] }
router_isolate_codex_multi_auth() { export CODEX_MULTI_AUTH_DIR="$HOME/.codex/multi-auth"; print -r -- isolated >> "$HOME/fake/calls.log" }
`)
  // Nothing on the search path: everything must come from the managed runtime.
  const result = await runPlugin(h, ['check'], { env: { ROUTER_LIMITS_BIN_PATH: '' } })
  assert.equal(result.code, 0, result.stderr)
  const calls = h.calls()
  assert.ok(calls.includes('direct-network PATH=/usr/bin:/bin:/usr/sbin:/sbin'))
  assert.ok(calls.includes('isolated'))
  assert.ok(PROBE(h))
  assert.ok(calls.includes('codex-multi-auth forecast --live --json --model gpt-6-astra'))
})

test('nothing to check: no cooldown is set', async (t) => {
  const h = makeHome(t, { teamclaude: false, codex: false })
  const result = await runPlugin(h, ['check'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /didn't run: no account to check/)
  assert.equal(h.readState().cooldownUntil, undefined)
  const menu = (await runPlugin(h)).stdout
  assert.match(menu, /\nCheck Now \| bash=/)
})

test('the menu run is safe to stop: a SIGTERM releases the lock', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  // A slow `teamclaude status`.
  writeExecutable(join(h.bin, 'teamclaude'), '#!/bin/sh\nsleep 5\n')
  let child
  const done = runPlugin(h, [], { onSpawn: (c) => { child = c } })
  await waitFor(() => existsSync(join(h.stateDir, 'lock', 'owner.json')))
  child.kill('SIGTERM')
  await done
  assert.equal(existsSync(join(h.stateDir, 'lock')), false)
})

test('one lock and cooldown for every caller: SwiftBar\'s data path and a terminal share them', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  h.fake('forecast.json', FORECAST_OK)
  h.fake('codex.json', { delayMs: 1500 }) // the first check is still running when the second starts
  const swiftbarData = join(h.home, 'Library/Application Support/SwiftBar/Plugins Data/router-limits.5m.js')
  // Check Now from SwiftBar, which sets SWIFTBAR_PLUGIN_DATA_PATH ...
  const first = runPlugin(h, ['check'], { env: { SWIFTBAR_PLUGIN_DATA_PATH: swiftbarData, SWIFTBAR: '1', ROUTER_LIMITS_NO_REFRESH: '1' } })
  await waitFor(() => h.calls().includes('teamclaude probe 3600'))
  assert.ok(existsSync(join(h.stateDir, 'lock', 'owner.json')), 'the lock is at the fixed path')
  // ... and from a terminal, without it, while the first one runs.
  const second = await runPlugin(h, ['check'], { env: { ROUTER_LIMITS_LOCK_WAIT_MS: '300' } })
  assert.equal(second.code, 0)
  assert.match(second.stdout, /cooldown|another check is running/)
  assert.equal((await first).code, 0)
  const calls = h.calls()
  assert.equal(calls.filter((c) => c === 'teamclaude probe 3600').length, 1)
  assert.equal(calls.filter((c) => c.startsWith('codex-multi-auth forecast')).length, 1)
  assert.equal(h.readState().lastCheck.failed, undefined)
  assert.equal(existsSync(swiftbarData), false, 'nothing is kept in SwiftBar\'s per-plugin directory')
})

test('the lock: its age never matters while its owner lives; a reused pid does not hold it', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  const owner = join(h.stateDir, 'lock', 'owner.json')
  // A check started two hours ago (the Mac slept) and still running.
  writeJson(owner, { pid: process.pid, startedAt: Date.now() - 2 * 3600e3, children: [] })
  await runPlugin(h)
  assert.deepEqual(h.calls(), [], 'the menu run left the live lock alone')
  assert.ok(existsSync(owner))
  // The same pid, but a different process from the one that took the lock.
  writeJson(owner, { pid: process.pid, startedAt: Date.now(), children: [], starts: { [process.pid]: 'Thu Jan  1 00:00:00 1970' } })
  await runPlugin(h)
  assert.deepEqual(h.calls(), ['teamclaude status --json'], 'the stale lock was taken over')
  assert.equal(existsSync(join(h.stateDir, 'lock')), false)
})

test('a lock records its owner\'s process start time', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  writeExecutable(join(h.bin, 'teamclaude'), '#!/bin/sh\nsleep 5\n')
  let child
  const done = runPlugin(h, [], { onSpawn: (c) => { child = c } })
  await waitFor(() => existsSync(join(h.stateDir, 'lock', 'owner.json')))
  const owner = JSON.parse(readFileSync(join(h.stateDir, 'lock', 'owner.json'), 'utf8'))
  assert.equal(owner.pid, child.pid)
  assert.match(owner.starts[child.pid], /^\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4}$/)
  child.kill('SIGTERM')
  await done
})

test('stock codex-multi-auth: a forecast without windows is read from the quota cache it updated', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  // The upstream report: status and plan only.
  h.fake('forecast.json', { command: 'forecast', liveProbe: true, accounts: [{ index: 0, availability: 'ready', liveQuota: { status: 200, planType: 'pro', activeLimit: null, model: 'gpt-6-astra', summary: 'ok' } }] })
  h.fake('forecast-cache.json', { 'acct-xray': { status: 200, model: 'gpt-6-astra', planType: 'pro', primary: fiveHour(20, '2026-10-08T20:00:00Z'), secondary: weekly(40, '2026-10-15T07:00:00Z') } })
  const result = await runPlugin(h, ['check'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /checked: 4 account\(s\) read$/m)
  const state = h.readState()
  assert.equal(state.lastCheck.failed, undefined)
  const x = state.providers.codex.accounts[Object.keys(state.providers.codex.accounts)[0]]
  assert.deepEqual(x.windows.week, { usedPercent: 40, resetAt: ms('2026-10-15T07:00:00Z') })
  assert.equal(x.checkError, undefined)
  const menu = (await runPlugin(h, [], { now: '2026-10-08T16:27:00.000Z' })).stdout
  assert.match(menu, /\nCodex {3}60% left/)
  assert.match(menu, /\nchecked 18:25 · next 18:36 \| size=11\n/)
})

test('stock codex-multi-auth: without a fresh cache entry the account failed', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  h.fake('forecast.json', { command: 'forecast', liveProbe: true, accounts: [{ index: 0, liveQuota: { status: 200, planType: 'pro' } }] })
  await runPlugin(h, ['check'])
  const x = Object.values(h.readState().providers.codex.accounts)[0]
  assert.equal(x.checkError.value, 'no quota windows')
})

test('Check Now asks SwiftBar to refresh this plugin by its id, the resolved path', async (t) => {
  const h = makeHome(t)
  const { refreshURL, config } = (await import('./helpers.mjs')).plugin
  const real = join(h.home, 'repo', 'router-limits.5m.js')
  writeExecutable(real, '')
  const link = join(h.home, 'Plugins', 'router-limits.5m.js')
  mkdirSync(join(h.home, 'Plugins'))
  symlinkSync(real, link)
  const url = refreshURL(config({ HOME: h.home, SWIFTBAR_PLUGIN_PATH: link }))
  const expected = realpathSync(real).replace(/^\/private(?=\/)/, '')
  assert.equal(url, `swiftbar://refreshplugin?plugin=${encodeURIComponent(expected)}`)
})
