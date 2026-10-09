// The TeamClaude probe toggling (ported from v0.6.0's claude-probe tests): the
// probe goes on for exactly one run and always off again, an operator's
// periodic probe is never toggled, and the ownership marker exists exactly
// while the probe may be on.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { plugin } from './helpers.mjs'

const { PROBE_HOLD_SECONDS, fileMarker, memoryMarker, parseClaudeStatus, probeRunComplete, runClaudeProbe } = plugin
const HOLD = String(PROBE_HOLD_SECONDS)
const T0 = Date.parse('2026-09-22T20:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

function status({ enabled, intervalSeconds = enabled ? 300 : 0, startedAt = null, finishedAt = null, accounts = [] }) {
  return {
    accounts: accounts.map(({ name }) => ({ name, type: 'oauth' })),
    probe: {
      enabled,
      intervalSeconds,
      lastRunStartedAt: startedAt === null ? null : iso(startedAt),
      lastRunFinishedAt: finishedAt === null ? null : iso(finishedAt),
      accounts: accounts.map(({ name, status: state }) => ({ name, status: state, lastProbedAt: iso(T0 + 900) }))
    }
  }
}

const complete = (raw, at) => probeRunComplete(parseClaudeStatus(JSON.stringify(raw)), at)

// A fake TeamClaude CLI that serves status replies in order and records every call.
function fakeTc(replies) {
  const calls = []
  let index = 0
  const tc = async (...args) => {
    calls.push(args.join(' '))
    if (args[0] !== 'status') return ''
    const reply = replies[Math.min(index, replies.length - 1)]
    index += 1
    return JSON.stringify(reply)
  }
  return { tc, calls }
}

function clock(start = T0, step = 100) {
  let t = start
  return { now: () => t, sleep: async (ms) => { t += ms || step } }
}

test('a run that started after the trigger and finished for every account is complete', () => {
  const done = status({ enabled: true, startedAt: T0 + 5, finishedAt: T0 + 800, accounts: [{ name: 'a', status: 'ok' }, { name: 'b', status: 'error' }] })
  assert.equal(complete(done, T0), true)
  assert.equal(complete({ ...done, probe: { ...done.probe, lastRunFinishedAt: iso(T0 - 1000) } }, T0), false)
  assert.equal(complete(status({ enabled: true, startedAt: T0 + 5, finishedAt: T0 + 800, accounts: [{ name: 'a', status: 'running' }] }), T0), false)
  assert.equal(complete(status({ enabled: true, startedAt: T0 - 60_000, finishedAt: T0 - 59_000, accounts: [{ name: 'a', status: 'ok' }] }), T0), false)
  assert.equal(complete({ ...done, probe: { ...done.probe, enabled: false } }, T0), false)
  assert.equal(complete(status({ enabled: true, startedAt: T0 + 5, finishedAt: T0 + 800 }), T0), false)
})

test('a check switches the daemon probe on for one run, returns that run and switches it off', async () => {
  const accounts = [{ name: 'a', status: 'ok' }, { name: 'b', status: 'error' }]
  const { tc, calls } = fakeTc([
    status({ enabled: false, startedAt: T0 - 3_600_000, finishedAt: T0 - 3_599_000, accounts }),
    status({ enabled: true, startedAt: T0 + 10, finishedAt: T0 - 3_599_000, accounts: [{ name: 'a', status: 'running' }, { name: 'b', status: 'running' }] }),
    status({ enabled: true, startedAt: T0 + 10, finishedAt: T0 + 700, accounts })
  ])
  const result = await runClaudeProbe({ tc, ...clock(), pollMs: 100 })
  assert.equal(result.operator, false)
  assert.equal(probeRunComplete(result.status, T0), true)
  assert.deepEqual(calls, ['status --json', `probe ${HOLD}`, 'status --json', 'status --json', 'probe off'])
})

test('the probe is switched off again when the run does not finish in time', async () => {
  const { tc, calls } = fakeTc([
    status({ enabled: false, accounts: [{ name: 'a', status: 'ok' }] }),
    status({ enabled: true, startedAt: T0 + 10, finishedAt: null, accounts: [{ name: 'a', status: 'running' }] })
  ])
  await assert.rejects(runClaudeProbe({ tc, ...clock(), timeoutMs: 1_000, pollMs: 250 }), /did not finish in time/)
  assert.equal(calls.at(-1), 'probe off')
  assert.equal(calls.filter((call) => call === `probe ${HOLD}`).length, 1)
})

test('a periodic probe configured by someone else is reported as is and never toggled', async () => {
  const periodic = status({ enabled: true, startedAt: T0 - 120_000, finishedAt: T0 - 119_000, accounts: [{ name: 'a', status: 'ok' }] })
  const { tc, calls } = fakeTc([periodic])
  const result = await runClaudeProbe({ tc, ...clock() })
  assert.equal(result.operator, true)
  assert.equal(result.status.probeInterval, 300)
  assert.deepEqual(calls, ['status --json'])
})

test('an interrupted check still switches the probe off', async () => {
  const controller = new AbortController()
  const running = status({ enabled: true, startedAt: T0 + 10, finishedAt: null, accounts: [{ name: 'a', status: 'running' }] })
  const { tc, calls } = fakeTc([status({ enabled: false, accounts: [{ name: 'a', status: 'ok' }] }), running])
  const { now } = clock()
  let polls = 0
  const sleep = async () => { if (++polls === 2) controller.abort() }
  await assert.rejects(runClaudeProbe({ tc, now, sleep, signal: controller.signal }), /interrupted/)
  assert.deepEqual(calls, ['status --json', `probe ${HOLD}`, 'status --json', 'status --json', 'probe off'])
})

test('a check interrupted before the probe was switched on never toggles it', async () => {
  const controller = new AbortController()
  const { tc, calls } = fakeTc([status({ enabled: false, accounts: [{ name: 'a', status: 'ok' }] })])
  const interrupting = async (...args) => { const out = await tc(...args); controller.abort(); return out }
  await assert.rejects(runClaudeProbe({ tc: interrupting, ...clock(), signal: controller.signal }), /interrupted/)
  assert.deepEqual(calls, ['status --json'])
})

test('a failed switch-on is followed by probe off', async () => {
  const { tc, calls } = fakeTc([status({ enabled: false, accounts: [{ name: 'a', status: 'ok' }] })])
  const failing = async (...args) => {
    if (args[0] === 'probe' && args[1] !== 'off') { calls.push(args.join(' ')); throw new Error('timed out') }
    return tc(...args)
  }
  await assert.rejects(runClaudeProbe({ tc: failing, ...clock() }), /timed out/)
  assert.deepEqual(calls, ['status --json', `probe ${HOLD}`, 'probe off'])
})

test('the ownership marker exists exactly while the probe may be on', async () => {
  const accounts = [{ name: 'a', status: 'ok' }]
  const marker = memoryMarker()
  const seen = []
  const { tc, calls } = fakeTc([status({ enabled: false, accounts }), status({ enabled: true, startedAt: T0 + 10, finishedAt: T0 + 700, accounts })])
  const watching = async (...args) => { seen.push(`${args.join(' ')} marker=${await marker.exists()}`); return tc(...args) }
  await runClaudeProbe({ tc: watching, marker, ...clock() })
  assert.deepEqual(seen, ['status --json marker=false', `probe ${HOLD} marker=true`, 'status --json marker=true', 'probe off marker=true'])
  assert.equal(await marker.exists(), false)
  assert.equal(calls.at(-1), 'probe off')
})

test('a failed probe off is retried once', async () => {
  const accounts = [{ name: 'a', status: 'ok' }]
  const { tc, calls } = fakeTc([status({ enabled: false, accounts }), status({ enabled: true, startedAt: T0 + 10, finishedAt: T0 + 700, accounts })])
  let offs = 0
  const flaky = async (...args) => {
    if (args.join(' ') === 'probe off' && ++offs === 1) { calls.push('probe off (failed)'); throw new Error('timed out') }
    return tc(...args)
  }
  const marker = memoryMarker()
  await runClaudeProbe({ tc: flaky, marker, ...clock() })
  assert.deepEqual(calls.slice(-2), ['probe off (failed)', 'probe off'])
  assert.equal(await marker.exists(), false)
})

test('a probe off that fails twice keeps the marker, and the next check switches the probe off', async () => {
  const accounts = [{ name: 'a', status: 'ok' }]
  const marker = memoryMarker()
  const first = fakeTc([status({ enabled: false, accounts }), status({ enabled: true, intervalSeconds: 3600, startedAt: T0 + 10, finishedAt: T0 + 700, accounts })])
  const failingOff = async (...args) => {
    if (args.join(' ') === 'probe off') { first.calls.push('probe off (failed)'); throw new Error('daemon restarting') }
    return first.tc(...args)
  }
  await assert.rejects(runClaudeProbe({ tc: failingOff, marker, ...clock() }), /probe off failed: daemon restarting/)
  assert.equal(await marker.exists(), true)

  // Left on at the hold interval: not an operator's probe. Off, then one fresh run, then off.
  const { tc, calls } = fakeTc([
    status({ enabled: true, intervalSeconds: PROBE_HOLD_SECONDS, startedAt: T0 - 120_000, finishedAt: T0 - 119_000, accounts }),
    status({ enabled: true, intervalSeconds: 3600, startedAt: T0 + 10, finishedAt: T0 + 700, accounts })
  ])
  const result = await runClaudeProbe({ tc, marker, ...clock() })
  assert.equal(probeRunComplete(result.status, T0), true)
  assert.deepEqual(calls, ['status --json', 'probe off', `probe ${HOLD}`, 'status --json', 'probe off'])
  assert.equal(await marker.exists(), false)
})

test('a stale marker never makes a periodic probe the operator set up look like ours', async () => {
  const accounts = [{ name: 'a', status: 'ok' }]
  const marker = memoryMarker()
  await marker.write({ at: iso(T0 - 86_400_000), intervalSeconds: PROBE_HOLD_SECONDS })
  const periodic = status({ enabled: true, intervalSeconds: 300, startedAt: T0 - 120_000, finishedAt: T0 - 119_000, accounts })
  const { tc, calls } = fakeTc([periodic])
  const result = await runClaudeProbe({ tc, marker, ...clock() })
  assert.equal(result.operator, true)
  assert.deepEqual(calls, ['status --json'])
  assert.equal(await marker.exists(), false)
})

test('a probe left on at the hold interval is switched off even without a marker', async () => {
  const accounts = [{ name: 'a', status: 'ok' }]
  const { tc, calls } = fakeTc([
    status({ enabled: true, intervalSeconds: PROBE_HOLD_SECONDS, startedAt: T0 - 120_000, finishedAt: T0 - 119_000, accounts }),
    status({ enabled: true, intervalSeconds: 3600, startedAt: T0 + 10, finishedAt: T0 + 700, accounts })
  ])
  await runClaudeProbe({ tc, ...clock() })
  assert.deepEqual(calls, ['status --json', 'probe off', `probe ${HOLD}`, 'status --json', 'probe off'])
})

test('the file marker records the time and interval with mode 0600', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'router-limits-marker-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'state/.probe-owned')
  const marker = fileMarker(file)
  assert.equal(await marker.exists(), false)
  await marker.write({ at: iso(T0), intervalSeconds: 3600 })
  assert.equal(await marker.exists(), true)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { at: iso(T0), intervalSeconds: 3600 })
  assert.equal(statSync(file).mode & 0o777, 0o600)
  await marker.clear()
  assert.equal(await marker.exists(), false)
})
