#!/bin/zsh
':' //; r=~/.local/share/agent-router-runtime/current/bin/node; [[ -e ~/.bin/lib/agent-router-env.zsh && -x $r ]] && exec $r "$0" "$@"; for n in ${commands[node]} /opt/homebrew/bin/node /usr/local/bin/node ~/.volta/bin/node ~/.local/share/mise/shims/node ~/.asdf/shims/node ~/.nvm/versions/node/v*/bin/node(Nn-*On) ~/.local/share/fnm/aliases/default/bin/node ~/Library/Application\ Support/fnm/aliases/default/bin/node; do [[ -x $n ]] && exec $n "$0" "$@"; done; print -l '| sfimage=exclamationmark.triangle' --- 'Router Limits needs Node.js 20 or newer (node not found)'; exit 0

// Router Limits: how much Claude (TeamClaude) and Codex (codex-multi-auth)
// quota is left, as a SwiftBar plugin. Lines 1-2 are a zsh launcher that finds
// node; from here on it is Node.js (20 or newer, standard library only).
//
// <xbar.title>Router Limits</xbar.title>
// <xbar.version>1.0.0</xbar.version>
// <xbar.author>sentiens</xbar.author>
// <xbar.author.github>sentiens</xbar.author.github>
// <xbar.desc>Quota left on your TeamClaude and codex-multi-auth accounts. Reads the routers' caches every 5 minutes; asks the accounts only when you click Check Now.</xbar.desc>
// <xbar.dependencies>node,teamclaude,codex-multi-auth</xbar.dependencies>
// <xbar.abouturl>https://github.com/sentiens/router-limits</xbar.abouturl>
// <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
// <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
//
// Commands (SwiftBar runs the first one every 5 minutes, the others from the menu):
//   router-limits.5m.js                         the menu, from the routers' caches only
//   router-limits.5m.js check                   a live check (Check Now)
//   router-limits.5m.js set-end-date <account> [YYYY-MM-DD | -]
//
// Never-auto rule: the menu run only reads caches (`teamclaude status --json`
// and codex-multi-auth's files). Only `check` switches the TeamClaude daemon
// probe on or runs the live Codex forecast.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawn, execFileSync } = require('node:child_process')

const LOW = 15 // a value at or below this is low (red)
const MINUTE = 60e3
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const COOLDOWN_MS = 10 * MINUTE // between the starts of two live checks
const LOCK_WAIT_MS = 200e3 // how long Check Now and date edits wait for the lock
const STATUS_TIMEOUT_MS = 15e3 // a cache read of TeamClaude's status
const TC_CALL_TIMEOUT_MS = 20e3 // one TeamClaude CLI call during a check
const FORECAST_TIMEOUT_MS = 90e3 // the live Codex forecast
const MAX_OUTPUT = 5 * 1024 * 1024
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const DEFAULT_CODEX_MODEL = 'gpt-6-astra'
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SUBSCRIPTIONS_READ_LIMIT = 256 * 1024 // the routers ignore a larger subscriptions.json

// An hour, not a short interval: if switching the probe off fails, the daemon
// falls back to an hourly probe rather than five-minute polling, and the next
// check recognises that interval as a probe left on by Router Limits and
// switches it off. Never configure a periodic probe of exactly 3600 s.
const PROBE_HOLD_SECONDS = 3600
const PROBE_START_TOLERANCE_MS = 250

// ---------------------------------------------------------------------------
// Configuration

function makeClock(env) {
  const fixed = env.ROUTER_LIMITS_NOW // tests: a fixed start time that then runs on
  if (!fixed) return Date.now
  const base = /^\d+$/.test(fixed) ? Number(fixed) : Date.parse(fixed)
  if (!Number.isFinite(base)) return Date.now
  const started = Date.now()
  return () => base + (Date.now() - started)
}

function config(env = process.env) {
  const home = env.HOME || os.homedir()
  const dataDir = env.ROUTER_LIMITS_DIR || path.join(home, 'Library', 'Application Support', 'Router Limits')
  // One fixed place for the state, the lock, the cooldown and the probe
  // marker, whatever runs the plugin (SwiftBar, a terminal) and whatever the
  // file is called: SWIFTBAR_PLUGIN_DATA_PATH differs per plugin file name and
  // is unset in a terminal, so it is not used.
  const stateDir = env.ROUTER_LIMITS_STATE_DIR || path.join(dataDir, 'swiftbar')
  const routerEnv = path.join(home, '.bin', 'lib', 'agent-router-env.zsh')
  const managed = fs.existsSync(routerEnv)
  const model = MODEL_PATTERN.test(env.ROUTER_LIMITS_CODEX_PROBE_MODEL || '') ? env.ROUTER_LIMITS_CODEX_PROBE_MODEL : DEFAULT_CODEX_MODEL
  return {
    env,
    home,
    managed,
    routerEnv,
    subscriptionsPath: path.join(dataDir, 'subscriptions.json'),
    stateDir,
    statePath: path.join(stateDir, 'state.json'),
    notePath: path.join(stateDir, 'check-note.json'),
    lockDir: path.join(stateDir, 'lock'),
    markerPath: path.join(stateDir, '.probe-owned'),
    codexDir: managed ? path.join(home, '.codex', 'multi-auth')
      : env.CODEX_MULTI_AUTH_DIR || (env.CODEX_HOME ? path.join(env.CODEX_HOME, 'multi-auth') : path.join(home, '.codex', 'multi-auth')),
    model,
    lockWaitMs: Number(env.ROUTER_LIMITS_LOCK_WAIT_MS) > 0 ? Number(env.ROUTER_LIMITS_LOCK_WAIT_MS) : LOCK_WAIT_MS, // tests
    pluginPath: env.SWIFTBAR_PLUGIN_PATH || __filename,
    now: makeClock(env)
  }
}

// The fixed environment of every router child, so SwiftBar and a shell behave
// the same: who the user is, and the system PATH.
function minimalEnv(env, extraPath = '') {
  const out = { PATH: extraPath ? `${extraPath}:${SYSTEM_PATH}` : SYSTEM_PATH }
  for (const name of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG']) if (env[name]) out[name] = env[name]
  return out
}

// Without the managed runtime, the routers also get the variables that say
// where their files are and how they reach the network: stock TeamClaude reads
// its config from $XDG_CONFIG_HOME, codex-multi-auth its accounts from
// $CODEX_MULTI_AUTH_DIR or $CODEX_HOME.
const ROUTER_ENV = [
  'XDG_CONFIG_HOME', 'CODEX_HOME', 'CODEX_MULTI_AUTH_DIR',
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'VOLTA_HOME', 'NVM_DIR'
]

function routerEnv(env, extraPath) {
  const out = minimalEnv(env, extraPath)
  for (const name of ROUTER_ENV) if (env[name]) out[name] = env[name]
  return out
}

// Version managers' bin directories (newest Node first): SwiftBar's login
// shell does not read .zshrc, where nvm and fnm are set up.
function versionManagerDirs(home) {
  const dirs = []
  try {
    const root = path.join(home, '.nvm', 'versions', 'node')
    const versions = fs.readdirSync(root).filter((name) => /^v\d+/.test(name))
    const key = (name) => name.slice(1).split('.').map((n) => parseInt(n, 10) || 0)
    versions.sort((a, b) => {
      const x = key(a)
      const y = key(b)
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (y[i] ?? 0) - (x[i] ?? 0)
      return 0
    })
    for (const name of versions) dirs.push(path.join(root, name, 'bin'))
  } catch {}
  dirs.push(
    path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    path.join(home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'),
    path.join(home, '.volta', 'bin')
  )
  return dirs
}

// Where the routers' executables are looked for without the managed runtime:
// PATH, Homebrew, /usr/local, npm's global bin, nvm, fnm and Volta.
function searchDirs(cfg) {
  const env = cfg.env
  if (env.ROUTER_LIMITS_BIN_PATH !== undefined) return env.ROUTER_LIMITS_BIN_PATH.split(':').filter(Boolean)
  const dirs = (env.PATH || '').split(':').filter(Boolean)
  dirs.push('/opt/homebrew/bin', '/usr/local/bin', path.dirname(process.execPath))
  if (env.NPM_CONFIG_PREFIX) dirs.push(path.join(env.NPM_CONFIG_PREFIX, 'bin'))
  try {
    const match = fs.readFileSync(path.join(cfg.home, '.npmrc'), 'utf8').match(/^\s*prefix\s*=\s*(.+?)\s*$/m)
    if (match) dirs.push(path.join(match[1].replace(/^~(?=\/|$)/, cfg.home), 'bin'))
  } catch {}
  dirs.push(path.join(cfg.home, '.npm-global', 'bin'), ...versionManagerDirs(cfg.home))
  return [...new Set(dirs)]
}

function findExecutable(cfg, names) {
  for (const dir of searchDirs(cfg)) {
    for (const name of names) {
      const file = path.join(dir, name)
      try {
        if (fs.statSync(file).isFile()) {
          fs.accessSync(file, fs.constants.X_OK)
          return file
        }
      } catch {}
    }
  }
  return null
}

// The managed routers' contract (the former scripts/router-query.zsh), run as
// /bin/zsh -c QUERY_ZSH router-query <query> [arg] with the minimal environment.
const QUERY_ZSH = `
emulate -L zsh
set -eu
setopt pipe_fail
case "\${1:-}" in
  claude-status) (( $# == 1 )) || exit 64 ;;
  claude-probe)
    (( $# == 2 )) || exit 64
    case "$2" in 3600|off) ;; *) exit 64 ;; esac
    ;;
  codex-forecast)
    (( $# == 2 )) || exit 64
    [[ "$2" =~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' ]] || exit 64
    ;;
  *) print -u2 'Unsupported router quota query'; exit 64 ;;
esac
source "\${HOME:?HOME must be set}/.bin/lib/agent-router-env.zsh"
router_direct_network
router_node=$(router_managed_node_bin)
router_require_managed_node "$router_node"
case "$1" in
  claude-status|claude-probe)
    router_cli=$(router_managed_teamclaude_script)
    router_require_managed_script "$router_cli"
    export TEAMCLAUDE_DISABLE_AUTOUPDATE=1
    export NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first"
    if [[ "$1" == claude-status ]]; then
      exec "$router_node" "$router_cli" status --json
    fi
    exec "$router_node" "$router_cli" probe "$2"
    ;;
  codex-forecast)
    router_isolate_codex_multi_auth
    router_cli=$(router_managed_codex_manager_script)
    router_require_managed_script "$router_cli"
    exec "$router_node" "$router_cli" forecast --live --json --model "$2"
    ;;
esac
`

function queryCommand(cfg, ...args) {
  return { file: '/bin/zsh', args: ['-c', QUERY_ZSH, 'router-query', ...args], env: minimalEnv(cfg.env) }
}

// `teamclaude status --json` or `teamclaude probe <3600|off>`; null when TeamClaude isn't installed.
function teamClaudeCommand(cfg, args) {
  if (cfg.managed) {
    return args[0] === 'status' ? queryCommand(cfg, 'claude-status') : queryCommand(cfg, 'claude-probe', args[1])
  }
  const file = findExecutable(cfg, ['teamclaude', 'teamrouter'])
  if (!file) return null
  const env = routerEnv(cfg.env, `${path.dirname(file)}:${path.dirname(process.execPath)}`)
  env.TEAMCLAUDE_DISABLE_AUTOUPDATE = '1'
  return { file, args, env }
}

// codex-multi-auth's live forecast; null when it isn't installed.
function forecastCommand(cfg) {
  if (cfg.managed) return queryCommand(cfg, 'codex-forecast', cfg.model)
  const file = findExecutable(cfg, ['codex-multi-auth'])
  if (!file) return null
  const env = routerEnv(cfg.env, `${path.dirname(file)}:${path.dirname(process.execPath)}`)
  return { file, args: ['forecast', '--live', '--json', '--model', cfg.model], env }
}

// ---------------------------------------------------------------------------
// Child processes

function firstLine(text) {
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed.slice(0, 200)
  }
  return ''
}

// Every child runs in its own process group: a terminal's Ctrl-C (sent to the
// whole foreground group) reaches only this process, which decides what
// reaches its children, so an in-flight `teamclaude probe off` is never cut
// short. A timeout, an overflow or `signal` sends the group SIGTERM; the
// promise still waits for the child to exit (never SIGKILL).
// Resolves { ok, stdout, reason }.
function runCommand(cmd, { timeoutMs = 0, signal, onStart, onExit } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd.file, cmd.args, { env: cmd.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    } catch (error) {
      resolve({ ok: false, stdout: '', reason: error.message })
      return
    }
    let settled = false
    let stopped = false
    let timedOut = false
    let overflow = false
    const out = []
    const err = []
    let outSize = 0
    let errSize = 0
    const stop = () => {
      if (stopped || !child.pid) return
      stopped = true
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
    }
    const onAbort = () => stop()
    if (child.pid && onStart) onStart(child.pid)
    child.stdout.on('data', (chunk) => {
      outSize += chunk.length
      if (outSize > MAX_OUTPUT) { overflow = true; stop() } else out.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      errSize += chunk.length
      if (errSize <= 64 * 1024) err.push(chunk)
    })
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; stop() }, timeoutMs) : null
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) stop()
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (child.pid && onExit) onExit(child.pid)
      resolve(result)
    }
    child.on('error', (error) => finish({ ok: false, stdout: '', reason: error.code === 'ENOENT' ? `${path.basename(cmd.file)} not found` : error.message }))
    child.on('close', (code, sig) => {
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = firstLine(Buffer.concat(err).toString('utf8'))
      if (code === 0 && !timedOut && !overflow && !stopped) return finish({ ok: true, stdout })
      let reason = `exit status ${code}`
      if (timedOut) reason = 'timeout'
      else if (overflow) reason = 'too much output'
      else if (stderr) reason = stderr
      else if (sig) reason = `stopped by ${sig}`
      finish({ ok: false, stdout, reason, signal: sig })
    })
  })
}

// { value } or { error }.
async function settle(fn) {
  try {
    return { value: await fn() }
  } catch (error) {
    return { error }
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// ---------------------------------------------------------------------------
// Files

// Writes data to a new 0600 file in the same directory and renames it over
// file: a reader (the managed routers read subscriptions.json at every account
// selection) only ever sees the old or the new file.
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600)
    try {
      fs.writeSync(fd, data)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temporary, file)
  } catch (error) {
    try { fs.unlinkSync(temporary) } catch {}
    throw error
  }
}

function readSmallFile(file, limit = MAX_OUTPUT) {
  const info = fs.statSync(file)
  if (!info.isFile()) throw new Error('not a regular file')
  if (info.size > limit) throw new Error('larger than 5 MiB')
  return fs.readFileSync(file, 'utf8')
}

// ---------------------------------------------------------------------------
// The lock: an atomic mkdir with the owner's pid (and the pids of the
// TeamClaude children it started, which may still switch the probe off after
// it is gone), each with its process start time. A lock whose processes are
// all gone is stale and is taken over. Its age never matters while one of them
// lives: a check outlasts any time limit when the Mac sleeps in the middle.

// A process's start time as ps prints it ('' when there is no such process),
// so a pid reused by another process is not taken for the owner.
function processStart(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return ''
  try {
    return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { PATH: SYSTEM_PATH, TZ: 'UTC', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5e3
    }).toString().trim()
  } catch {
    return ''
  }
}

// Alive, and (when the lock recorded it) still the process that took the lock.
function lockProcessAlive(pid, starts) {
  if (!isAlive(pid)) return false
  const recorded = starts && typeof starts === 'object' ? starts[pid] : undefined
  if (typeof recorded !== 'string' || !recorded) return true
  const current = processStart(pid)
  return current === '' || current === recorded
}

function readLockOwner(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'))
  } catch {
    return null
  }
}

function lockIsStale(dir) {
  const owner = readLockOwner(dir)
  if (!owner) {
    // Being created right now, or left half-made by a killed process.
    try {
      return Date.now() - fs.statSync(dir).mtimeMs > 30e3
    } catch {
      return false
    }
  }
  const pids = [owner.pid, ...(Array.isArray(owner.children) ? owner.children : [])]
  return !pids.some((pid) => lockProcessAlive(pid, owner.starts))
}

function tryLock(dir) {
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!lockIsStale(dir)) return null
      const seen = readLockOwner(dir)
      const aside = `${dir}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
      try { fs.renameSync(dir, aside) } catch { continue }
      const moved = readLockOwner(aside)
      if (JSON.stringify(moved) !== JSON.stringify(seen) && !fs.existsSync(dir)) {
        // Another process took the stale lock over between our check and the rename: give it back.
        try { fs.renameSync(aside, dir) } catch {}
        return null
      }
      fs.rmSync(aside, { recursive: true, force: true })
      continue
    }
    const owner = { pid: process.pid, startedAt: Date.now(), children: [], starts: {} }
    const ownStart = processStart(process.pid)
    if (ownStart) owner.starts[process.pid] = ownStart
    const write = () => writeAtomic(path.join(dir, 'owner.json'), `${JSON.stringify(owner)}\n`)
    write()
    let released = false
    const handle = {
      addChild(pid) {
        owner.children.push(pid)
        const start = processStart(pid)
        if (start) owner.starts[pid] = start
        try { write() } catch {}
      },
      removeChild(pid) {
        owner.children = owner.children.filter((p) => p !== pid)
        delete owner.starts[pid]
        try { write() } catch {}
      },
      release() {
        if (released) return
        released = true
        process.removeListener('exit', handle.release)
        const current = readLockOwner(dir)
        if (current && current.pid === process.pid) fs.rmSync(dir, { recursive: true, force: true })
      }
    }
    process.on('exit', handle.release)
    return handle
  }
  return null
}

async function acquireLock(dir, waitMs, signal) {
  const deadline = Date.now() + waitMs
  for (;;) {
    const lock = tryLock(dir)
    if (lock) return lock
    if (signal?.aborted || Date.now() >= deadline) return null
    await sleep(250, signal)
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

// ---------------------------------------------------------------------------
// State: each account's newest reading, the last check, the cooldown.

function newState() {
  return { schemaVersion: 1, providers: { claude: newProvider(), codex: newProvider() } }
}

function newProvider() {
  return { roster: [], accounts: {} }
}

function readState(cfg) {
  let text
  try {
    text = fs.readFileSync(cfg.statePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return newState()
    process.stderr.write(`router-limits: state.json can't be read (${error.code ?? error.message})\n`)
    return newState()
  }
  try {
    const state = JSON.parse(text)
    if (state?.schemaVersion !== 1 || typeof state.providers !== 'object' || state.providers === null) throw new Error('unsupported schemaVersion')
    for (const id of ['claude', 'codex']) {
      const p = state.providers[id] ?? newProvider()
      if (!Array.isArray(p.roster)) p.roster = []
      if (typeof p.accounts !== 'object' || p.accounts === null) p.accounts = {}
      state.providers[id] = p
    }
    return state
  } catch (error) {
    // Only this plugin's cache: keep the damaged file beside and start again.
    const aside = `${cfg.statePath}.unreadable-${Date.now()}`
    try { fs.renameSync(cfg.statePath, aside) } catch {}
    process.stderr.write(`router-limits: state.json can't be read (${error.message}); moved it to ${aside}\n`)
    return newState()
  }
}

function writeState(cfg, state) {
  writeAtomic(cfg.statePath, `${JSON.stringify(state, null, 2)}\n`)
}

// A short message about a check that could not record anything in the state
// (it never got the lock): shown under Check Now until the next check.
function writeNote(cfg, at, text) {
  try { writeAtomic(cfg.notePath, `${JSON.stringify({ at, text })}\n`) } catch {}
}

function readNote(cfg) {
  try {
    const note = JSON.parse(fs.readFileSync(cfg.notePath, 'utf8'))
    return Number.isFinite(note?.at) && typeof note.text === 'string' ? note : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Reading the routers

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v) => (typeof v === 'string' ? v : '')
const clampUsed = (v) => Math.max(0, Math.min(100, v))

// An ISO timestamp, or a number of ms (seconds when below 1e12); 0 when unknown.
function parseTime(value) {
  const n = num(value)
  if (n !== null) return n <= 0 ? 0 : Math.round(n < 1e12 ? n * 1000 : n)
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? ms : 0
}

// A TeamClaude utilization (0-1) and reset.
function fractionWindow(utilization, reset) {
  const value = num(utilization)
  return value === null ? null : { usedPercent: clampUsed(value * 100), resetAt: parseTime(reset) }
}

// `teamclaude status --json`: the accounts in router order, each with its
// roster facts and, when the daemon has one, a reading (windows and readAt),
// plus the daemon's probe state. A closed 5-hour window (unified5h null) is
// simply absent; it counts as 100%.
function parseClaudeStatus(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('invalid JSON from TeamClaude')
  }
  if (!raw || typeof raw !== 'object') throw new Error('invalid JSON from TeamClaude')
  const probe = raw.probe && typeof raw.probe === 'object' ? raw.probe : {}
  const status = {
    keys: [],
    accounts: {},
    probeEnabled: probe.enabled === true,
    probeInterval: num(probe.intervalSeconds) ?? 0,
    probeStartedAt: parseTime(probe.lastRunStartedAt),
    probeFinishedAt: parseTime(probe.lastRunFinishedAt),
    probeAccounts: {},
    probeCount: 0,
    probeSettled: true
  }
  for (const entry of Array.isArray(probe.accounts) ? probe.accounts : []) {
    status.probeCount++
    if (str(entry?.status) === 'running') status.probeSettled = false
    const name = str(entry?.name)
    if (name) status.probeAccounts[name] = { status: str(entry.status), lastProbedAt: parseTime(entry.lastProbedAt) }
  }
  const current = str(raw.currentAccount)
  ;(Array.isArray(raw.accounts) ? raw.accounts : []).forEach((account, index) => {
    const name = str(account?.name) || `Claude account ${index + 1}`
    const a = {
      name,
      email: name.includes('@') ? name : '',
      active: name === current,
      disabled: account?.disabled === true,
      plan: str(account?.plan).trim().toLowerCase(),
      oauth: str(account?.type) === 'oauth'
    }
    const q = account?.quota && typeof account.quota === 'object' ? account.quota : {}
    const windows = {}
    const w5 = fractionWindow(q.unified5h, q.unified5hReset)
    if (w5) windows['5h'] = w5
    const ww = fractionWindow(q.unified7d, q.unified7dReset)
    if (ww) windows.week = ww
    const wf = fractionWindow(q.unified7dFable, q.unified7dFableReset) ?? fractionWindow(q.scopedWeekly?.fable?.utilization, q.scopedWeekly?.fable?.resetAt)
    if (wf) windows.fable = wf
    if (Object.keys(windows).length > 0) {
      let readAt = Math.max(parseTime(account?.usage?.lastUsed), parseTime(q.unifiedStatusSeenAt), parseTime(q.unified7dFableSeenAt))
      const probed = status.probeAccounts[name]
      if (probed?.status === 'ok') readAt = Math.max(readAt, probed.lastProbedAt)
      a.windows = windows
      a.readAt = readAt
    }
    const key = `claude:${name}`
    if (!(key in status.accounts)) {
      status.keys.push(key)
      status.accounts[key] = a
    }
  })
  return status
}

// True once a probe run that started after triggeredAt has finished for every account.
function probeRunComplete(status, triggeredAt) {
  if (!status.probeEnabled || !status.probeStartedAt || !status.probeFinishedAt) return false
  if (status.probeStartedAt < triggeredAt - PROBE_START_TOLERANCE_MS || status.probeFinishedAt < status.probeStartedAt) return false
  return status.probeCount > 0 && status.probeSettled
}

class NotFound extends Error {}

async function readClaude(cfg, signal) {
  const cmd = teamClaudeCommand(cfg, ['status', '--json'])
  if (!cmd) throw new NotFound('TeamClaude not found')
  const result = await runCommand(cmd, { timeoutMs: STATUS_TIMEOUT_MS, signal })
  if (!result.ok) throw new Error(`teamclaude status: ${result.reason}`)
  return parseClaudeStatus(result.stdout)
}

// The subscriptions.json key of a Codex account: workspace-aware, without the raw account id.
function codexKey(accountId, email, index) {
  const identity = accountId ? `account:${accountId}` : `fallback:${email}:${index}`
  return `codex:${crypto.createHash('sha256').update(identity).digest('hex')}`
}

// Up to 5 hours is the 5-hour window, anything longer the weekly one.
function codexWindows(quota) {
  const windows = {}
  for (const w of [quota?.primary, quota?.secondary]) {
    const minutes = num(w?.windowMinutes)
    const used = num(w?.usedPercent)
    if (minutes === null || minutes <= 0 || used === null) continue
    const id = minutes <= 300 ? '5h' : 'week'
    if (windows[id]) continue
    windows[id] = { usedPercent: clampUsed(used), resetAt: Math.max(num(w.resetAtMs) ?? 0, 0) }
  }
  return windows
}

const planOf = (value) => str(value).trim().toLowerCase()

// codex-multi-auth's accounts file and quota cache. Codex limits are shared
// across models, so a cache entry counts whichever model the router last asked with.
function readCodex(dir) {
  let accountsText
  try {
    accountsText = readSmallFile(path.join(dir, 'openai-codex-accounts.json'))
  } catch (error) {
    if (error.code === 'ENOENT') throw new NotFound('codex-multi-auth not found')
    throw new Error(`openai-codex-accounts.json: ${error.code ?? error.message}`)
  }
  let file
  try {
    file = JSON.parse(accountsText)
  } catch {
    throw new Error('openai-codex-accounts.json: invalid JSON')
  }
  let cache = {}
  try { cache = JSON.parse(readSmallFile(path.join(dir, 'quota-cache.json'))) ?? {} } catch {}
  const byId = cache.byAccountId && typeof cache.byAccountId === 'object' ? cache.byAccountId : {}
  const byEmail = cache.byEmail && typeof cache.byEmail === 'object' ? cache.byEmail : {}
  const active = num(file?.activeIndex)
  const read = { keys: [], accounts: {}, index: [] }
  ;(Array.isArray(file?.accounts) ? file.accounts : []).forEach((raw, index) => {
    const accountId = str(raw?.accountId)
    const email = str(raw?.email)
    const name = email || str(raw?.accountLabel) || `Codex account ${index + 1}`
    const a = { name, email, active: active === index, disabled: raw?.enabled === false, plan: '', oauth: true }
    const entry = accountId ? byId[accountId] : email ? byEmail[email.trim().toLowerCase()] : null
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      a.plan = planOf(entry.planType)
      const windows = codexWindows(entry)
      if (Object.keys(windows).length > 0 && a.plan !== 'free') {
        a.windows = windows
        a.readAt = parseTime(entry.updatedAt)
      }
    }
    const key = codexKey(accountId, email, index)
    if (!(key in read.accounts)) {
      read.keys.push(key)
      read.accounts[key] = a
      read.index.push(index) // the forecast counts accounts file rows
    }
  })
  return read
}

// `codex-multi-auth forecast --live --json`: per account, its windows or the
// reason it has none. Router messages are never kept. Stock codex-multi-auth
// reports only the HTTP status and the plan; the windows of an answered
// request (`needsCache`) are then in the quota cache it has just updated.
function parseForecast(stdout) {
  const lines = String(stdout).trim().split('\n')
  const start = lines.findIndex((line) => line.trim().startsWith('{'))
  if (start < 0) throw new Error('no JSON from the Codex router')
  let raw
  try {
    raw = JSON.parse(lines.slice(start).join('\n'))
  } catch {
    throw new Error('invalid JSON from the Codex router')
  }
  if (raw?.command !== 'forecast' || raw.liveProbe !== true || !Array.isArray(raw.accounts)) throw new Error('unexpected reply from the Codex router')
  const result = []
  for (const account of raw.accounts) {
    const index = num(account?.index)
    if (index === null || index < 0 || !Number.isInteger(index)) continue
    const item = { index, ok: false, reason: '', plan: '', windows: {}, availability: '', needsCache: false }
    if (['ready', 'delayed', 'unavailable'].includes(account.availability)) item.availability = account.availability
    const quota = account.liveQuota
    if (!quota || typeof quota !== 'object') {
      item.reason = 'no result'
    } else {
      const status = num(quota.status) ?? 0
      item.plan = planOf(quota.planType)
      item.windows = codexWindows(quota)
      if (status !== 200 && status !== 429) item.reason = status === 0 ? 'no HTTP status' : `HTTP ${status}`
      else if (item.plan === 'free') { item.ok = true; item.windows = {} }
      else if (Object.keys(item.windows).length === 0) item.needsCache = true
      else item.ok = true // HTTP 429 with windows is a reading: the account is exhausted
    }
    result.push(item)
  }
  return result
}

// A router read: the roster is replaced, and each reading replaces the stored
// one when it is at least as new. A failed read never gets here.
function mergeRead(p, read, now) {
  p.roster = [...read.keys]
  for (const key of read.keys) {
    const fresh = read.accounts[key]
    const old = p.accounts[key]
    if (!old) {
      p.accounts[key] = { ...fresh }
      continue
    }
    Object.assign(old, { name: fresh.name, email: fresh.email, active: fresh.active, disabled: fresh.disabled, oauth: fresh.oauth })
    if (fresh.plan) old.plan = fresh.plan
    if (fresh.windows && (!old.windows || (fresh.readAt ?? 0) >= (old.readAt ?? 0))) {
      old.windows = fresh.windows
      old.readAt = fresh.readAt
    }
  }
  p.readAt = now
  delete p.error
  delete p.notSetUp
}

function readFailed(p, error, now) {
  if (error instanceof NotFound) {
    p.notSetUp = true
    delete p.error
    return
  }
  p.error = { at: p.error?.at ?? now, value: error.message }
}

// ---------------------------------------------------------------------------
// subscriptions.json: the owner's routing policy, read by the managed routers
// at every account selection. Its format,
// keys, schemaVersion 1, routingPolicy, 0600 and the atomic same-directory
// rename must not change: it is normalized and written exactly as v0.6.0 did.

function validDate(value) {
  return typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}

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
    accounts[key] = {
      manual: projectDate(record?.manual, 'manual'),
      observed: projectDate(record?.observed, 'codex-id-token')
    }
  }
  return { schemaVersion: 1, routingPolicy: { mode: raw?.routingPolicy?.mode === 'final-week' ? 'final-week' : 'off' }, accounts }
}

const serializeSubscriptions = (store) => `${JSON.stringify(store)}\n`

// { exists: false } when there is no file (end dates are then not shown at
// all); otherwise the normalized store, and why it can't be used if it can't
// (writable: a save may replace it, as v0.6.0 did).
function readSubscriptions(file) {
  let info
  try {
    info = fs.statSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false }
    return { exists: true, store: normalizeSubscriptions({}), error: error.code ?? error.message, writable: false }
  }
  if (!info.isFile()) return { exists: true, store: normalizeSubscriptions({}), error: 'not a regular file', writable: false }
  let text
  let raw
  try {
    text = fs.readFileSync(file, 'utf8')
    raw = JSON.parse(text)
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'invalid JSON' : (error.code ?? error.message)
    return { exists: true, store: normalizeSubscriptions({}), error: reason, writable: false }
  }
  const store = normalizeSubscriptions(raw)
  if (Buffer.byteLength(text) > SUBSCRIPTIONS_READ_LIMIT) return { exists: true, store, error: 'larger than 256 KiB', writable: true }
  if (raw?.schemaVersion !== 1) return { exists: true, store, error: 'unsupported schemaVersion', writable: true }
  return { exists: true, store, error: null, writable: true }
}

// The account's manual record: kind "ends", source "manual", or removed (null).
function setManual(store, key, date, now) {
  const record = store.accounts[key] ?? { manual: null, observed: null }
  record.manual = date === null ? null : { date, kind: 'ends', source: 'manual', checkedAt: now }
  store.accounts[key] = record
  return store
}

// ---------------------------------------------------------------------------
// The TeamClaude probe: one on-demand, fleet-wide quota probe through the
// resident daemon. The daemon's background probe stays off, so nothing polls
// the usage endpoint between explicit checks. Switching the probe on makes the
// daemon probe every OAuth account once, immediately (its off -> on
// transition), with its own token manager, so the daemon remains the only
// process that refreshes tokens. It is switched off again as soon as that run
// finishes.

function memoryMarker() {
  let present = false
  return {
    exists: async () => present,
    write: async () => { present = true },
    clear: async () => { present = false }
  }
}

// The ownership marker (.probe-owned: JSON with the time and the interval, mode 0600).
function fileMarker(file) {
  return {
    exists: async () => fs.existsSync(file),
    write: async (info) => writeAtomic(file, `${JSON.stringify(info)}\n`),
    clear: async () => fs.rmSync(file, { force: true })
  }
}

// `tc(...args)` runs the TeamClaude CLI and resolves with its stdout. `signal`
// interrupts the run; once `probe` has been sent, `probe off` always follows
// (retried once): a probe left on would keep the daemon polling every account.
// `marker` exists exactly while the probe may be on. A probe left on after all
// (both `probe off` attempts failed, a SIGKILL, a logout) still runs at the
// hold interval, so the next check switches it off; a probe at any other
// interval is the operator's and is never toggled, whatever the marker says:
// its latest run is returned as is.
async function runClaudeProbe({ tc, marker = memoryMarker(), now = Date.now, sleep: wait = sleep, timeoutMs = 60e3, pollMs = 500, retryMs = 2e3, signal }) {
  const read = async () => parseClaudeStatus(await tc('status', '--json'))
  // Never interrupted: it is the cleanup.
  const switchOff = async () => {
    try {
      await tc('probe', 'off')
    } catch {
      await wait(retryMs)
      await tc('probe', 'off')
    }
  }
  const interrupted = () => new Error('TeamClaude probe interrupted')

  const before = await read()
  if (before.probeEnabled) {
    if (before.probeInterval !== PROBE_HOLD_SECONDS) {
      // The operator's periodic probe: report its latest run, and drop a
      // marker that no longer describes anything.
      if (await marker.exists()) await marker.clear()
      return { status: before, operator: true }
    }
    // Ours, left on: off first, so the switch-on below is an off -> on
    // transition, which is what makes the daemon probe at once.
    try {
      await switchOff()
    } catch (error) {
      throw new Error(`a TeamClaude probe left on could not be switched off: ${error.message}`)
    }
    await marker.clear()
  }
  if (signal?.aborted) throw interrupted()

  const triggeredAt = now()
  await marker.write({ at: new Date(triggeredAt).toISOString(), intervalSeconds: PROBE_HOLD_SECONDS })
  let result
  let failure = null
  try {
    await tc('probe', String(PROBE_HOLD_SECONDS))
    for (;;) {
      if (signal?.aborted) throw interrupted()
      const current = await read()
      if (probeRunComplete(current, triggeredAt)) {
        result = { status: current, operator: false }
        break
      }
      if (now() - triggeredAt >= timeoutMs) throw new Error('TeamClaude probe did not finish in time')
      await wait(pollMs, signal)
    }
  } catch (error) {
    failure = error
  }
  try {
    await switchOff()
  } catch (error) {
    // The marker stays: the probe may still be on, at the hold interval.
    throw failure ?? new Error(`TeamClaude probe off failed: ${error.message}`)
  }
  await marker.clear()
  if (failure) throw failure
  return result
}

// ---------------------------------------------------------------------------
// The live check (Check Now): one TeamClaude daemon probe run for the Claude
// fleet, and one tiny diagnostic request per enabled Codex account
// (codex-multi-auth's live forecast). At most one every 10 minutes.

const ceilMinute = (ms) => Math.ceil(ms / MINUTE) * MINUTE
const CACHE_CLOCK_SLACK_MS = 1e3 // a cache time in whole seconds may round below the check's start

function shortReason(error) {
  const text = error?.message ?? String(error)
  return /did not finish in time/.test(text) ? 'timeout' : text
}

async function checkClaude(cfg, signal, lock) {
  if (!teamClaudeCommand(cfg, ['status', '--json'])) throw new NotFound('TeamClaude not found')
  const tc = async (...args) => {
    const cmd = teamClaudeCommand(cfg, args)
    if (!cmd) throw new Error('TeamClaude not found')
    // A `probe` call is never interrupted: `probe off` must finish.
    const result = await runCommand(cmd, {
      timeoutMs: TC_CALL_TIMEOUT_MS,
      onStart: (pid) => lock.addChild(pid),
      onExit: (pid) => lock.removeChild(pid)
    })
    if (!result.ok) throw new Error(result.reason)
    return result.stdout
  }
  return runClaudeProbe({ tc, marker: fileMarker(cfg.markerPath), now: cfg.now, signal })
}

async function checkCodex(cfg, signal) {
  const read = readCodex(cfg.codexDir) // NotFound when not set up
  const enabled = read.keys.filter((key) => !read.accounts[key].disabled).length
  if (enabled === 0) return { read, forecast: null }
  const cmd = forecastCommand(cfg)
  if (!cmd) return { read, error: new Error('codex-multi-auth not found') }
  const result = await runCommand(cmd, { timeoutMs: FORECAST_TIMEOUT_MS, signal })
  if (!result.ok) return { read, error: new Error(result.reason) }
  let forecast
  try {
    forecast = parseForecast(result.stdout)
  } catch (error) {
    return { read, error }
  }
  // The forecast has updated the quota cache of every account it asked.
  let after = read
  try { after = readCodex(cfg.codexDir) } catch {}
  return { read: after, forecast }
}

// SwiftBar's URL that runs this plugin again. SwiftBar knows a plugin by its
// id, the plugin file's path with symlinks resolved (and, as macOS resolves
// it, without a leading /private when the shorter path exists).
function refreshURL(cfg) {
  let id = cfg.pluginPath
  try { id = fs.realpathSync(id) } catch {}
  if (id.startsWith('/private/') && fs.existsSync(id.slice('/private'.length))) id = id.slice('/private'.length)
  return `swiftbar://refreshplugin?plugin=${encodeURIComponent(id)}`
}

// Asks SwiftBar to run the menu again (it shows the check as running).
function refreshSwiftBar(cfg) {
  if (cfg.env.SWIFTBAR !== '1' || cfg.env.ROUTER_LIMITS_NO_REFRESH) return
  try {
    spawn('/usr/bin/open', ['-g', refreshURL(cfg)], { stdio: 'ignore', detached: true }).unref()
  } catch {}
}

async function check(cfg) {
  const controller = new AbortController()
  let received = null
  for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    // Repeated signals are ignored: they must not cut the `probe off` cleanup short.
    process.on(name, () => {
      if (received) return
      received = name
      controller.abort()
    })
  }
  const signal = controller.signal
  const clock = makeFormat(cfg.now())
  const refusal = (state) => {
    const until = state.cooldownUntil ?? 0
    return cfg.now() < until ? `cooldown: the next check can run at ${clock.withTime(until)}` : null
  }
  // Tested before the lock (a refused check never waits) and again under it.
  const early = refusal(readState(cfg))
  if (early) {
    process.stdout.write(`${early}\n`)
    return 0
  }
  const lock = await acquireLock(cfg.lockDir, cfg.lockWaitMs, signal)
  if (!lock) {
    if (received) return exitWithSignal(received)
    writeNote(cfg, cfg.now(), "didn't run: another check is running")
    process.stdout.write("another check is running\n")
    return 0
  }
  try {
    const state = readState(cfg)
    const refused = refusal(state)
    if (refused) {
      process.stdout.write(`${refused}\n`)
      return 0
    }
    const start = cfg.now()
    const previousCooldown = state.cooldownUntil
    // The cooldown is set before any request is made.
    state.cooldownUntil = ceilMinute(start + COOLDOWN_MS)
    state.running = { pid: process.pid, startedAt: start }
    writeState(cfg, state)
    refreshSwiftBar(cfg)

    const [claude, codex] = await Promise.all([
      settle(() => checkClaude(cfg, signal, lock)),
      settle(() => checkCodex(cfg, signal)).then((r) => r.value ?? r)
    ])
    if (received) {
      // Nothing is recorded; the probe has been switched off. The cooldown stays.
      delete state.running
      writeState(cfg, state)
      return exitWithSignal(received, lock)
    }
    const end = cfg.now()
    const summary = applyCheck(state, { claude, codex, start, end })
    if (summary.nothingAsked) state.cooldownUntil = previousCooldown
    if (state.cooldownUntil === undefined) delete state.cooldownUntil
    delete state.running
    writeState(cfg, state)
    fs.rmSync(cfg.notePath, { force: true })
    process.stdout.write(summary.text + '\n')
    return 0
  } finally {
    lock.release()
  }
}

function exitWithSignal(name, lock) {
  lock?.release()
  process.removeAllListeners(name)
  process.kill(process.pid, name)
  return 1
}

// Records a check's results in the state; returns { text, nothingAsked }.
function applyCheck(state, { claude, codex, start, end }) {
  const at = start
  for (const id of ['claude', 'codex']) {
    for (const a of Object.values(state.providers[id].accounts)) {
      delete a.checkError
      delete a.availability
    }
  }
  const failed = []
  const wide = []
  let succeeded = 0
  let accountFailures = 0
  const fail = (key, a, reason, providerWide = false) => {
    a.checkError = { at, value: reason }
    failed.push(key)
    if (!providerWide) accountFailures++
  }

  // Claude: the daemon's probe report, account by account.
  const cp = state.providers.claude
  if (claude.error instanceof NotFound) {
    readFailed(cp, claude.error, end)
  } else if (claude.error) {
    const reason = shortReason(claude.error)
    wide.push(reason)
    for (const key of cp.roster) {
      const a = cp.accounts[key]
      if (a && !a.disabled && a.oauth) fail(key, a, reason, true)
    }
  } else {
    const { status, operator } = claude.value
    mergeRead(cp, status, end)
    for (const key of status.keys) {
      const a = cp.accounts[key]
      if (a.disabled || !a.oauth) continue
      const probe = status.probeAccounts[a.name]
      if (probe?.status === 'ok') succeeded++
      else if (probe?.status === 'timeout') fail(key, a, 'timeout')
      else if (probe?.status === 'error') fail(key, a, 'probe error')
      else if (!operator) fail(key, a, 'not probed') // not part of the operator's latest run otherwise
    }
  }

  // Codex: the forecast, by accounts file row.
  const xp = state.providers.codex
  if (codex.error && !codex.read) {
    readFailed(xp, codex.error, end)
    if (!(codex.error instanceof NotFound)) wide.push(shortReason(codex.error))
  } else {
    mergeRead(xp, codex.read, end)
    const byIndex = new Map((codex.forecast ?? []).map((item) => [item.index, item]))
    if (codex.error) wide.push(shortReason(codex.error))
    codex.read.keys.forEach((key, i) => {
      const a = xp.accounts[key]
      if (a.disabled) return
      if (codex.error) {
        if (a.plan !== 'free') fail(key, a, shortReason(codex.error), true)
        return
      }
      const item = byIndex.get(codex.read.index[i])
      if (!item) return fail(key, a, 'no result')
      if (item.availability && item.availability !== 'ready') a.availability = { at, value: item.availability }
      if (item.needsCache) {
        // Answered, without windows in the report: a reading only when the
        // quota cache has an entry written by this check.
        const cached = codex.read.accounts[key]
        if (cached.plan === 'free') {
          succeeded++
          a.plan = 'free'
          return
        }
        if (!cached.windows || !(cached.readAt >= start - CACHE_CLOCK_SLACK_MS)) return fail(key, a, 'no quota windows')
        succeeded++
        if (item.plan) a.plan = item.plan
        a.windows = cached.windows
        a.readAt = cached.readAt
        return
      }
      if (!item.ok) return fail(key, a, item.reason)
      succeeded++
      if (item.plan) a.plan = item.plan
      if (Object.keys(item.windows).length > 0) {
        a.windows = item.windows
        a.readAt = end
      }
    })
  }

  const record = { startedAt: start, finishedAt: end }
  if (failed.length) record.failed = failed
  let nothingAsked = false
  if (succeeded === 0 && failed.length === 0 && wide.length === 0) {
    // No router is set up, or no account is enabled: nothing was asked.
    record.didNotRun = 'no account to check'
    nothingAsked = true
  } else if (succeeded === 0 && wide.length > 0 && accountFailures === 0) {
    record.didNotRun = wide[0]
    delete record.failed
  }
  state.lastCheck = record
  const text = record.didNotRun ? `didn't run: ${record.didNotRun}`
    : `checked: ${succeeded} account(s) read${failed.length ? `, ${failed.length} failed` : ''}`
  return { text, nothingAsked }
}

// ---------------------------------------------------------------------------
// Times, in the Mac's local zone: a clock time today, a weekday within six
// days, a date further away.

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n) => String(n).padStart(2, '0')

function makeFormat(now) {
  const dayNumber = (ms) => {
    const d = new Date(ms)
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY
  }
  const today = dayNumber(now)
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
  // A calendar date (YYYY-MM-DD), as a UTC midnight.
  const dateMs = (value) => Date.parse(`${value}T00:00:00Z`)
  const monthDay = (value) => {
    const d = new Date(dateMs(value))
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
  }
  return {
    // "20:20" today, "Mon" within six days, "Oct 15" further away.
    short(ms) {
      const d = new Date(ms)
      const days = Math.abs(dayNumber(ms) - today)
      if (days === 0) return hm(d)
      if (days <= 6) return WEEKDAYS[d.getDay()]
      return `${MONTHS[d.getMonth()]} ${d.getDate()}`
    },
    // "20:20" today, "Mon 21:00" within six days, "Oct 15 21:00" further away.
    withTime(ms) {
      const d = new Date(ms)
      const days = Math.abs(dayNumber(ms) - today)
      if (days === 0) return hm(d)
      if (days <= 6) return `${WEEKDAYS[d.getDay()]} ${hm(d)}`
      return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm(d)}`
    },
    daysFromToday: (value) => Math.round(dateMs(value) / DAY - today),
    // "today", "Sat" within six days, "Oct 15" further away or past.
    dayShort(value) {
      const n = Math.round(dateMs(value) / DAY - today)
      if (n === 0) return 'today'
      if (n > 0 && n <= 6) return WEEKDAYS[new Date(dateMs(value)).getUTCDay()]
      return monthDay(value)
    },
    // "Sat Oct 10" from today to six days ahead, "Nov 20" otherwise.
    dayLong(value) {
      const n = Math.round(dateMs(value) / DAY - today)
      if (n >= 0 && n <= 6) return `${WEEKDAYS[new Date(dateMs(value)).getUTCDay()]} ${monthDay(value)}`
      return monthDay(value)
    },
    monthDay
  }
}

// Routers report boundaries like 07:59:59.561 for an 08:00 reset.
const resetTime = (ms) => Math.round(ms / MINUTE) * MINUTE

// ---------------------------------------------------------------------------
// Values: one number per account (min of the 5-hour and weekly windows) and
// per provider (the mean over enabled, paid, ever-read accounts), rounded down.

const floor = (v) => Math.floor(v + 1e-9)
const isLow = (v) => floor(v) <= LOW

function remaining(w, at) {
  if (!w) return 100 // a missing window (a closed Claude 5-hour window, Codex 5h) is full
  if (w.resetAt > 0 && w.resetAt <= at) return 100 // past its reset, the provider has refilled it
  return Math.max(0, Math.min(100, 100 - w.usedPercent))
}

const usableAt = (a, at) => Math.min(remaining(a.windows?.['5h'], at), remaining(a.windows?.week, at))
const fableAt = (a, at) => remaining(a.windows?.fable, at)

function resetsWithinWeek(a, now, ids) {
  return ids.map((id) => a.windows?.[id]?.resetAt ?? 0).filter((r) => r > now && r <= now + WEEK)
}

// The earliest reset at which value() rises above 15%, else fallback (when in the future), else 0.
function backTime(candidates, value, fallback, now) {
  for (const at of [...candidates].sort((x, y) => x - y)) if (!isLow(value(at))) return at
  return fallback > now ? fallback : 0
}

const localPart = (name) => (name.lastIndexOf('@') > 0 ? name.slice(0, name.lastIndexOf('@')) : name)

function buildProvider(state, id, subs, now) {
  const p = state.providers[id]
  const provider = {
    id,
    name: id === 'claude' ? 'Claude' : 'Codex',
    router: id === 'claude' ? 'TeamClaude' : 'codex-multi-auth',
    state: p,
    accounts: []
  }
  const labels = {}
  for (const key of p.roster) {
    const a = p.accounts[key]
    if (a && !a.disabled) labels[localPart(a.name)] = (labels[localPart(a.name)] ?? 0) + 1
  }
  for (const key of p.roster) {
    const a = p.accounts[key]
    if (!a || a.disabled) continue // the router ignores disabled accounts; so does the menu
    const label = labels[localPart(a.name)] > 1 ? a.name : localPart(a.name)
    const acc = { key, a, label, free: a.plan === 'free' }
    acc.counted = !acc.free && !!a.windows && Object.keys(a.windows).length > 0
    if (acc.counted) {
      acc.usable = usableAt(a, now)
      acc.fable = fableAt(a, now)
      acc.hasFable = !!a.windows.fable
      acc.usableBack = backTime(resetsWithinWeek(a, now, ['5h', 'week']), (at) => usableAt(a, at), a.windows.week?.resetAt ?? 0, now)
      acc.fableBack = backTime(resetsWithinWeek(a, now, ['fable']), (at) => fableAt(a, at), a.windows.fable?.resetAt ?? 0, now)
    }
    const manual = subs?.store.accounts[key]?.manual ?? null
    if (manual?.kind === 'ends') acc.ends = manual.date
    else if (manual) acc.legacy = manual
    provider.accounts.push(acc)
  }
  const counted = provider.accounts.filter((acc) => acc.counted)
  provider.counted = counted.length
  if (counted.length) {
    const pool = (value) => (at) => counted.reduce((sum, acc) => sum + value(acc.a, at), 0) / counted.length
    provider.value = pool(usableAt)(now)
    provider.fable = pool(fableAt)(now)
    provider.hasFable = counted.some((acc) => acc.hasFable)
    // The fallback: the earliest weekly reset still ahead.
    const fallback = (id) => Math.min(...counted.map((acc) => acc.a.windows[id]?.resetAt ?? 0).filter((r) => r > now), Infinity)
    const finite = (v) => (Number.isFinite(v) ? v : 0)
    provider.back = backTime(counted.flatMap((acc) => resetsWithinWeek(acc.a, now, ['5h', 'week'])), pool(usableAt), finite(fallback('week')), now)
    provider.fableBack = backTime(counted.flatMap((acc) => resetsWithinWeek(acc.a, now, ['fable'])), pool(fableAt), finite(fallback('fable')), now)
  }
  provider.noPaid = provider.accounts.length > 0 && provider.accounts.every((acc) => acc.free)
  return provider
}

// ---------------------------------------------------------------------------
// The SwiftBar menu

const GAP = '   ' // between a label and its value
const COLORS = { red: '#d70015,#ff6961', normal: '#1d1d1f,#f5f5f7', grey: '#8e8e93,#98989d' }

// An item: { text, color, size, action: [params], submenu: [items] } or { separator: true }.
// Items with neither colour nor action are disabled, so they show grey.
const info = (text) => ({ text })
const header = (text, red = false) => ({ text, color: red ? 'red' : 'normal' })
const separator = () => ({ separator: true })

function menuState(cfg, state, { busy }) {
  const now = cfg.now()
  const running = !!state.running && busy && isAlive(state.running.pid) && now - state.running.startedAt < 10 * MINUTE
  const subs = readSubscriptions(cfg.subscriptionsPath)
  return { cfg, state, now, running, subs, clock: makeFormat(now), note: readNote(cfg) }
}

function render(ctx) {
  const { state, now, clock, subs } = ctx
  const providers = ['claude', 'codex'].map((id) => buildProvider(state, id, subs.exists ? subs : null, now))
  const items = []
  let warning = false
  if (subs.exists && subs.error) {
    warning = true
    items.push(header(`⚠︎ Can't read subscription dates: ${subs.error} · final-week routing is off`), separator())
  }
  providers.forEach((p, index) => {
    if (p.state.error) warning = true
    if (index > 0) items.push(separator())
    items.push(...providerItems(ctx, p))
  })
  items.push(separator(), ...checkItems(ctx, providers))

  // The menu bar: one small icon.
  const values = providers.filter((p) => p.counted > 0)
  const lowest = values.length ? Math.min(...values.map((p) => p.value)) : null
  const red = values.some((p) => isLow(p.value) || (p.id === 'claude' && p.hasFable && isLow(p.fable)))
  let icon = lowest === null ? 'gauge.with.needle' : `gauge.with.dots.needle.${gaugeLevel(lowest)}percent`
  let color = lowest === null ? 'grey' : red ? 'red' : ''
  if (ctx.running) [icon, color] = ['arrow.triangle.2.circlepath', '']
  else if (warning) [icon, color] = ['exclamationmark.triangle', red ? 'red' : '']
  return [menuBarLine(icon, color), '---', ...serialize(items, 0)].join('\n') + '\n'
}

// SwiftBar draws an `sfimage` as a template image, in the menu bar's own
// colour, and ignores `sfcolor` for it. A coloured icon is therefore a symbol
// embedded in the title (`:name:`), which SwiftBar tints with `sfcolor`, at
// about the size of an `sfimage`.
const ICON_SIZE = 16

function menuBarLine(icon, color) {
  if (!color) return `| sfimage=${icon}`
  return `:${icon}: | sfcolor=${COLORS[color]} sfsize=${ICON_SIZE}`
}

// The gauge closest to the lowest provider value.
function gaugeLevel(v) {
  if (v < 16.5) return '0'
  if (v < 41.5) return '33'
  if (v < 58.5) return '50'
  if (v < 83.5) return '67'
  return '100'
}

function providerItems(ctx, p) {
  const { clock } = ctx
  const title = p.name + GAP
  const items = []
  if (p.state.notSetUp && !p.state.error) return [header(`${title}not found`)]
  if (p.state.error) {
    items.push(header(`${title}⚠︎ can't read ${p.router} since ${clock.withTime(p.state.error.at)}`))
    if (p.state.error.value) items.push(info(p.state.error.value))
  } else if (p.accounts.length === 0 && p.state.roster.length > 0) {
    items.push(header(`${title}no enabled accounts`))
  } else if (p.accounts.length === 0) {
    items.push(header(`${title}no accounts`))
  } else if (p.noPaid) {
    items.push(header(`${title}no paid account`))
  } else if (!p.counted) {
    items.push(header(`${title}not read yet`))
  } else {
    let text = `${title}${floor(p.value)}% left`
    let red = isLow(p.value)
    if (red && p.back) text += ` · back ${clock.short(resetTime(p.back))}`
    if (p.id === 'claude' && p.hasFable && isLow(p.fable)) {
      red = true
      text += ` · Fable ${floor(p.fable)}%`
      if (p.fableBack) text += ` · back ${clock.short(resetTime(p.fableBack))}`
    }
    items.push(header(text, red))
  }
  for (const acc of p.accounts) items.push(accountRow(ctx, p, acc))
  return items
}

function accountRow(ctx, p, acc) {
  const { clock, now } = ctx
  let text = `${acc.a.active ? '●' : '○'} ${acc.label}${GAP}`
  let color = 'normal'
  if (acc.free) {
    text += 'free plan'
    color = 'grey'
  } else if (!acc.counted) {
    text += 'not read yet'
  } else {
    text += `${floor(acc.usable)}%`
    if (isLow(acc.usable)) {
      color = 'red'
      if (acc.usableBack) text += ` · back ${clock.short(resetTime(acc.usableBack))}`
    }
    if (acc.hasFable && isLow(acc.fable)) {
      color = 'red'
      text += ` · Fable ${floor(acc.fable)}%`
      if (acc.fableBack) text += ` · back ${clock.short(resetTime(acc.fableBack))}`
    }
  }
  if (acc.ends) {
    const n = clock.daysFromToday(acc.ends)
    if (n < 0) text += ` · ended ${clock.monthDay(acc.ends)}`
    else if (n <= 7) text += ` · ends ${clock.dayShort(acc.ends)}`
  }
  if (acc.counted && acc.a.readAt > 0 && now - acc.a.readAt > DAY) text += ` · ${Math.floor((now - acc.a.readAt) / DAY)}d old`
  return { text, color, submenu: accountSubmenu(ctx, p, acc) }
}

const WINDOW_LABELS = [['week', 'Week'], ['5h', '5h'], ['fable', 'Fable week']]

function accountSubmenu(ctx, p, acc) {
  const { clock, now, state, subs, cfg } = ctx
  const a = acc.a
  const items = [info(a.name)]
  let line = a.active ? 'In use' : 'Idle'
  if (acc.free) line += ' · free plan'
  else if (a.windows && a.readAt > 0) line += ` · updated ${clock.withTime(a.readAt)}`
  else if (!a.windows) line += ' · not read yet'
  items.push(info(line))
  const last = state.lastCheck
  if (a.checkError && last && a.checkError.at >= last.startedAt) items.push(info(`Check ${clock.withTime(a.checkError.at)} failed: ${a.checkError.value}`))
  if (a.availability && last && a.availability.at >= last.startedAt) items.push(info(`Router reported ${a.availability.value} at ${clock.withTime(a.availability.at)}`))
  if (acc.counted) {
    items.push(separator())
    for (const [id, label] of WINDOW_LABELS) {
      const w = a.windows[id]
      if (!w && !(id === '5h' && p.id === 'claude')) continue // a closed Claude 5h reads 100%
      const left = remaining(w, now)
      let text = `${label}${GAP}${floor(left)}%`
      if (floor(left) < 100 && w.resetAt > now) text += ` · resets ${clock.withTime(resetTime(w.resetAt))}`
      items.push(header(text, isLow(left)))
    }
  }
  if (!subs.exists) return items // end dates are only for the managed routers' routing policy
  const dates = []
  if (acc.ends) {
    const n = clock.daysFromToday(acc.ends)
    dates.push(n < 0 ? info(`Ended ${clock.monthDay(acc.ends)}`) : header(`Ends ${clock.dayLong(acc.ends)}`))
  }
  if (acc.legacy) {
    const label = acc.legacy.kind === 'period-end' ? 'Paid period ends' : 'Renews'
    dates.push(info(`${label} ${clock.monthDay(acc.legacy.date)} · not used for routing`))
  }
  if (!subs.writable) dates.push(info(`Can't edit dates: subscriptions.json is ${subs.error}`))
  else dates.push({ text: acc.ends ? 'Change End Date…' : 'Set End Date…', action: [cfg.pluginPath, 'set-end-date', encodeKey(acc.key)] })
  return [...items, separator(), ...dates]
}

function checkItems(ctx, providers) {
  const { state, clock, now, cfg, note } = ctx
  if (ctx.running) {
    let text = 'Checking…'
    if (now - state.running.startedAt >= MINUTE) text += ` since ${clock.withTime(state.running.startedAt)}`
    return [info(text)]
  }
  const parts = []
  const last = state.lastCheck
  if (note && (!last || note.at > last.startedAt)) parts.push(`${clock.withTime(note.at)} ${note.text}`)
  else if (last?.didNotRun) parts.push(`${clock.withTime(last.startedAt)} didn't run: ${last.didNotRun}`)
  else if (last) {
    parts.push(`checked ${clock.withTime(last.startedAt)}`)
    const failed = failedNames(providers, last.failed ?? [])
    if (failed) parts.push(failed)
  }
  // During the cooldown Check Now is grey but still clickable: SwiftBar may
  // show this menu after the cooldown has ended. A click inside it only refreshes.
  const until = state.cooldownUntil ?? 0
  const items = [{ text: 'Check Now', action: [cfg.pluginPath, 'check'] }]
  if (now < until) {
    items[0].color = 'grey'
    parts.push(`next ${clock.withTime(ceilMinute(until))}`)
  }
  if (parts.length) items.push({ text: parts.join(' · '), size: 11 })
  return items
}

// Names up to two failed accounts; a label both providers use gets its provider's name.
function failedNames(providers, keys) {
  if (keys.length === 0) return ''
  if (keys.length > 2) return `${keys.length} accounts failed`
  const names = []
  for (const p of providers) for (const acc of p.accounts) if (keys.includes(acc.key)) names.push([p.name, acc.label])
  if (names.length !== keys.length) return `${keys.length} accounts failed`
  const same = names.length === 2 && names[0][1] === names[1][1]
  return `${names.map(([provider, label]) => (same ? `${provider} ${label}` : label)).join(', ')} failed`
}

const encodeKey = (key) => Buffer.from(key, 'utf8').toString('base64url')
const decodeKey = (token) => Buffer.from(String(token), 'base64url').toString('utf8')

// SwiftBar's format: "title | param=value ...", "--" per submenu level, "---" a separator.
function cleanText(text) {
  return String(text).replace(/[|\r\n]/g, ' ').replace(/^-/, '‐')
}

function quoteParam(value) {
  const text = String(value)
  if (/^[^\s"']+$/.test(text)) return text
  return text.includes('"') ? `'${text}'` : `"${text}"`
}

function serialize(items, depth) {
  const prefix = '--'.repeat(depth)
  const lines = []
  for (const item of items) {
    if (item.separator) {
      lines.push(`${prefix}---`)
      continue
    }
    const params = []
    if (item.color) params.push(`color=${COLORS[item.color]}`)
    if (item.size) params.push(`size=${item.size}`)
    if (item.action) {
      const [script, ...args] = item.action
      params.push(`bash=${quoteParam(script)}`, ...args.map((arg, i) => `param${i + 1}=${quoteParam(arg)}`), 'terminal=false', 'refresh=true')
    }
    lines.push(`${prefix}${cleanText(item.text)}${params.length ? ` | ${params.join(' ')}` : ''}`)
    if (item.submenu) lines.push(...serialize(item.submenu, depth + 1))
  }
  return lines
}

// ---------------------------------------------------------------------------
// The menu run: a cache-only refresh. Under the lock (or, when it is busy,
// from the stored state alone), read TeamClaude's status and codex-multi-auth's
// files, keep each account's newest reading, and print the menu.

async function menu(cfg) {
  const controller = new AbortController()
  let lock = null
  const stop = (name) => {
    controller.abort()
    lock?.release()
    process.exit(name === 'SIGINT' ? 130 : 143)
  }
  for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(name, () => stop(name))
  try {
    lock = tryLock(cfg.lockDir)
  } catch (error) {
    process.stderr.write(`router-limits: ${error.message}\n`)
  }
  let state = readState(cfg)
  if (lock) {
    try {
      const before = JSON.stringify(state)
      const now = cfg.now()
      const [claude, codex] = await Promise.all([
        settle(() => readClaude(cfg, controller.signal)),
        settle(() => readCodex(cfg.codexDir))
      ])
      if (claude.error) readFailed(state.providers.claude, claude.error, now)
      else mergeRead(state.providers.claude, claude.value, now)
      if (codex.error) readFailed(state.providers.codex, codex.error, now)
      else mergeRead(state.providers.codex, codex.value, now)
      if (state.running) delete state.running // a check that ended without clearing it (killed)
      if (JSON.stringify(state) !== before) {
        try { writeState(cfg, state) } catch (error) { process.stderr.write(`router-limits: state.json could not be saved: ${error.message}\n`) }
      }
    } finally {
      lock.release()
    }
  }
  process.stdout.write(render(menuState(cfg, state, { busy: !lock })))
  return 0
}

// ---------------------------------------------------------------------------
// End dates (only with the owner's subscriptions.json)

function dialog(cfg, message, answer) {
  const osascript = cfg.env.ROUTER_LIMITS_OSASCRIPT || '/usr/bin/osascript'
  const script = [
    'on run argv',
    'activate',
    'set reply to display dialog (item 1 of argv) default answer (item 2 of argv) buttons {"Cancel", "Save"} default button "Save" cancel button "Cancel" with title "Router Limits"',
    'return text returned of reply',
    'end run'
  ]
  return runCommand({ file: osascript, args: [...script.flatMap((line) => ['-e', line]), message, answer], env: minimalEnv(cfg.env) }, { timeoutMs: 600e3 })
}

function alert(cfg, message) {
  const osascript = cfg.env.ROUTER_LIMITS_OSASCRIPT || '/usr/bin/osascript'
  const script = ['on run argv', 'activate', 'display alert "Router Limits" message (item 1 of argv)', 'end run']
  return runCommand({ file: osascript, args: [...script.flatMap((line) => ['-e', line]), message], env: minimalEnv(cfg.env) }, { timeoutMs: 600e3 })
}

async function setEndDate(cfg, token, given) {
  const key = decodeKey(token)
  const fail = async (message) => {
    process.stderr.write(`router-limits: ${message}\n`)
    if (given === undefined) await alert(cfg, message)
    return 1
  }
  if (!/^(claude|codex):/.test(key)) return fail('unknown account')
  const subs = readSubscriptions(cfg.subscriptionsPath)
  if (!subs.exists) return fail('subscription end dates are off (no subscriptions.json)')
  if (!subs.writable) return fail(`subscription dates can't be read (${subs.error}); the file was left as it is`)
  const state = readState(cfg)
  const account = state.providers[key.slice(0, key.indexOf(':'))].accounts[key]
  if (!account || !state.providers[key.slice(0, key.indexOf(':'))].roster.includes(key)) return fail('this account is no longer in the router')
  const manual = subs.store.accounts[key]?.manual ?? null
  let date = given
  if (date === undefined) {
    const clock = makeFormat(cfg.now())
    const lines = [`When does ${account.name}'s subscription end?`]
    lines.push(subs.store.routingPolicy.mode === 'final-week'
      ? "Before it ends, the router prefers this account so its remaining weekly quota isn't lost."
      : 'Final-week routing is off, so this date is only shown.')
    if (manual && manual.kind !== 'ends') lines.push(`Replaces the saved ${manual.kind === 'period-end' ? 'paid-period' : 'renewal'} date (${clock.monthDay(manual.date)}).`)
    lines.push('YYYY-MM-DD; leave it empty to remove the date.')
    let answer = manual?.kind === 'ends' ? manual.date : ''
    let problem = ''
    for (;;) {
      const reply = await dialog(cfg, (problem ? `${problem}\n\n` : '') + lines.join('\n'), answer)
      if (!reply.ok) return 0 // Cancel
      answer = reply.stdout.replace(/\n$/, '').trim()
      if (answer === '' || validDate(answer)) break
      problem = `"${answer}" is not a date.`
    }
    date = answer
  }
  if (date === '-' ) date = ''
  if (date !== '' && !validDate(date)) return fail(`"${date}" is not a date (YYYY-MM-DD, 2000 to 2099)`)
  const lock = await acquireLock(cfg.lockDir, cfg.lockWaitMs)
  if (!lock) return fail("couldn't save: another check or save is running")
  try {
    const fresh = readSubscriptions(cfg.subscriptionsPath) // under the lock
    if (!fresh.exists || !fresh.writable) return fail(`couldn't save: subscriptions.json ${fresh.exists ? `is ${fresh.error}` : 'is gone'}`)
    const current = fresh.store.accounts[key]?.manual ?? null
    if (date === '') {
      // Removes only an end date; a legacy renewal record stays.
      if (current?.kind !== 'ends') return 0
      setManual(fresh.store, key, null)
    } else {
      setManual(fresh.store, key, date, cfg.now())
    }
    writeAtomic(cfg.subscriptionsPath, serializeSubscriptions(fresh.store))
    return 0
  } catch (error) {
    return fail(`couldn't save: ${error.message}`)
  } finally {
    lock.release()
  }
}

// ---------------------------------------------------------------------------

async function main(argv) {
  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) {
    process.stdout.write(`| sfimage=exclamationmark.triangle\n---\nRouter Limits needs Node.js 20 or newer (found ${process.version})\n`)
    return 0
  }
  const cfg = config()
  const [command, ...args] = argv
  switch (command) {
    case undefined:
      return menu(cfg)
    case 'check':
      return check(cfg)
    case 'set-end-date':
      if (args.length < 1 || args.length > 2) break
      return setEndDate(cfg, args[0], args[1])
  }
  process.stderr.write('usage: router-limits.5m.js [check | set-end-date <account> [YYYY-MM-DD | -]]\n')
  return 64
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (error) => {
    process.stderr.write(`router-limits: ${error?.stack ?? error}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  config, parseClaudeStatus, probeRunComplete, runClaudeProbe, memoryMarker, fileMarker, readCodex, parseForecast,
  codexKey, normalizeSubscriptions, serializeSubscriptions, readSubscriptions, setManual, validDate, tryLock,
  acquireLock, encodeKey, decodeKey, makeFormat, applyCheck, refreshURL, teamClaudeCommand, forecastCommand, searchDirs,
  PROBE_HOLD_SECONDS
}
