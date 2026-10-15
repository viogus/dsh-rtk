import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxMode, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { RtkSandboxBashExecutor } from '../src/index.ts'

/**
 * Stand-in for `ctx.sessionProjections`.
 *
 * `SandboxPolicyService` injects that service, so without it the policy service
 * — and therefore the sandbox executor — never activates. The real package drags
 * in the session log, format and query stack, none of which this seam exercises;
 * the policy service touches exactly two members, so the stub implements exactly
 * those and mirrors their contract:
 *
 * - `register` is called once in the constructor and its return value ignored.
 * - `stateOf` returns the session's last logged value, or `undefined` when the
 *   session never logged one, which is the case under test.
 */
class FakeSessionProjections extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionProjections')
  }

  register(): void {}

  stateOf(): undefined {
    return undefined
  }
}

/** A passthrough wrap: the caller's argv unchanged, asserted whole. */
const passthrough = (argv: readonly string[]): ConfinedArgv => ({
  argv: [...argv],
  enforcement: 'full',
  denialSignatures: [],
  runnerFailureRules: [],
})

/** See `executor.spec.ts` for why a stand-in binary replaces the real rtk. */
const FAKE_RTK_SOURCE = `#!/usr/bin/env node
const argv = process.argv.slice(2)
if (argv[0] === '--version') { console.log('rtk 9.9.9-test'); process.exit(0) }
if (argv[0] !== 'rewrite') process.exit(1)
const command = argv[1] ?? ''
if (command.startsWith('rtk ')) { console.log(command); process.exit(3) }
if (!command.startsWith('git')) process.exit(3)
console.log(command.replace(/^git/, 'rtk git'))
process.exit(3)
`

let fakeRtkDir: string
let fakeRtk: string
let spillDir: string
const originalRtkBin = process.env['RTK_BIN']

beforeAll(() => {
  fakeRtkDir = mkdtempSync(join(tmpdir(), 'dsh-rtk-sandbox-bin-'))
  fakeRtk = join(fakeRtkDir, 'rtk')
  writeFileSync(fakeRtk, FAKE_RTK_SOURCE)
  chmodSync(fakeRtk, 0o755)
  spillDir = mkdtempSync(join(tmpdir(), 'dsh-rtk-sandbox-spec-'))
})

afterAll(() => {
  rmSync(fakeRtkDir, { recursive: true, force: true })
  rmSync(spillDir, { recursive: true, force: true })
})

afterEach(() => {
  if (originalRtkBin === undefined) delete process.env['RTK_BIN']
  else process.env['RTK_BIN'] = originalRtkBin
})

async function setup(config: { mode?: SandboxMode } = {}) {
  const { mode, ...execConfig } = config
  const calls: { argv: string[]; policy: SandboxPolicy }[] = []
  class FakeSandboxProvider extends SandboxProvider {
    /**
     * `confine` is async on the DSH 0.2 seam: a provider may have to resolve its
     * runner and policy before it can answer. Recording the call proves the
     * rewrite reached the argv the confinement wraps.
     */
    async confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv> {
      calls.push({ argv: [...argv], policy })
      return passthrough(argv)
    }
  }
  const ctx = new Context()
  await ctx.plugin(FakeSandboxProvider)
  await ctx.plugin(FakeSessionProjections)
  await ctx.plugin(SandboxPolicyService, { ...(mode !== undefined ? { mode } : {}) })
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  process.env['RTK_BIN'] = fakeRtk
  await ctx.plugin(RtkSandboxBashExecutor, { graceMs: 200, ...execConfig })
  const bash = ctx.shell as RtkSandboxBashExecutor
  return { ctx, bash, calls }
}

describe('RtkSandboxBashExecutor', () => {
  it('registers as ctx.shell in place of the stock sandbox executor', async () => {
    const { bash } = await setup()
    expect(bash).toBeInstanceOf(RtkSandboxBashExecutor)
  })

  it('rewrites before the sandbox confines the command', async () => {
    // Confinement wraps an argv, so the rewrite must already have happened:
    // the confined process is the rtk-routed one.
    const { ctx, bash, calls } = await setup({ mode: 'read-only' })
    await bash.execute(bash.resolve({ command: 'git status' }))
    expect(calls).toEqual([{
      argv: ['bash', '-c', 'rtk git status'],
      policy: { mode: 'read-only', workspaceRoot: resolve(process.cwd()) },
    }])
  })

  it('leaves a non-routable command untouched before confinement', async () => {
    const { bash, calls } = await setup({ mode: 'read-only' })
    await bash.execute(bash.resolve({ command: 'cd /tmp' }))
    expect(calls[0]?.argv).toEqual(['bash', '-c', 'cd /tmp'])
  })

  it('stamps sandbox facts on the settled execution', async () => {
    const { bash } = await setup({ mode: 'read-only' })
    const execution = await bash.execute(bash.resolve({ command: 'cd /tmp' }))
    await execution.done
    expect(execution.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })
})
