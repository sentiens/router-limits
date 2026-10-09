// subscriptions.json stays byte-compatible with v0.6.0 and the managed
// routers' reader; Set End Date writes only a manual "ends" record.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { plugin, makeHome, runPlugin, normalFleet, subscriptionsFile, manual, writeExecutable, ms, NOW } from './helpers.mjs'

const { normalizeSubscriptions, serializeSubscriptions, readSubscriptions, setManual, validDate, encodeKey, codexKey } = plugin

// v0.6.0's normalizeSubscriptions (src/subscriptions.mjs) and its write, the reference.
const V060 = `
const validDate = (value) => typeof value === 'string' && /^20\\d{2}-\\d{2}-\\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
function projectDate(value, source) {
  if (!validDate(value?.date) || !['period-end', 'ends', 'renews'].includes(value?.kind) ||
      value?.source !== source || !Number.isFinite(value?.checkedAt)) return null
  return { date: value.date, kind: value.kind, source, checkedAt: value.checkedAt,
    ...(source === 'codex-id-token' && Number.isFinite(value.endsAt) ? { endsAt: value.endsAt } : {}) }
}
function normalizeSubscriptions(raw) {
  const accounts = Object.create(null)
  for (const [key, record] of Object.entries(raw?.accounts ?? {})) {
    if (!/^(codex|claude):/.test(key)) continue
    accounts[key] = { manual: projectDate(record?.manual, 'manual'), observed: projectDate(record?.observed, 'codex-id-token') }
  }
  return { schemaVersion: 1, routingPolicy: { mode: raw?.routingPolicy?.mode === 'final-week' ? 'final-week' : 'off' }, accounts }
}
const inputs = JSON.parse(require('fs').readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify(inputs.map((text) => JSON.stringify(normalizeSubscriptions(JSON.parse(text))) + '\\n')))
`

const INPUTS = [
  '{"schemaVersion":1,"routingPolicy":{"mode":"final-week"},"accounts":{"codex:cda4":{"manual":{"date":"2026-09-16","kind":"ends","source":"manual","checkedAt":1789731479854},"observed":{"date":"2026-09-16","kind":"period-end","source":"codex-id-token","checkedAt":1788122678184,"endsAt":1789554415000}},"claude:a@example.com":{"manual":{"date":"2026-10-18","kind":"renews","source":"manual","checkedAt":1790690646611},"observed":null}}}',
  '{"schemaVersion":1,"routingPolicy":{"mode":"final-week","extra":1},"extra":true,"accounts":{"bogus":{},"claude:x":{"manual":{"date":"2026-02-30","kind":"ends","source":"manual","checkedAt":1}},"claude:y":{"manual":{"date":"2026-03-01","kind":"ends","source":"manual","checkedAt":1.5,"note":"<&>"}},"claude:z\\"q\\u2028":{"manual":{"date":"2026-03-01","kind":"later","source":"manual","checkedAt":1}},"codex:w":{"observed":{"date":"2026-03-01","kind":"period-end","source":"codex-id-token","checkedAt":2,"endsAt":"x"}}}}',
  '{"routingPolicy":{"mode":"off"},"accounts":[]}',
  '{}',
  'null',
  '[1,2]',
  '{"accounts":{"claude:a":{"manual":null},"claude:a":{"manual":{"date":"2026-10-10","kind":"ends","source":"manual","checkedAt":1e3}}}}',
  '{"accounts":{"claude:big":{"manual":{"date":"2026-10-10","kind":"ends","source":"manual","checkedAt":1e21}},"claude:tiny":{"manual":{"date":"2026-10-10","kind":"ends","source":"manual","checkedAt":1e-7}},"claude:neg":{"manual":{"date":"2026-10-10","kind":"ends","source":"manual","checkedAt":-0.0}},"claude:inf":{"manual":{"date":"2026-10-10","kind":"ends","source":"manual","checkedAt":1e400}}}}',
  '{"accounts":{"__proto__":{"manual":{"date":"2026-10-10","kind":"ends","source":"manual","checkedAt":1}},"constructor":{}}}'
]

test('normalization and serialization match v0.6.0 byte for byte', () => {
  const want = JSON.parse(execFileSync(process.execPath, ['-e', V060], { input: JSON.stringify(INPUTS) }).toString())
  INPUTS.forEach((text, i) => assert.equal(serializeSubscriptions(normalizeSubscriptions(JSON.parse(text))), want[i], `input ${i}`))
})

test('calendar dates are validated as v0.6.0 did', () => {
  for (const date of ['2026-02-29', '2026-09-31', '2026-13-01', '2026-01-01junk', '1970-01-01', '', null]) assert.equal(validDate(date), false)
  assert.equal(validDate('2028-02-29'), true)
})

test('the Codex key is sha256("account:" + id), as the routers use it', () => {
  assert.equal(codexKey('acct-xray', 'xray@example.com', 0), 'codex:9a3e9d69064746629271f4ac4c0d305ad8314dc23b96b410d92c0740c26e0b35')
  assert.notEqual(codexKey('', 'xray@example.com', 0), codexKey('', 'xray@example.com', 1))
})

test('a set keeps the routing policy, other records and observed dates; a clear keeps the entry', () => {
  const store = normalizeSubscriptions(JSON.parse(INPUTS[0]))
  setManual(store, 'claude:b@example.com', '2026-10-10', 1791463200000)
  setManual(store, 'codex:cda4', null)
  assert.equal(serializeSubscriptions(store),
    '{"schemaVersion":1,"routingPolicy":{"mode":"final-week"},"accounts":{"codex:cda4":{"manual":null,"observed":{"date":"2026-09-16","kind":"period-end","source":"codex-id-token","checkedAt":1788122678184,"endsAt":1789554415000}},' +
    '"claude:a@example.com":{"manual":{"date":"2026-10-18","kind":"renews","source":"manual","checkedAt":1790690646611},"observed":null},' +
    '"claude:b@example.com":{"manual":{"date":"2026-10-10","kind":"ends","source":"manual","checkedAt":1791463200000},"observed":null}}}\n')
})

test('read problems: missing is "off", invalid JSON can\'t be written, others can', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'router-limits-subs-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'subscriptions.json')
  assert.deepEqual(readSubscriptions(file), { exists: false })
  writeFileSync(file, '{')
  assert.deepEqual([readSubscriptions(file).error, readSubscriptions(file).writable], ['invalid JSON', false])
  writeFileSync(file, '{"schemaVersion":2,"accounts":{}}')
  assert.deepEqual([readSubscriptions(file).error, readSubscriptions(file).writable], ['unsupported schemaVersion', true])
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, pad: 'x'.repeat(300 * 1024) }))
  assert.deepEqual([readSubscriptions(file).error, readSubscriptions(file).writable], ['larger than 256 KiB', true])
})

const BRAVO = encodeKey('claude:bravo@example.com')

test('Set End Date writes only kind "ends", source "manual", atomically with mode 0600', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  await runPlugin(h)
  subscriptionsFile(h, { 'claude:charlie@example.com': manual('2026-10-24', 'renews') })
  const result = await runPlugin(h, ['set-end-date', BRAVO, '2026-10-10'])
  assert.equal(result.code, 0, result.stderr)
  const written = readFileSync(h.subscriptions, 'utf8')
  const checkedAt = Number(written.match(/"checkedAt":(\d+)},"observed":null}}}\n$/)[1])
  assert.ok(checkedAt >= ms(NOW) && checkedAt < ms(NOW) + 60e3)
  const text = written.replace(`"checkedAt":${checkedAt}}`, `"checkedAt":${ms(NOW)}}`)
  assert.equal(text, '{"schemaVersion":1,"routingPolicy":{"mode":"final-week"},"accounts":{' +
    '"claude:charlie@example.com":{"manual":{"date":"2026-10-24","kind":"renews","source":"manual","checkedAt":1790848800000},"observed":null},' +
    `"claude:bravo@example.com":{"manual":{"date":"2026-10-10","kind":"ends","source":"manual","checkedAt":${ms(NOW)}},"observed":null}}}\n`)
  assert.equal(statSync(h.subscriptions).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(dirname(h.subscriptions)).sort(), ['subscriptions.json', 'swiftbar'])
  // "-" (or an empty answer) removes an end date, never a legacy renewal record.
  await runPlugin(h, ['set-end-date', BRAVO, '-'])
  await runPlugin(h, ['set-end-date', encodeKey('claude:charlie@example.com'), '-'])
  const after = JSON.parse(readFileSync(h.subscriptions, 'utf8'))
  assert.equal(after.accounts['claude:bravo@example.com'].manual, null)
  assert.equal(after.accounts['claude:charlie@example.com'].manual.kind, 'renews')
})

test('Set End Date refuses bad dates, unknown accounts, a missing or unreadable file', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  await runPlugin(h)
  assert.equal((await runPlugin(h, ['set-end-date', BRAVO, '2026-10-10'])).code, 1, 'no subscriptions.json')
  assert.equal(existsSync(h.subscriptions), false)
  subscriptionsFile(h, {})
  const before = readFileSync(h.subscriptions, 'utf8')
  assert.equal((await runPlugin(h, ['set-end-date', BRAVO, '2026-02-30'])).code, 1)
  assert.equal(readFileSync(h.subscriptions, 'utf8'), before)
  assert.equal((await runPlugin(h, ['set-end-date', encodeKey('claude:delta@example.com'), '2026-10-10'])).code, 0, 'a disabled account is still in the router')
  assert.equal((await runPlugin(h, ['set-end-date', encodeKey('claude:nobody@example.com'), '2026-10-10'])).code, 1)
  writeFileSync(h.subscriptions, '{"schemaVersion":1,')
  assert.equal((await runPlugin(h, ['set-end-date', BRAVO, '2026-10-10'])).code, 1)
  assert.equal(readFileSync(h.subscriptions, 'utf8'), '{"schemaVersion":1,')
})

test('the dialog asks for the date (osascript display dialog) and a wrong answer is asked again', async (t) => {
  const h = makeHome(t)
  normalFleet(h)
  await runPlugin(h)
  subscriptionsFile(h, { 'claude:bravo@example.com': manual('2026-10-10') })
  const log = join(h.home, 'fake', 'osascript.log')
  const answers = join(h.home, 'fake', 'answers')
  writeFileSync(answers, 'next week\n2026-10-17\n')
  // A fake osascript: logs the prompt and default answer, replies line by line.
  writeExecutable(join(h.home, 'osascript'), `#!/bin/sh
args="$*"
n=$(wc -l < "${log}" 2>/dev/null || echo 0)
printf '%s\\n' "$(echo "$args" | tr '\\n' ' ')" >> "${log}"
sed -n "$((n + 1))p" "${answers}"
`)
  const result = await runPlugin(h, ['set-end-date', BRAVO], { env: { ROUTER_LIMITS_OSASCRIPT: join(h.home, 'osascript') } })
  assert.equal(result.code, 0, result.stderr)
  const prompts = readFileSync(log, 'utf8').trim().split('\n')
  assert.equal(prompts.length, 2)
  assert.match(prompts[0], /display dialog .* When does bravo@example\.com's subscription end\? Before it ends, the router prefers this account .* 2026-10-10 ?$/)
  assert.match(prompts[1], /"next week" is not a date\./)
  assert.equal(JSON.parse(readFileSync(h.subscriptions, 'utf8')).accounts['claude:bravo@example.com'].manual.date, '2026-10-17')
})

// The managed routers' reader accepts a written file. ROUTER_LIMITS_READER is
// the path of that reader module (it exports readSubscriptionPriority and
// subscriptionRank); the test is skipped without it.
const READER = process.env.ROUTER_LIMITS_READER || ''
test('the managed routers\' reader accepts a file the plugin wrote', { skip: !(READER && existsSync(READER)) && 'set ROUTER_LIMITS_READER to the managed routers\' reader' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'router-limits-reader-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'subscriptions.json')
  const store = normalizeSubscriptions(JSON.parse(INPUTS[0]))
  setManual(store, 'claude:b@example.com', '2026-10-10', 1791463200000)
  writeFileSync(file, serializeSubscriptions(store), { mode: 0o600 })
  const script = `
const { readSubscriptionPriority, subscriptionRank } = await import(process.argv[1])
const store = readSubscriptionPriority()
const now = Date.parse('2026-10-08T16:25:00Z')
process.stdout.write(JSON.stringify({ read: store !== null, rank: subscriptionRank(store, 'claude:b@example.com', null, now),
  legacy: subscriptionRank(store, 'claude:a@example.com', null, now) }))`
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script, `file://${READER}`], {
    env: { ...process.env, AGENT_ROUTER_SUBSCRIPTIONS_FILE: file, TZ: 'Europe/Berlin' }
  })
  assert.equal(out.stdout.toString(), '{"read":true,"rank":1791590400000,"legacy":null}', out.stderr.toString())
})
