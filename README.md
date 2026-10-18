# dsh-rtk

[![CI](https://github.com/viogus/dsh-rtk/actions/workflows/ci.yml/badge.svg)](https://github.com/viogus/dsh-rtk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@viogus/dsh-rtk)](https://www.npmjs.com/package/@viogus/dsh-rtk)
[![GitHub Release](https://img.shields.io/github/v/release/viogus/dsh-rtk)](https://github.com/viogus/dsh-rtk/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/viogus/dsh-rtk/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-339933?logo=nodedotjs)](https://nodejs.org/)

> Route eligible shell commands through [rtk](https://github.com/rtk-ai/rtk) (Rust Token Killer) inside the DeepSeek Harness (`dsh`) bash executor — compress tool output, save tokens, change nothing else.

[中文版](README.zh.md)

> **Heads-up: a `workspace-write` session keeps the compression but loses the ledger and the backups.**
> The rewrite works in every mode. Confinement is what bites: dsh allows writes only
> inside the workspace, `/tmp` and the platform temp dir, while rtk keeps
> `history.db`, `recall.db` and `tee/` in `~/Library/Application Support/rtk` — outside
> those roots. rtk's writes are refused **silently**, so `rtk gain` stays empty and no
> tee backup is kept. Two ways out: run
> [`scripts/allow-rtk-state-in-sandbox.mjs`](scripts/allow-rtk-state-in-sandbox.mjs)
> (`apply`, then restart the harness) to grant that one directory, or run the session
> with `danger-full-access`. Full detail:
> [Sandboxed sessions](#sandboxed-sessions-workspace-write).

---

## Table of Contents

- [Quick Example](#quick-example)
- [Requirements](#requirements)
- [Why](#why)
- [How it works](#how-it-works)
- [Install & enable](#install--enable)
- [Migrating from `@deeptrial/dsh-bash-rtk`](#migrating-from-deeptrialdsh-bash-rtk)
- [API / Configuration](#api--configuration)
  - [Sandboxed sessions](#sandboxed-sessions-workspace-write)
- [Which commands are routed](#which-commands-are-routed)
- [Development](#development)
- [Changelog](#changelog)
- [License](#license)

---

## Quick Example

The plugin rewrites commands at the `resolve()` boundary — before anything runs:

| Input (`command`) | Resolved output | Reason |
|---|---|---|
| `git status` | `rtk git status` | rtk has a rule |
| `ls -la` | `rtk ls -la` | rtk routes `ls` too — no plugin list involved |
| `tree` | `rtk tree` | new in rtk 1.0 — works with **no plugin release** |
| `head -5 notes.txt` | `rtk read notes.txt --head-lines 5` | rtk's own non-prefix rewrite, adopted verbatim |
| `git status \| grep x` | `rtk git status \| grep x` | rtk rewrites the segments it knows, leaves the rest |
| `cd /tmp` | `cd /tmp` | rtk declines — **identity** |
| `git status` (rtk absent) | `git status` | binary missing — **identity fallback** |

Everything else — workdir, timeout, env, exit code, sandbox confinement — is inherited unchanged.

## Requirements

- **Node.js:** >= 20.0.0
- **rtk:** `rtk --version` must exit 0 on PATH (install separately, e.g. `cargo install rtk`)
- **Minimum rtk for the delegation design:** `0.25.0`, where `rtk rewrite` was introduced; everything in this README is verified against **`rtk 1.0.1`**, and CI re-runs that check on every push. There is no upper bound — see [Versioning note](#versioning-note).

## Why

LLM agents burn tokens on verbose tool output (`git log`, `cargo build`, `pytest` trails…). `rtk` already knows how to shrink those for 30–90%. This plugin bolts that filtering onto `dsh`'s bash executor so every eligible command is auto-routed through `rtk` — **with zero semantic change** to what actually runs.

## How it works

```
model → dsh bash tool → RtkBashExecutor.resolve()
                              │
                              ▼
                      rtk rewrite <command>
                              │
              ┌───────────────┴────────────────┐
        prints a rewrite                  prints nothing
              │                                │
      run that command verbatim        run the original verbatim
```

Two guards decide (see [`src/wrap.ts`](src/wrap.ts) and [`src/rtk.ts`](src/rtk.ts)):

1. **The mapping is rtk's, not ours.** `resolve()` spawns `rtk rewrite <command>` and adopts whatever it prints on stdout. The plugin keeps no table of commands: when rtk ships a new rule, upgrading rtk upgrades the plugin's coverage, and the plugin does not need a release. The exit code is ignored on purpose — rtk uses it for its own Claude Code permission protocol, which has no counterpart here.
2. **A cheap cost filter, not a policy.** The command is split on top-level control operators (`&&`, `||`, `;`, `|`, `|&`, `&`, newline) and each segment's first word is checked: shell keywords and everyday builtins (`cd`, `echo`, `export`, …) do not make a segment routable on their own. A command is skipped only when **every** segment is such a builtin — `cd repo && cargo test` is handed to rtk, and comes back as `cd repo && rtk cargo test`. Anything not provably unroutable is handed to rtk to decide. If the `rtk` binary is absent the whole transform is the **identity**, so the deployment behaves exactly like the stock executor.

Commands are *lexed* by rtk, not matched as whole strings: it rewrites the segments it recognizes and preserves pipes, `&&`/`;`, redirections and substitutions byte-for-byte. Compound commands are therefore routed, not skipped.

### Versioning note

The plugin **does not bundle or pin rtk**. At executor construction it probes `rtk --version` on `PATH` (see `probeRtkAvailable` in [`src/rtk.ts`](src/rtk.ts)) and then asks that same binary to do the rewriting. Therefore:

- When **rtk ships a new release**, any user who upgrades `rtk` on their machine automatically gets the new rules *and the new commands* — no plugin update required.
- The plugin version (this repo) and the rtk version are **independent**; keep them separate. This README states the *minimum* rtk version tested against, not a lockstep number.
- `RTK_BIN` overrides the binary path and `RTK_TIMEOUT_MS` the per-rewrite timeout (default 2000 ms); a rewrite that times out is treated as "no rewrite".

> **Requires:** `rtk` on `PATH` (`rtk --version` exits 0). The plugin does **not** install or manage rtk — **you must install and update rtk yourself** (e.g. `cargo install rtk` or download a release binary). When rtk is absent the plugin is a silent no-op passthrough.

### Compatibility & version alignment

This plugin depends on `@deepseek-ai/dsh-*` packages that DeepSeek Harness publishes to npm **independently** from the `dsh` aggregate package. Those sub-packages (and `dsh` itself) ship as **prereleases** (`x.y.z-rc.n`). Under plain node-semver a prerelease only satisfies a range when some comparator shares its exact `major.minor.patch` tuple *and* carries a prerelease tag — which is why the upper bound is written `<0.3.0-0` rather than `<0.3.0`. The runtime loader is more permissive than that: `dsh-app-boot` evaluates `engines.dsh` and the plugin's dsh peer ranges with `includePrerelease: true`, so these peer ranges match every `0.1.x`/`0.2.x` prerelease. Peer ranges are advisory, though: the `engines.dsh` gate documented below is what actually decides whether the bundle loads.

The actual ranges (see `peerDependencies` in `package.json`) are:

```
"@deepseek-ai/cordis":           "~4.0.4"
"@deepseek-ai/dsh-bash-local":   ">=0.0.1-rc.1 <0.3.0-0"
"@deepseek-ai/dsh-bash-sandbox": ">=0.0.1-rc.1 <0.3.0-0"
"@deepseek-ai/dsh-shell":        ">=0.0.1-rc.1 <0.3.0-0"
```

All four peers are marked `optional` in `peerDependenciesMeta`, so the plugin still installs and loads where they are absent (it then behaves as a passthrough). Note the cordis entry: `dsh` injects the container at runtime, but it injects the **scoped** `@deepseek-ai/cordis`, which is the package this plugin imports for its `Context`/`Service` types. The unscoped npm name `cordis` is a *different, older* line (`4.0.0-rc.11`) and must not be used here.

Both `package.json` and `dsh.plugin.json` declare the same target:

```json
"engines": { "dsh": ">=0.2.1-rc.1 <0.3.0-0" }
```

`dsh.plugin.json` also carries `"dshTarget": "0.2.1-rc.1"` — the exact runtime this
release was verified against. `package.json` carries the range as well because
that is the manifest `dsh-app-boot` reads when it decides whether to load a bundle;
`dsh.plugin.json` is what the plugin tooling displays.

### Which plugin version goes with which dsh

The plugin's **major.minor follows `dsh`'s major.minor line**; the patch number is
ours and moves for plugin-only fixes. New `dsh` line → new plugin minor, even if the
plugin code did not change, so the pair is always obvious:

| Plugin | dsh target range | Verified against |
| --- | --- | --- |
| `0.2.3` | `>=0.2.1-rc.1 <0.3.0-0` | `0.2.1-rc.1` |
| `0.2.0` – `0.2.2` | `>=0.1.0-rc.6 <0.3.0-0` | `0.2.0-rc.2` |

`0.2.3` deliberately **stops** admitting `0.1.x` and `0.2.0-rc.2`: the loader now
refuses to mount the bundle on an older core instead of mounting something untested.
Pin the plugin if you are still on `0.2.0-rc.2` (use `0.2.2`).

> **Known version skew:** `dsh` (the aggregate, what `npx @deepseek-ai/dsh` installs) and its `@deepseek-ai/dsh-*` sub-packages are on **separate semver tracks**. The ranges above pin to the *published* sub-package versions so a plain `dsh plugin add` resolves cleanly. Watch the [releases](https://github.com/viogus/dsh-rtk/releases) for a matching update.

## Install & enable

The plugin is **disabled by default** — installing it does nothing until you opt in.

```sh
# 1) from the npm registry (published as @viogus/dsh-rtk)
dsh plugin --profile web add "@viogus/dsh-rtk"

# 2) from a local checkout
dsh plugin --profile web add "<path-to-this-dir>"

# 3) or directly from the latest GitHub release tarball (no local clone needed)
dsh plugin --profile web add \
  "https://github.com/viogus/dsh-rtk/releases/latest/download/dsh-rtk-latest.tgz"

# enable it via an optional overlay — add to your profile's cordis.patch.yml:
#   - id: bash-sandbox
#     disabled: true
#   - id: bash-rtk
#     disabled: false

dsh web   # restart to apply
```

The bundled overlay snippet lives in [`cordis.patch.yml`](cordis.patch.yml). It swaps the stock sandbox executor for `RtkSandboxBashExecutor` (file confinement preserved) and leaves the unconfined `RtkBashExecutor` available for `danger-full-access` setups.

## Migrating from `@deeptrial/dsh-bash-rtk`

This repository is the **fork of [`DeepTrial/dsh-bash-rtk`](https://github.com/DeepTrial/dsh-bash-rtk) renamed to `dsh-rtk`**, rebuilt so that command coverage is delegated to `rtk` instead of a hand-maintained table. The old package is a different npm package (`@deeptrial/dsh-bash-rtk`, 0.1.x) and is **not** auto-updated by this one — switching is a manual, one-command change:

> **Do not install this package and the upstream `dsh-bash-rtk` side by side.** Both
> register the same `ctx.shell` service, so the second one to load cannot take over
> and the winner depends on load order. Remove the old package first — the commands
> below do exactly that.


```sh
dsh plugin --profile web remove dsh-bash-rtk     # or the plugin id you registered
dsh plugin --profile web add "@viogus/dsh-rtk"
dsh web
```

What changes for you:

- **Coverage stops drifting.** 0.1.x routed exactly 41 executables and had to be re-released when rtk learned a new one (there is a commit in the old history that adds `lit`/`make`, then removes them again while waiting for rtk). 0.2.0 asks `rtk rewrite`, so `ls`, `tree`, `head`, `oc`, `bun`, `ast-grep`, … work the day you upgrade rtk.
- **The config field `rtkAvailable` keeps its meaning** (force the router on/off); one field was added, [`rtkRewrite`](#api--configuration).
- **No other API change.** Both executors still extend the stock `LocalBashExecutor` / `SandboxBashExecutor`, so workdir, timeouts, output spills and sandbox confinement are untouched.
- **The overlay id changed** from `bash-rtk` under the old package to the same `bash-rtk` id registered by this package — if you copied the `name:` line into your profile patch, update it to `@viogus/dsh-rtk`.

## API / Configuration

Both executors accept the same base config as their stock counterparts (`LocalBashExecutor` / `SandboxBashExecutor`) plus two optional fields:

| Option | Type | Default | Description |
|---|---|---|---|
| `rtkAvailable` | `boolean` | `probeRtkAvailable()` result | Force-enable or force-disable rtk routing. Useful for tests or deployments where the binary path is non-standard. |
| `rtkRewrite` | `boolean` | `true` | Keep the executor registered but skip the `rtk rewrite` call, so `resolve()` is a plain passthrough. |

All other options — `cwd`, `timeoutMs`, `graceMs`, etc. — are inherited unchanged from the upstream executors.

`RtkSandboxBashExecutor` extends the stock `SandboxBashExecutor`, so confinement, its injection list and its result decoration are inherited rather than reimplemented; the rewrite happens in `resolve()` before `execute()` reads `spec.command`, which means the argv handed to `ctx.sandbox.confine` is already the rtk-routed one.

## Which commands are routed

Whatever the installed rtk routes. Run `rtk rewrite "<command>"` to ask it directly, or see the [rtk command reference](https://github.com/rtk-ai/rtk#supported-ecosystems) for the maintained list — the plugin does not mirror it. As a sample of the ground a hand-maintained list used to miss, rtk 1.0.1 already routes `ls`, `tree`, `head`, `read`, `diff`, `wc`, `grep`, `rg`, `ast-grep`, `oc`, `bun`, `bunx`, `lint`, `prettier`, `format` and `ctest` alongside the older dev-tool set.

Compound commands are routed too, because rtk rewrites segment by segment — and the filter now looks at every segment, not just the leading word, so `cd repo && cargo test` is not mistaken for a bare `cd`. The plugin skips a command only when all of its segments are words it can prove rtk never rewrites (shell keywords and everyday builtins), which saves a subprocess without losing coverage.

## Sandboxed sessions (`workspace-write`)

Under `workspace-write`, dsh confines every shell command with Seatbelt: writes
are denied except the workspace, `/tmp` and the platform temp dir. rtk keeps its
state in `~/Library/Application Support/rtk` — outside those roots — so its
writes are refused **silently**. Compression still works, but the savings
ledger, the recall database and the `tee/` backups do not.

Two ways to fix it:

```sh
# A) keep confinement, widen the grant for rtk's state dir only
node scripts/allow-rtk-state-in-sandbox.mjs apply    # then restart the harness
node scripts/allow-rtk-state-in-sandbox.mjs status    # after an app update
node scripts/allow-rtk-state-in-sandbox.mjs revert    # undo

# B) run the session with danger-full-access (no confinement, no patch)
```

The script patches one function in `@deepseek-ai/dsh-sandbox-local` (the
Seatbelt profile builder), backs the file up next to itself, refuses to touch a
shape it does not recognise, and finishes with a real `sandbox-exec` write test
that must see a new row in `history.db`. It does **not** touch the in-process
filesystem fence: `read` / `write` / `edit` stay confined to the workspace, only
a shell command's write to rtk's own state directory is allowed.

App updates can reinstall that package and drop the patch; `status` reports it
and `apply` puts it back. Nothing here is required for compression to work.

## Development

```sh
# 1. clone the plugin and its sibling harness
git clone https://github.com/viogus/dsh-rtk.git
git clone https://github.com/deepseek-ai/deepseek-harness.git

# 2. install harness deps and build the libraries the plugin links against
cd deepseek-harness && pnpm install && pnpm build:lib:host

# 3. install plugin deps and run checks
cd ../dsh-rtk && pnpm install --ignore-scripts
pnpm run check        # typecheck + test + build
pnpm run test         # tests only
pnpm run typecheck    # tsc only
```

`devDependencies` use `link:` into the local `deepseek-harness` checkout; tests run inside that workspace (the `@deepseek-ai/dsh-*` packages must resolve). If you only need to work on the rewriting logic, the tests are self-sufficient once dependencies are installed — no harness build is needed to run `pnpm run test` after the first `pnpm install`.

The unit tests use a stand-in `rtk` binary injected through `RTK_BIN`, so they need no real rtk. To additionally prove parity against the rtk you actually have installed:

```sh
pnpm run test:integration    # needs a real rtk on PATH (or RTK_INTEGRATION_BIN)
```

That suite is skipped when no binary is supplied, so a plain `pnpm run test` stays green without rtk; `scripts/resolve-rtk.mjs` resolves the `PATH` name to an absolute path so the skip guard cannot silently mask a missing binary. CI runs both jobs on every push — a stubbed one for the contract and a `real-rtk` one that downloads the pinned rtk release.

## Changelog

Release notes live in [`CHANGELOG.md`](CHANGELOG.md) (Keep a Changelog format). The 0.2.0 entry documents the delegation rewrite, the fork/rename, the confinement regression that motivated the two-base-class design, and every manifest range that had to be widened.

## License

MIT
