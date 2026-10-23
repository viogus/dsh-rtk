# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This repository is a **fork** of
[`DeepTrial/dsh-bash-rtk`](https://github.com/DeepTrial/dsh-bash-rtk) renamed to
`dsh-rtk`; the upstream 0.1.x history is preserved beneath the 0.2.0 entry.

## [Unreleased]

### Docs

- Add `docs/token-saving-plugins.zh.md`: a measured comparison of dsh-rtk,
  `dsh-token-saver` and `dsh-ops` on the same tasks, with method, numbers,
  failure modes and reproduction steps. Ship `docs/` in the npm package so the
  README link resolves there too.

## [0.2.4] — 2026-10-18

### Docs

- Both READMEs now open with the sandbox caveat instead of burying it: compression
  works in every mode, but a `workspace-write` session silently loses rtk's ledger,
  the recall database and the `tee/` backups because those writes land outside the
  writable roots. The notice names both remedies — the helper script, or a
  `danger-full-access` session — and links the detailed section.

### Docs

- Document the `workspace-write` limitation (rtk cannot write its state
  directory, so the ledger/recall/tee writes fail silently) and ship
  `scripts/allow-rtk-state-in-sandbox.mjs` to grant that one directory inside the
  Seatbelt profile, with `status` / `apply` / `revert` and a real write test.

## [0.2.3] — 2026-10-17

### Changed

- **Version alignment with `dsh`.** The plugin's major.minor now explicitly tracks
  `dsh`'s major.minor line, and the target is declared instead of implied:
  `engines.dsh` tightens to `>=0.2.1-rc.1 <0.3.0-0` and `dsh.plugin.json` gains
  `"dshTarget": "0.2.1-rc.1"`. The range is duplicated in `package.json` because
  that is the manifest `dsh-app-boot` reads when deciding whether to mount a bundle;
  until now the gate lived only in `dsh.plugin.json`, which the loader never reads.
  Both READMEs gain a plugin-version ↔ dsh-version table.

### Breaking

- `0.1.x` and `0.2.0-rc.2` are no longer admitted by the engine gate: the bundle is
  skipped rather than mounted on a core this release was not verified against.
  Pin `0.2.2` if you cannot move to `0.2.1-rc.1`.

## [0.2.2] — 2026-10-17

### Docs

- Describe the segment-aware filter (every segment is inspected, not just the
  leading word) in both READMEs, and note that `dsh-rtk` and the upstream
  `dsh-bash-rtk` must not be installed side by side: both register the same
  `ctx.shell` service, so load order decides which one wins.

## [0.2.1] — 2026-10-17

### Fixed

- **The cost filter only looked at a command's first word**, so `cd repo && cargo
  test`, `echo done && git status` and every other compound command that opens
  with a builtin was handed to the shell unwrapped. That is the shape an agent
  writes most often, and rtk rewrites it fine (`cd repo && rtk cargo test`) — the
  plugin was silently declining the whole command. `isRoutableCandidate` now
  splits on top-level control operators (`&&`, `||`, `;`, `|`, `|&`, `&`, newline)
  and accepts the command when *any* segment opens with a plausible executable.
  Redirects are not split points, so `echo hi 2>&1` is still a passthrough rather
  than a fabricated segment starting with `1`.
- A command whose every segment is a builtin (`cd a; echo b`, `for …; do …; done`)
  is still declined, so the cheap path stays cheap.

### Changed

- README (en/zh): the compatibility note no longer claims that a single peer
  range silently excludes prereleases. `dsh-app-boot` evaluates `engines.dsh`
  and dsh peer ranges with `includePrerelease: true`, so the shipped range
  matches `0.1.x` and `0.2.x` prereleases alike (verified against `0.2.0-rc.2`
  and `0.2.1-rc.1`); the `<0.3.0-0` bound is still the plain-node-semver-safe
  spelling.


## [0.2.0] — 2026-10-15

The delegation release: command coverage is no longer a list this plugin
maintains, it is whatever the installed `rtk` says it is.

### Added

- **`rtk rewrite` delegation** (`src/rtk.ts`). `resolve()` now spawns
  `rtk rewrite <command>` and adopts whatever the binary prints on stdout,
  instead of consulting a static executable→subcommand table. New rtk rules and
  new rtk command families therefore take effect by upgrading rtk alone, with no
  plugin release (`ls`, `tree`, `read`, `diff`, `wc`, `oc`, `bun`, `ast-grep`,
  `lint`, `prettier`, `format`, `ctest`, … all route). Rewrites are also
  non-prefix where rtk says so — `head -20 foo.txt` becomes
  `rtk read foo.txt --head-lines 20`.
- **Rewrite cache** (`REWRITE_CACHE_MAX_ENTRIES = 1024`, FIFO eviction) so
  repeated commands skip the ~11 ms subprocess.
- **Cost filter** `isRoutableCandidate()` (`src/wrap.ts`): shell keywords and
  everyday builtins (`cd`, `echo`, `pwd`, `export`, …) are skipped before
  spawning. It is an optimization, not a policy — anything not provably
  unroutable is handed to rtk.
- **New config field `rtkRewrite`** (boolean, default `true`): keep the executor
  registered but skip the rewrite entirely.
- **Tunables**: `RTK_BIN` overrides the binary path, `RTK_TIMEOUT_MS` the
  per-rewrite timeout (default 2000 ms; a timeout means "no rewrite").
- **Test suites**: `tests/rtk.spec.ts` (unit, driven by a stand-in binary via
  `RTK_BIN`), `tests/integration.rtk.spec.ts` (feature parity against a real
  rtk binary via `RTK_INTEGRATION_BIN`), and `scripts/resolve-rtk.mjs` so
  `pnpm run test:integration` accepts a plain `rtk` on PATH.
- **CI `real-rtk` job**: downloads the pinned rtk release binary and runs the
  integration suite against it, so the delegation claim is verified on every
  push rather than asserted in prose.
- **`release.yml`**: tagging `v*` builds, packs and attaches
  `dsh-rtk-latest.tgz` to the GitHub release, which is what the README's
  tarball install URL points at.

### Changed

- **Package renamed** `@deeptrial/dsh-bash-rtk` → `@viogus/dsh-rtk`
  (repo `DeepTrial/dsh-bash-rtk` → `viogus/dsh-rtk`).
- **Executors no longer share a base class.** `RtkBashExecutor extends
  LocalBashExecutor` and `RtkSandboxBashExecutor extends SandboxBashExecutor`,
  each carrying its own rewrite state. An intermediate refactor had both extend
  one common class; that silently dropped `SandboxBashExecutor`'s
  `sandboxPolicy` stamping, so the command ran **unconfined** and
  `ctx.sandbox.confine` was never called. The small duplication is deliberate:
  the base class decides confinement.
- **rtk is probed with `rtk --version`** and the module must be imported as
  `@deepseek-ai/cordis`, never bare `cordis` — the host packages augment the
  scoped name.
- **Peer ranges widened** to `>=0.0.1-rc.1 <0.3.0-0` for
  `@deepseek-ai/dsh-bash-local`, `@deepseek-ai/dsh-bash-sandbox` and
  `@deepseek-ai/dsh-shell`, plus `@deepseek-ai/cordis ~4.0.4`; all optional.
  `dsh.plugin.json` engines is now `>=0.1.0-rc.6 <0.3.0-0`. The old three-way
  prerelease OR chain excluded the installed 0.2.0-rc.2 host.
- CI bumped to `actions/checkout@v5`, `pnpm/action-setup@v5`,
  `actions/setup-node@v5`.
- Exit codes from `rtk rewrite` are ignored on purpose: they encode rtk's
  Claude Code permission protocol, which has no counterpart in `dsh`. Only
  stdout is read, and empty stdout is the single "no rewrite" signal.

### Fixed

- Cache eviction ran *after* insertion, so the map could reach 1029 entries
  against a 1024 bound; it now evicts first.
- A stale comment claimed exit code 2 never prints to stdout. Upstream source
  (`src/hooks/rewrite_cmd.rs`) and `rtk rewrite --help` both allow a
  pipeline-rule message on 2; the implementation already handled it, the
  comment did not.

### Removed

- The hand-maintained `RTK_COMMAND_MAP` (41 entries) and the metacharacter
  bail-out that made every compound command pass through unwrapped. The legacy
  pure `wrapWithRtk()` is still exported for existing consumers, now declining
  `sudo` and leading `NAME=value` assignments explicitly.

## [0.1.1] and earlier

Upstream `DeepTrial/dsh-bash-rtk` history: static 41-executable whitelist in
`src/wrap.ts`, no `rtk rewrite` delegation, no integration suite.

[Unreleased]: https://github.com/viogus/dsh-rtk/compare/v0.2.4...HEAD
[0.2.4]: https://github.com/viogus/dsh-rtk/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/viogus/dsh-rtk/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/viogus/dsh-rtk/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/viogus/dsh-rtk/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/viogus/dsh-rtk/compare/v0.1.1...v0.2.0
