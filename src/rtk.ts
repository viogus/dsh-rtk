/**
 * rtk (Rust Token Killer) command bridge. This module owns every interaction
 * with the external `rtk` binary: probing for it, delegating the rewrite
 * decision to `rtk rewrite`, and caching the answer.
 *
 * ## Why the decision is delegated
 *
 * rtk is the single source of truth for which commands it optimizes and how.
 * Upstream, routability is a `RegexSet` compiled from every rule's `pattern`
 * field (`src/discover/rules.rs`), roughly a hundred rules that each match a
 * family of invocations rather than a bare executable name. rtk also rewrites
 * far more than a prefix swap:
 *
 * ```
 * git status | grep modified   →  git status | rtk grep modified
 * npm install && npm run build →  npm install && rtk npm run build
 * cargo test 2>&1 | tail -20   →  rtk cargo test 2>&1 | tail -20
 * FOO=bar git status           →  FOO=bar rtk git status
 * nohup git status             →  nohup rtk git status
 * uv run pytest                →  uv run rtk pytest
 * head -20 foo.txt             →  rtk read foo.txt --head-lines 20
 * npx tsc --noEmit             →  rtk tsc --noEmit
 * ```
 *
 * Reproducing that in TypeScript would be both incomplete and permanently
 * stale — the rule set has grown every release since `rtk rewrite` landed in
 * rtk 0.25.0. Shelling out to `rtk rewrite` inherits each improvement the
 * moment the user upgrades rtk, which is the property the plugin advertises.
 *
 * ## Cost
 *
 * One `spawnSync` per not-yet-seen command, measured at ~11 ms on macOS arm64
 * for rtk 1.0.1. Results are memoized per executor instance by exact command
 * text, so a command that repeats costs nothing after the first call.
 *
 * ## What `rtk rewrite` touches besides stdout
 *
 * The decision is effectively read-only, with two caveats worth stating plainly:
 *
 * - It always reads the four Claude Code settings files (`~/.claude/settings.json`
 *   and friends, plus their project-local equivalents) to resolve permission
 *   rules. Missing files are skipped silently and no file is ever created.
 * - It may record a "tee recall" row when the command reads an `.log` under
 *   rtk's tee directory. Commands that do not reference such a file write
 *   nothing.
 *
 * @module @viogus/dsh-rtk/rtk
 */

import { spawnSync } from 'node:child_process'

/**
 * Wall-clock ceiling for one `rtk rewrite` call. rtk answers in ~11 ms; the
 * budget exists so a wedged binary can never hold up `resolve()`, and it is
 * deliberately far below any command timeout.
 */
export const DEFAULT_RTK_TIMEOUT_MS = 2000

/**
 * Upper bound on memoized rewrite results. Real sessions issue hundreds of
 * distinct commands; the cap keeps a pathological one (a generated loop) from
 * growing the map without bound. Reaching it is harmless — the only cost of an
 * eviction is one more 11 ms probe.
 */
export const REWRITE_CACHE_MAX_ENTRIES = 1024

/** Memoized "rtk had nothing to offer for this command"; cheaper than `undefined`-vs-unset bookkeeping. */
const NO_REWRITE = Symbol('rtk:no-rewrite')

/**
 * Memoization cell shared by the executors. Keyed by `bin` first because a test
 * harness can point several probes at different fake binaries inside one
 * process, and their answers must not be conflated.
 */
export type RewriteCache = Map<string, string | typeof NO_REWRITE>

/** Blank a value so a caller's empty-string env override cannot win over the real PATH lookup. */
function orNull(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value
}

/**
 * The `rtk` executable to invoke. `RTK_BIN` is an explicit override for
 * deployments that keep rtk off `PATH`; tests use it to point at a fake binary
 * instead of depending on an rtk install.
 */
export function resolveRtkBin(): string {
  return orNull(process.env['RTK_BIN']) ?? 'rtk'
}

/** How long one `rtk rewrite` call may take; `RTK_TIMEOUT_MS` overrides for tests. */
export function resolveRtkTimeoutMs(): number {
  const raw = orNull(process.env['RTK_TIMEOUT_MS'])
  if (raw === null) return DEFAULT_RTK_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RTK_TIMEOUT_MS
}

/**
 * Probe whether `rtk` is runnable. Absence is not an error: the transform
 * degrades to the identity, so a deployment without rtk behaves exactly like
 * the stock executor.
 *
 * @param bin - executable to probe (default: {@link resolveRtkBin}).
 * @returns true when the binary exits 0 for `--version`.
 */
export function probeRtkAvailable(bin?: string | undefined): boolean {
  const executable = bin ?? resolveRtkBin()
  try {
    return spawnSync(executable, ['--version'], { stdio: 'ignore', timeout: DEFAULT_RTK_TIMEOUT_MS }).status === 0
  } catch {
    /* v8 ignore next -- spawnSync throws only on a broken runtime, not a missing binary */
    return false
  }
}

/**
 * Ask rtk to rewrite one command.
 *
 * Only stdout is read. rtk signals the *permission* outcome through its exit
 * code, and the code does not gate the rewrite:
 *
 * | exit | meaning | stdout |
 * |---|---|---|
 * | 0 | rewrite, an allow rule owns approval | the rewritten command |
 * | 3 | rewrite, approval left to the host | the rewritten command |
 * | 1 | nothing to rewrite (`HookDecision::Defer`) | empty |
 * | 2 | a deny rule matched (`HookDecision::Deny`) | empty |
 *
 * So a non-zero status is not a failure, and an empty stdout is the single
 * "nothing to do" signal — which also makes the deny case fall out naturally
 * as a passthrough. Nothing is branched on the code, which is what keeps this
 * correct if rtk ever prints alongside a refusal.
 *
 * DSH has no counterpart to Claude Code's permission rules, so the exit-code
 * decision is intentionally discarded: the DSH host keeps its own approval
 * policy for the rewritten command, unchanged.
 *
 * @param command - raw shell source to rewrite.
 * @param options - binary, timeout and stdio overrides (tests).
 * @returns the rewritten command, or undefined when rtk offers none.
 */
export function runRtkRewrite(
  command: string,
  options: { bin?: string | undefined; timeoutMs?: number | undefined; stdio?: 'ignore' | 'pipe' } = {},
): string | undefined {
  const bin = options.bin ?? resolveRtkBin()
  const timeout = options.timeoutMs ?? resolveRtkTimeoutMs()
  try {
    // A denied command makes rtk write a human-readable refusal to stderr; it
    // is not a report about this command's output, so it is dropped rather than
    // surfaced as a fake stderr line. stdout is never fatal here, so the stdio
    // choice only decides whether a test can prove that.
    const captured = options.stdio === 'ignore' ? 'ignore' : 'pipe'
    const result = spawnSync(bin, ['rewrite', command], {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', captured, captured],
      windowsHide: true,
    })
    if (result.error !== undefined || result.status === null) return undefined
    const rewritten = (result.stdout ?? '').replace(TRAILING_NEWLINES, '')
    return rewritten === '' ? undefined : rewritten
  } catch {
    /* v8 ignore next -- spawnSync throws only on a broken runtime, not on a missing binary */
    return undefined
  }
}

/** rtk already yields the command; a trailing newline is its line discipline, not part of the command. */
const TRAILING_NEWLINES = /\n+$/

/**
 * Decide the command to run: rtk's rewrite when rtk offers one, otherwise the
 * original string byte-for-byte.
 *
 * Callers pass a per-executor `cache` so memoization lives and dies with the
 * executor instance — a long-lived host does not leak one deployment's answers
 * into another's.
 *
 * @param command - raw shell source the model asked to run.
 * @param cache - memoization cell, shared across this executor's commands.
 * @param isCandidate - cheap pre-filter; returning false skips the probe.
 * @param maxEntries - cache ceiling; only a test passes this, so it can prove
 *   the eviction at a handful of probes instead of a thousand spawns.
 * @returns the command to execute, always non-empty.
 */
export function applyRtkRewrite(
  command: string,
  cache: RewriteCache,
  isCandidate: (command: string) => boolean = () => true,
  maxEntries: number = REWRITE_CACHE_MAX_ENTRIES,
): string {
  if (command === '' || !isCandidate(command)) return command
  const bin = resolveRtkBin()
  const key = `${bin}\u0000${command}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached === NO_REWRITE ? command : cached
  const rewritten = runRtkRewrite(command)
  // The command is never empty, so a distinct result is always the rewrite.
  // An unchanged result is rtk saying "already in RTK form" — memoize it too.
  if (cache.size >= maxEntries) evictOldest(cache)
  if (rewritten === undefined) {
    cache.set(key, NO_REWRITE)
    return command
  }
  cache.set(key, rewritten)
  return rewritten
}

/** Drop every memoized rewrite. Exposed for tests and for a caller that has just upgraded rtk in place. */
export function clearRewriteCache(cache: RewriteCache): void {
  cache.clear()
}

/**
 * Make room for one more entry.
 *
 * Evicts the oldest entry — `Map` preserves insertion order — rather than
 * clearing the whole cache. A burst past the cap therefore costs one re-probe
 * per new command instead of discarding every answer and re-probing the whole
 * working set, which in a long session would never converge.
 *
 * @param cache - memoization cell to trim.
 */
function evictOldest(cache: RewriteCache): void {
  const oldest = cache.keys().next()
  if (oldest.done !== true) cache.delete(oldest.value)
}
