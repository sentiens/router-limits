// Test doubles: a fake HOME with fake TeamClaude and codex-multi-auth
// executables, fixture builders and a runner for the plugin. Every identity
// here is made up (example.com).
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const PLUGIN = join(ROOT, 'router-limits.5m.js')
export const plugin = createRequire(import.meta.url)(PLUGIN)

// Thu 2026-10-08 18:25 in Europe/Berlin (CEST).
export const NOW = '2026-10-08T16:25:00.000Z'
export const TZ = 'Europe/Berlin'
export const ms = (iso) => Date.parse(iso)
export const SHOWN_PLUGIN_PATH = '/Users/example/SwiftBar/router-limits.5m.js'

// The fake `teamclaude`: `status --json` prints $HOME/fake/claude-status.json
// (with the probe state the fake keeps), `probe 3600|off` switches the fake
// probe. Behaviour comes from $HOME/fake/teamclaude.json:
//   { error: "message" }             status fails with that message on stderr
//   { probe: { run: "complete" | "never", statuses: { name: "ok" | "error" | "timeout" },
//              offFailures: n, offDelayMs: n, onFailures: n } }
// Every call is appended to $HOME/fake/calls.log.
const FAKE_TEAMCLAUDE = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const dir = path.join(process.env.HOME, 'fake')
const read = (name, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) } catch { return fallback } }
const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value))
const log = (line) => fs.appendFileSync(path.join(dir, 'calls.log'), line + '\\n')
const clock = read('clock.json', null)
const now = () => clock ? clock.base + (Date.now() - clock.realAt) : Date.now()
const config = read('teamclaude.json', {})
const args = process.argv.slice(2)
log('teamclaude ' + args.join(' '))
const state = read('probe-state.json', null)
const counters = read('counters.json', { off: 0, on: 0 })
;(async () => {
  if (args[0] === 'status') {
    if (config.error) { process.stderr.write(config.error + '\\n'); process.exit(1) }
    const status = read('claude-status.json', { accounts: [] })
    if (state) status.probe = state
    process.stdout.write(JSON.stringify(status))
    return
  }
  if (args[0] === 'probe' && args[1] === 'off') {
    if (counters.off < (config.probe?.offFailures ?? 0)) {
      counters.off++
      write('counters.json', counters)
      process.stderr.write('daemon restarting\\n')
      process.exit(1)
    }
    await new Promise((resolve) => setTimeout(resolve, config.probe?.offDelayMs ?? 0))
    const current = read('probe-state.json', read('claude-status.json', {}).probe ?? {})
    write('probe-state.json', { ...current, enabled: false, intervalSeconds: 0 })
    log('probe off done')
    return
  }
  if (args[0] === 'probe') {
    if (counters.on < (config.probe?.onFailures ?? 0)) {
      counters.on++
      write('counters.json', counters)
      process.stderr.write('timed out\\n')
      process.exit(1)
    }
    const status = read('claude-status.json', { accounts: [] })
    const t = now()
    const never = config.probe?.run === 'never'
    const statuses = config.probe?.statuses ?? {}
    write('probe-state.json', {
      enabled: true,
      intervalSeconds: Number(args[1]),
      lastRunStartedAt: new Date(t).toISOString(),
      lastRunFinishedAt: never ? null : new Date(t + 50).toISOString(),
      accounts: status.accounts.map((a) => ({ name: a.name, status: never ? 'running' : (statuses[a.name] ?? (a.disabled ? 'never' : 'ok')),
        lastProbedAt: never ? null : new Date(t + 50).toISOString() }))
    })
    return
  }
  process.exit(64)
})()
`

// The fake `codex-multi-auth`: `forecast --live --json --model M` prints
// $HOME/fake/forecast.json, or fails when it is missing. Like the stock
// router, it writes $HOME/fake/forecast-cache.json's entries (by account id)
// into the quota cache with the current time. $HOME/fake/codex.json may set
// { delayMs } before it answers.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const dir = path.join(process.env.HOME, 'fake')
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback } }
fs.appendFileSync(path.join(dir, 'calls.log'), 'codex-multi-auth ' + process.argv.slice(2).join(' ') + '\\n')
const clock = read(path.join(dir, 'clock.json'), null)
const now = () => clock ? clock.base + (Date.now() - clock.realAt) : Date.now()
const config = read(path.join(dir, 'codex.json'), {})
setTimeout(() => {
  let text
  try { text = fs.readFileSync(path.join(dir, 'forecast.json'), 'utf8') }
  catch { process.stderr.write('forecast failed\\n'); process.exit(1) }
  const updates = read(path.join(dir, 'forecast-cache.json'), null)
  if (updates) {
    const store = process.env.CODEX_MULTI_AUTH_DIR || path.join(process.env.HOME, '.codex', 'multi-auth')
    const cacheFile = path.join(store, 'quota-cache.json')
    const cache = read(cacheFile, { version: 1, byAccountId: {} })
    for (const [id, entry] of Object.entries(updates)) cache.byAccountId[id] = { ...entry, updatedAt: now() }
    fs.writeFileSync(cacheFile, JSON.stringify(cache))
  }
  process.stdout.write('Checking accounts...\\n' + text)
}, config.delayMs ?? 0)
`

export function makeHome(context, { teamclaude = true, codex = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'router-limits-test-'))
  context.after(() => rmSync(home, { recursive: true, force: true }))
  const bin = join(home, 'bin')
  mkdirSync(join(home, 'fake'), { recursive: true })
  mkdirSync(bin, { recursive: true })
  if (teamclaude) writeExecutable(join(bin, 'teamclaude'), FAKE_TEAMCLAUDE)
  if (codex) writeExecutable(join(bin, 'codex-multi-auth'), FAKE_CODEX)
  writeFileSync(join(home, 'fake', 'calls.log'), '')
  writeJson(join(home, 'fake', 'clock.json'), { base: ms(NOW), realAt: Date.now() })
  return {
    home,
    bin,
    stateDir: join(home, 'Library/Application Support/Router Limits/swiftbar'),
    subscriptions: join(home, 'Library/Application Support/Router Limits/subscriptions.json'),
    codexDir: join(home, '.codex/multi-auth'),
    fake: (name, value) => writeJson(join(home, 'fake', name), value),
    calls: () => readFileSync(join(home, 'fake', 'calls.log'), 'utf8').split('\n').filter(Boolean),
    readState: () => JSON.parse(readFileSync(join(home, 'Library/Application Support/Router Limits/swiftbar/state.json'), 'utf8'))
  }
}

export function writeExecutable(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  chmodSync(file, 0o755)
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

// Runs the plugin as SwiftBar would; resolves { code, signal, stdout, stderr }.
export function runPlugin(h, args = [], { env = {}, now = NOW, onSpawn } = {}) {
  // The fake routers' clock runs from the same fixed time, started just before the plugin's.
  writeJson(join(h.home, 'fake', 'clock.json'), { base: ms(now), realAt: Date.now() })
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PLUGIN, ...args], {
      env: {
        HOME: h.home,
        PATH: '/usr/bin:/bin',
        TZ,
        ROUTER_LIMITS_NOW: now,
        ROUTER_LIMITS_BIN_PATH: h.bin,
        SWIFTBAR_PLUGIN_PATH: SHOWN_PLUGIN_PATH,
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr, pid: child.pid }))
    onSpawn?.(child)
  })
}

export async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// --- Fixture builders -------------------------------------------------------

// A Claude account: windows as [used fraction, reset ISO] or null.
export function claudeAccount(name, { five = null, week = null, fable = null, lastUsed = null, disabled = false, type = 'oauth', plan } = {}) {
  const t = (iso) => (iso ? ms(iso) : null)
  return {
    name,
    type,
    provider: 'anthropic',
    disabled,
    status: 'active',
    ...(plan ? { plan } : {}),
    quota: {
      unified5h: five?.[0] ?? null,
      unified5hReset: t(five?.[1]),
      unified7d: week?.[0] ?? null,
      unified7dReset: t(week?.[1]),
      unified7dFable: fable?.[0] ?? null,
      unified7dFableReset: t(fable?.[1]),
      unified7dSonnet: null
    },
    usage: { lastUsed, totalRequests: 12 }
  }
}

export function claudeStatus(accounts, { current = accounts[0]?.name, probe } = {}) {
  return {
    currentAccount: current,
    accounts,
    probe: probe ?? {
      enabled: false,
      intervalSeconds: 0,
      lastRunStartedAt: '2026-10-08T11:34:00.000Z',
      lastRunFinishedAt: '2026-10-08T11:34:00.000Z',
      accounts: accounts.map((a) => ({ name: a.name, status: a.disabled ? 'never' : 'ok', lastProbedAt: a.disabled ? null : '2026-10-08T11:34:00.000Z' }))
    },
    server: { version: '1.1.21', port: 3456 }
  }
}

// Codex accounts file rows and quota cache entries.
export function codexFiles(h, accounts, { activeIndex = 0 } = {}) {
  writeJson(join(h.codexDir, 'openai-codex-accounts.json'), {
    version: 3,
    activeIndex,
    accounts: accounts.map((a) => ({
      accountId: a.id,
      email: a.email,
      accountLabel: 'Personal (role:owner)',
      accessToken: 'fake-access-token-not-a-secret',
      refreshToken: 'fake-refresh-token',
      ...(a.enabled === false ? { enabled: false } : {})
    }))
  })
  const byAccountId = {}
  for (const a of accounts) {
    if (!a.cache) continue
    byAccountId[a.id] = { status: 200, model: 'gpt-6-astra', ...a.cache }
  }
  writeJson(join(h.codexDir, 'quota-cache.json'), { version: 1, byAccountId })
}

export const weekly = (usedPercent, resetIso) => ({ usedPercent, windowMinutes: 10080, resetAtMs: ms(resetIso) })
export const fiveHour = (usedPercent, resetIso) => ({ usedPercent, windowMinutes: 300, resetAtMs: ms(resetIso) })

// The real-like fleet: three enabled Claude accounts and a disabled one, one Codex Pro account.
export function normalFleet(h) {
  h.fake('claude-status.json', claudeStatus([
    claudeAccount('bravo@example.com', { five: [0.01, '2026-10-08T18:20:00Z'], week: [0.3, '2026-10-12T19:00:00Z'], fable: [0, '2026-10-12T19:00:00Z'], lastUsed: '2026-10-08T16:23:00.000Z' }),
    claudeAccount('charlie@example.com', { five: [0.08, '2026-10-08T17:30:00Z'], week: [0.19, '2026-10-12T06:00:00Z'], fable: [0.11, '2026-10-12T06:00:00Z'], lastUsed: '2026-10-08T15:48:00.000Z' }),
    claudeAccount('alpha@example.com', { week: [0.24, '2026-10-13T05:00:00Z'], fable: [0, '2026-10-13T05:00:00Z'], lastUsed: '2026-10-06T19:45:00.000Z' }),
    claudeAccount('delta@example.com', { disabled: true })
  ]))
  codexFiles(h, [{ id: 'acct-xray', email: 'xray@example.com', cache: { planType: 'pro', updatedAt: ms('2026-10-08T15:53:00Z'), primary: weekly(0, '2026-10-15T07:00:00Z'), secondary: { usedPercent: 0, windowMinutes: 0 } } }])
}

export function subscriptionsFile(h, accounts, mode = 'final-week') {
  writeJson(h.subscriptions, { schemaVersion: 1, routingPolicy: { mode }, accounts })
}

export const manual = (date, kind = 'ends') => ({ manual: { date, kind, source: 'manual', checkedAt: 1790848800000 }, observed: null })

export function exists(file) {
  return existsSync(file)
}
