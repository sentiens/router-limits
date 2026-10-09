// Golden SwiftBar outputs: every menu state rendered from fake router outputs
// at a fixed time (Thu 2026-10-08 18:25, Europe/Berlin), compared with
// test/golden/<name>.txt. UPDATE_GOLDEN=1 rewrites them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ROOT, ms, makeHome, runPlugin, writeJson, normalFleet, claudeStatus, claudeAccount, codexFiles, weekly, fiveHour,
  subscriptionsFile, manual
} from './helpers.mjs'

function golden(name, output) {
  const file = join(ROOT, 'test', 'golden', `${name}.txt`)
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(join(ROOT, 'test', 'golden'), { recursive: true })
    writeFileSync(file, output)
    return
  }
  assert.equal(output, readFileSync(file, 'utf8'), `golden ${name}`)
}

async function menu(h, options) {
  const result = await runPlugin(h, [], options)
  assert.equal(result.code, 0, result.stderr)
  return result.stdout
}

test('normal: real-like fleet, no subscriptions.json (a public install)', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  const out = await menu(h)
  golden('normal', out)
  assert.match(out.split('\n')[0], /^\| sfimage=gauge\.with\.dots\.needle\.67percent$/)
  assert.doesNotMatch(out, /End Date|ends |gpt-6|Astra|delta/)
})

test('the next day the same readings are kept, past resets read 100%', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  await menu(h)
  golden('normal-next-day', await menu(h, { now: '2026-10-09T07:00:00.000Z' }))
})

test('end dates: shown only with the owner\'s subscriptions.json', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  subscriptionsFile(h, {
    'claude:delta@example.com': manual('2026-10-04'),
    'claude:bravo@example.com': manual('2026-10-10'),
    'claude:charlie@example.com': manual('2026-10-24', 'renews'),
    'claude:alpha@example.com': manual('2026-10-04'),
    'codex:9a3e9d69064746629271f4ac4c0d305ad8314dc23b96b410d92c0740c26e0b35': manual('2026-11-20')
  })
  const out = await menu(h)
  golden('end-dates', out)
  assert.match(out, /● bravo {3}70% · ends Sat/)
  assert.match(out, /○ alpha {3}\d+% · ended Oct 4/)
})

test('subscriptions.json that cannot be read: a warning, and no date edits', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  mkdirSync(join(h.subscriptions, '..'), { recursive: true })
  writeFileSync(h.subscriptions, '{"schemaVersion":1,')
  const out = await menu(h)
  golden('subscriptions-invalid', out)
  assert.match(out.split('\n')[0], /exclamationmark\.triangle/)
})

test('low: red icon, back times, a Codex fleet with only free accounts', async (t) => {
  const h = makeHome(t)
  h.fake('claude-status.json', claudeStatus([
    claudeAccount('india@example.com', { five: [0.95, '2026-10-08T17:30:00Z'], week: [0.5, '2026-10-12T19:00:00Z'], fable: [0, '2026-10-12T19:00:00Z'], lastUsed: '2026-10-08T16:20:00.000Z' }),
    claudeAccount('juliet@example.com', { five: [0.4, '2026-10-08T18:20:00Z'], week: [0.92, '2026-10-12T07:00:00Z'], fable: [0, '2026-10-12T07:00:00Z'], lastUsed: '2026-10-08T16:00:00.000Z' })
  ]))
  codexFiles(h, [
    { id: 'acct-free', email: 'november@example.com', cache: { planType: 'free', updatedAt: ms('2026-10-08T10:00:00Z') } },
    { id: 'acct-free2', email: 'oscar@example.com', cache: { planType: 'free', updatedAt: ms('2026-10-08T10:00:00Z') } }
  ])
  const out = await menu(h)
  golden('low', out)
  // SwiftBar ignores sfcolor on an sfimage (a template image): a red icon is
  // a symbol in the title, which sfcolor tints.
  assert.equal(out.split('\n')[0], ':gauge.with.dots.needle.0percent: | sfcolor=#d70015,#ff6961 sfsize=16')
})

test('Fable low: only then does Fable show on the row and the header', async (t) => {
  const h = makeHome(t)
  h.fake('claude-status.json', claudeStatus([
    claudeAccount('india@example.com', { five: [0.1, '2026-10-08T18:00:00Z'], week: [0.4, '2026-10-12T19:00:00Z'], fable: [0.9, '2026-10-12T19:00:00Z'], lastUsed: '2026-10-08T16:20:00.000Z' }),
    claudeAccount('juliet@example.com', { five: [0.1, '2026-10-08T18:00:00Z'], week: [0.3, '2026-10-13T07:00:00Z'], fable: [0.95, '2026-10-13T07:00:00Z'], lastUsed: '2026-10-08T16:00:00.000Z' })
  ]))
  codexFiles(h, [
    { id: 'acct-xray', email: 'xray@example.com', cache: { planType: 'pro', updatedAt: ms('2026-10-08T15:53:00Z'), primary: fiveHour(10, '2026-10-08T19:00:00Z'), secondary: weekly(35, '2026-10-15T07:00:00Z') } },
    { id: 'acct-free', email: 'november@example.com', cache: { planType: 'free', updatedAt: ms('2026-10-08T10:00:00Z') } }
  ])
  const out = await menu(h)
  golden('fable-low', out)
  assert.match(out, /Fable 7%/)
})

test('a check is running: the arrows, and "Checking…"', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  await menu(h)
  // Another process (this test) holds the lock and runs a check.
  const state = h.readState()
  state.running = { pid: process.pid, startedAt: ms('2026-10-08T16:24:30Z') }
  state.cooldownUntil = ms('2026-10-08T16:35:00Z')
  writeJson(join(h.stateDir, 'state.json'), state)
  writeJson(join(h.stateDir, 'lock', 'owner.json'), { pid: process.pid, startedAt: Date.now(), children: [] })
  h.fake('claude-status.json', claudeStatus([]))
  const out = await menu(h)
  golden('checking', out)
  assert.deepEqual(h.calls(), ['teamclaude status --json'], 'a busy run reads no router')
  golden('checking-since', await menu(h, { now: '2026-10-08T16:26:00.000Z' }))
})

test('after a check: the result under Check Now, the cooldown, a failed account', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  await menu(h)
  const state = h.readState()
  state.lastCheck = { startedAt: ms('2026-10-08T16:26:00Z'), finishedAt: ms('2026-10-08T16:26:20Z'), failed: ['claude:alpha@example.com'] }
  state.providers.claude.accounts['claude:alpha@example.com'].checkError = { at: ms('2026-10-08T16:26:00Z'), value: 'timeout' }
  state.cooldownUntil = ms('2026-10-08T16:36:00Z')
  writeJson(join(h.stateDir, 'state.json'), state)
  golden('after-check', await menu(h, { now: '2026-10-08T16:27:00.000Z' }))
  golden('after-cooldown', await menu(h, { now: '2026-10-08T16:40:00.000Z' }))
})

test('routers missing: each section says "not found"', async (t) => {
  const h = makeHome(t, { teamclaude: false, codex: false })
  const out = await menu(h)
  golden('routers-missing', out)
  assert.doesNotMatch(out, /exclamationmark/)
  // Nothing read: not a gauge with a value, and grey.
  assert.equal(out.split('\n')[0], ':gauge.with.needle: | sfcolor=#8e8e93,#98989d sfsize=16')
})

test('first run: accounts the routers have not read yet', async (t) => {
  const h = makeHome(t)
  h.fake('claude-status.json', claudeStatus([claudeAccount('bravo@example.com')]))
  codexFiles(h, [{ id: 'acct-xray', email: 'xray@example.com' }])
  golden('first-run', await menu(h))
})

test('TeamClaude unreadable: last known values stay, with a warning', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  await menu(h, { now: '2026-10-08T16:05:00.000Z' })
  h.fake('teamclaude.json', { error: 'connect ECONNREFUSED 127.0.0.1:3456' })
  const out = await menu(h)
  golden('teamclaude-unreadable', out)
  assert.match(out, /bravo {3}70%/)
})

test('stale: readings older than a day say how old, and never disappear', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  await menu(h)
  // Three days on, the routers have nothing newer.
  golden('stale', await menu(h, { now: '2026-10-11T16:25:00.000Z' }))
})

test('a router that cannot be read and a low pool: the warning triangle is red', async (t) => {
  const h = makeHome(t)
  h.fake('teamclaude.json', { error: 'connect ECONNREFUSED 127.0.0.1:3456' })
  codexFiles(h, [{ id: 'acct-xray', email: 'xray@example.com', cache: { planType: 'pro', updatedAt: ms('2026-10-08T15:53:00Z'), primary: fiveHour(10, '2026-10-08T19:00:00Z'), secondary: weekly(95, '2026-10-15T07:00:00Z') } }])
  const out = await menu(h)
  assert.equal(out.split('\n')[0], ':exclamationmark.triangle: | sfcolor=#d70015,#ff6961 sfsize=16')
  assert.match(out, /\nCodex {3}5% left · back Oct 15 \| color=#d70015/)
  // Without a low pool, the plain (template) triangle.
  codexFiles(h, [{ id: 'acct-xray', email: 'xray@example.com', cache: { planType: 'pro', updatedAt: ms('2026-10-08T15:54:00Z'), primary: fiveHour(10, '2026-10-08T19:00:00Z'), secondary: weekly(35, '2026-10-15T07:00:00Z') } }])
  assert.equal((await menu(h)).split('\n')[0], '| sfimage=exclamationmark.triangle')
})
