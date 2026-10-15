/**
 * rtk (Rust Token Killer) bash executor plugin for the DeepSeek Harness.
 *
 * Two providers wrap the stock bash executors and rewrite the shell source at
 * the `resolve` boundary, so workdir/timeout/env/exit-code/background-job and
 * (for the sandbox variant) confinement semantics are all inherited unchanged.
 * The rewrite decision is delegated to `rtk rewrite` (see `./wrap.ts`), so the
 * plugin tracks whatever rtk release the user has installed instead of a
 * hand-maintained command list. A command rtk does not rewrite — or any command
 * at all, when the `rtk` binary is missing — passes through byte-for-byte.
 *
 * @module @viogus/dsh-rtk
 */

import { Context } from '@deepseek-ai/cordis'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-bash-local'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import type { ShellExecRequest, ShellExecSpec } from '@deepseek-ai/dsh-shell'
import { applyRtkRewrite, probeRtkAvailable } from './rtk.ts'
import type { RewriteCache } from './rtk.ts'

export { applyRtkRewrite, probeRtkAvailable, runRtkRewrite } from './rtk.ts'
export { isRoutableCandidate, wrapWithRtk } from './wrap.ts'

/** Extend the upstream config so cordis plugin() accepts the rtk options. */
declare module '@deepseek-ai/dsh-bash-local' {
  interface Config {
    /**
     * Whether the `rtk` binary is usable. Defaults to a `rtk --version` probe on
     * `PATH`; set it to force the behaviour in tests or in a deployment whose
     * binary lives somewhere unusual.
     */
    rtkAvailable?: boolean
    /**
     * Whether to consult `rtk rewrite`. On by default. Set to false to keep the
     * executor a plain passthrough while still registering as `ctx.shell`.
     */
    rtkRewrite?: boolean
  }
}

/**
 * The rtk half of the unconfined executor.
 *
 * `resolve()` is the one seam both executors override, and it is the right one:
 * it runs before any command reaches `execute`, so every downstream path — the
 * unconfined spawn here and the confined argv in the sandbox variant — sees the
 * rewritten source.
 */
export class RtkBashExecutor extends LocalBashExecutor {
  private readonly rtkRewrite: boolean

  /**
   * Memoized `rtk rewrite` answers for this executor's commands. Per instance,
   * so one deployment's rewrite results cannot leak into another's after a
   * reload, and so an rtk upgrade is picked up by a restart rather than served
   * from a stale process-global cache.
   */
  private readonly rewriteCache: RewriteCache = new Map()

  constructor(ctx: Context, config: LocalConfig) {
    super(ctx, config)
    // `rtkAvailable` is honoured as a plain flag, so a caller that already
    // resolved the binary never pays a second probe.
    const available = config.rtkAvailable ?? probeRtkAvailable()
    this.rtkRewrite = available && config.rtkRewrite !== false
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    const spec = super.resolve(request)
    if (!this.rtkRewrite) return spec
    return { ...spec, command: applyRtkRewrite(spec.command, this.rewriteCache) }
  }
}

/**
 * rtk-rewriting SANDBOX bash executor (preserves file confinement).
 *
 * Extends the stock `SandboxBashExecutor` — not `LocalBashExecutor` — so the
 * confinement machinery, its `inject` list and its result decoration are all
 * inherited rather than reimplemented. It registers as `ctx.shell` in place of
 * `dsh-bash-sandbox`.
 *
 * The rewrite happens in `resolve()`, before `execute()` reads
 * `spec.command`, so the argv handed to `ctx.sandbox.confine` is the rtk-routed
 * one. It also calls `super.resolve()` first, which stamps the per-call
 * `sandboxPolicy`; the spread below carries that field through untouched.
 */
export class RtkSandboxBashExecutor extends SandboxBashExecutor {
  static override inject = ['subprocess', 'sandbox', 'sandboxPolicy']

  private readonly rtkRewrite: boolean

  /** See {@link RtkBashExecutor.rewriteCache} — per instance, same rationale. */
  private readonly rewriteCache: RewriteCache = new Map()

  constructor(ctx: Context, config: LocalConfig) {
    super(ctx, config)
    const available = config.rtkAvailable ?? probeRtkAvailable()
    this.rtkRewrite = available && config.rtkRewrite !== false
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    const spec = super.resolve(request)
    if (!this.rtkRewrite) return spec
    return { ...spec, command: applyRtkRewrite(spec.command, this.rewriteCache) }
  }
}

export default RtkSandboxBashExecutor

