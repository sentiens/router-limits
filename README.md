# Router Limits

A [SwiftBar](https://github.com/swiftbar/SwiftBar) plugin that shows how much
Claude and Codex quota is left in your [TeamClaude](https://www.npmjs.com/package/@karpeleslab/teamclaude)
and [`codex-multi-auth`](https://www.npmjs.com/package/codex-multi-auth) account
pools, and when it comes back. One file: `router-limits.5m.js`.

## What it shows

- **Menu bar**: one small gauge icon for the lowest provider (0, 33, 50, 67 or
  100%). It turns red when a pool is at or below 15%. A grey gauge without dots
  means nothing has been read yet. Circular arrows mean a check is running; a
  warning triangle means a router or `subscriptions.json` can't be read (the
  last good values stay), red when a pool is also low.
- **Menu**: `Claude   75% left`, then one row per enabled account (● in use,
  ○ idle) with one number: the smaller of its 5-hour and weekly windows. A row
  adds a suffix only when it is true: low quota and when it comes back, an end
  date within a week, a free plan, or a reading more than a day old. Fable shows
  only when it is at or below 15%. Disabled accounts are hidden.
- **Account submenu**: the address, in use or idle and when it was last
  updated, each window with its reset time, and the subscription end date.
- **Check Now**, with the last check under it (`checked 13:34`,
  `checked 18:26 · next 18:36`, or what failed).

The provider number is the mean over enabled paid accounts, rounded down. A
window past its reset counts as 100%. Values are the last ones known: they never
disappear because of their age, and a failed check never makes the menu worse.

## Install

```sh
brew install --cask swiftbar          # then choose a plugin folder when it asks
ln -s "$PWD/router-limits.5m.js" ~/path/to/your/SwiftBar/plugins/
```

Copying the file works too. The `5m` in the name is the refresh interval.

## Requirements

- macOS with SwiftBar 2, and Node.js 20 or newer. The plugin is started by
  zsh, which finds `node` on `PATH`, in `/opt/homebrew/bin`, `/usr/local/bin`,
  Volta, mise, asdf, nvm (the newest installed version) or fnm (its default
  alias). SwiftBar's login shell doesn't read `.zshrc`, so these are looked up
  directly.
- TeamClaude (`teamclaude` or `teamrouter`) with its daemon running, and/or
  `codex-multi-auth` with its accounts in `$CODEX_MULTI_AUTH_DIR`,
  `$CODEX_HOME/multi-auth` or `~/.codex/multi-auth`. They are found on `PATH`,
  in `/opt/homebrew/bin`, `/usr/local/bin`, npm's global bin, nvm, fnm and
  `~/.volta/bin`. A router that isn't there shows `not found`. The routers get
  a small environment: `HOME`, the user, `PATH`, plus `XDG_CONFIG_HOME`,
  `CODEX_HOME`, `CODEX_MULTI_AUTH_DIR`, the proxy variables and
  `NODE_EXTRA_CA_CERTS` when they are set.
- Check Now on Codex uses `codex-multi-auth forecast --live --json`. The
  forecast updates the router's quota cache, which the plugin reads the windows
  from (or from the forecast itself when it reports them).

With `~/.bin/lib/agent-router-env.zsh` (a managed router setup that provides
the router runtime) the plugin runs both routers through it instead, with the
managed Node runtime, a minimal environment and `router_direct_network`.

## Check Now

Nothing asks the accounts by itself: SwiftBar's 5-minute run only reads the
routers' caches. Only **Check Now** (or `router-limits.5m.js check`) does, at
most once every 10 minutes:

- **Claude**: one zero-spend usage request per account, made by the TeamClaude
  daemon. The check switches the daemon's probe on (`teamclaude probe 3600`) for
  one run and always off again: `probe off` is retried once and also sent on
  SIGTERM, SIGINT and SIGHUP; router commands run in their own process group, so
  a Ctrl-C never kills an in-flight `probe off`. A probe left on at 3600 seconds
  is switched off by the next check. A periodic probe at any other interval is
  yours and is never touched, so never configure one of exactly 3600 seconds.
- **Codex**: one tiny diagnostic request per enabled account
  (`forecast --live --json --model gpt-6-astra`; set
  `ROUTER_LIMITS_CODEX_PROBE_MODEL` for another model). Codex has one limit
  shared across models, so the model is never shown.

Checks, date edits and cache reads share one lock, whether they run from
SwiftBar or a terminal and whatever the file is called (a directory with the
owner's pid and its start time; a lock whose processes are gone is taken over,
however old it is otherwise). Cache reads never wait for it; checks and date
edits wait up to 200 seconds. The 10-minute cooldown is shared the same way.

## Subscription end dates (optional)

Only when `~/Library/Application Support/Router Limits/subscriptions.json`
exists, the routing policy the managed routers read: in the final week before an account's end date
they prefer it, so its weekly quota isn't lost. The plugin then shows `ends Sat`
on a row (within 7 days), the date in the submenu, and **Set End Date…**, which
asks for a `YYYY-MM-DD` date (empty removes it). It writes only manual `ends`
records, in the same format (0600, atomic rename), keeping the routing policy
and every other record. Older renewal records show grey, unused. Without the
file none of this appears.

## Files

In `~/Library/Application Support/Router Limits/swiftbar/`, the same for
SwiftBar and a terminal: `state.json` (the last reading of every account, the
last check, the cooldown), `lock/`, `.probe-owned` (exists while the probe may
be on) and `check-note.json`. SwiftBar's per-plugin data directory is not used.

## Development

```sh
node --test test/*.test.mjs                 # fake routers, fixed time and zone
UPDATE_GOLDEN=1 node --test test/menu.test.mjs   # rewrite test/golden/
ROUTER_LIMITS_DIR="$PWD/.scratch-data" ./router-limits.5m.js   # a copy of your data
```

`ROUTER_LIMITS_DIR` moves the data directory (`subscriptions.json`, and
`swiftbar/` inside it); `ROUTER_LIMITS_STATE_DIR` moves only the state.
`.scratch-data/` is gitignored. Tests also use `ROUTER_LIMITS_NOW`,
`ROUTER_LIMITS_BIN_PATH`, `ROUTER_LIMITS_LOCK_WAIT_MS` and
`ROUTER_LIMITS_OSASCRIPT`. `ROUTER_LIMITS_READER=/path/to/reader.mjs` runs the
compatibility test against the managed routers' subscriptions reader.

## License

MIT
