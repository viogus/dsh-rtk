import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { RtkBashExecutor, RtkSandboxBashExecutor } from '../src/index.ts'

/**
 * A stand-in for the `rtk` binary.
 *
 * The real binary is deliberately not a test dependency: `RTK_BIN` is the
 * supported override, and a stand-in keeps these assertions hermetic — they must
 * not change when the machine's rtk changes, nor require one to be installed.
 * It mirrors the parts of rtk's contract the plugin relies on:
 *
 * - `rtk --version` exits 0, which is how availability is probed.
 * - `rtk rewrite <cmd>` prints the rewrite on stdout, or prints nothing when it
 *   declines. It exits 3 in both cases, matching real rtk — so the plugin must
 *   read stdout rather than the exit code, and this stand-in proves it does.
 * - an already-wrapped command is reported unchanged (rtk's idempotence).
 */
const FAKE_RTK_SOURCE = `#!/usr/bin/env node
const argv = process.argv.slice(2)
if (argv[0] === '--version') { console.log('rtk 9.9.9-test'); process.exit(0) }
if (argv[0] !== 'rewrite') process.exit(1)
const command = argv[1] ?? ''
const RULES = { git: 'rtk git', cargo: 'rtk cargo', npm: 'rtk npm', tree: 'rtk tree' }
if (command.startsWith('rtk ')) { console.log(command); process.exit(3) }
const head = command.split(' ')[0]
const replacement = RULES[head]
if (replacement === undefined) process.exit(3)
console.log(command.replace(new RegExp('^' + head), replacement))
process.exit(3)
`

let fakeRtkDir: string
let fakeRtk: string
const originalRtkBin = process.env['RTK_BIN']

beforeAll(() => {
  fakeRtkDir = mkdtempSync(join(tmpdir(), 'dsh-rtk-fake-bin-'))
  fakeRtk = join(fakeRtkDir, 'rtk')
  writeFileSync(fakeRtk, FAKE_RTK_SOURCE)
  chmodSync(fakeRtk, 0o755)
})

afterAll(() => {
  rmSync(fakeRtkDir, { recursive: true, force: true })
})

afterEach(() => {
  if (originalRtkBin === undefined) delete process.env['RTK_BIN']
  else process.env['RTK_BIN'] = originalRtkBin
})

/**
 * Boot an executor over the real subprocess seam with rtk pointed at the
 * stand-in. `rtkAvailable` is left to the probe so the tests exercise the same
 * resolution path a deployment does.
 */
async function setup(config: { rtkAvailable?: boolean; rtkRewrite?: boolean } = {}) {
  process.env['RTK_BIN'] = fakeRtk
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(RtkBashExecutor, { ...config })
  const bash = ctx.shell as RtkBashExecutor
  return { ctx, bash }
}

describe('RtkBashExecutor', () => {
  it('registers as ctx.shell', async () => {
    const { bash } = await setup()
    expect(bash).toBeInstanceOf(RtkBashExecutor)
  })

  it('routes an eligible command through rtk at the resolve() boundary', async () => {
    // The whole delegation path: probe → resolve → spawn `rtk rewrite` → adopt stdout.
    const { bash } = await setup()
    expect(bash.resolve({ command: 'git status' }).command).toBe('rtk git status')
  })

  it('leaves a command rtk declines byte-for-byte', async () => {
    const { bash } = await setup()
    // A builtin: rtk has no rule for it, so the pre-filter and the rewrite agree
    // and the original string reaches the shell untouched.
    expect(bash.resolve({ command: 'cd /tmp' }).command).toBe('cd /tmp')
  })

  it('preserves the inherited spec fields while rewriting', async () => {
    const { bash } = await setup()
    const spec = bash.resolve({ command: 'cargo build --release', timeoutMs: 4321 })
    expect(spec.command).toBe('rtk cargo build --release')
    // The rewrite must not clobber anything resolve() filled in.
    expect(spec.timeoutMs).toBe(4321)
    expect(spec.workdir).toBe(process.cwd())
  })

  it('routes a command that was never on the plugin\'s old whitelist', async () => {
    // The point of delegating: `tree` is routable by real rtk 1.0.1 and was on
    // no hand-maintained list this plugin ever shipped. The stand-in plays rtk's
    // role, so the seam — not a plugin table — decides.
    const { bash } = await setup()
    expect(bash.resolve({ command: 'tree' }).command).toBe('rtk tree')
  })

  it('does not double-wrap an already-rtk command', async () => {
    const { bash } = await setup()
    expect(bash.resolve({ command: 'rtk git status' }).command).toBe('rtk git status')
  })

  it('memoizes a repeated command', async () => {
    const { bash } = await setup()
    expect(bash.resolve({ command: 'git log --oneline' }).command).toBe('rtk git log --oneline')
    expect(bash.resolve({ command: 'git log --oneline' }).command).toBe('rtk git log --oneline')
  })

  it('falls back to identity when rtkAvailable is false', async () => {
    const { bash } = await setup({ rtkAvailable: false })
    expect(bash.resolve({ command: 'git status' }).command).toBe('git status')
  })

  it('falls back to identity when rtkRewrite is false', async () => {
    const { bash } = await setup({ rtkRewrite: false })
    expect(bash.resolve({ command: 'git status' }).command).toBe('git status')
  })

  it('falls back to identity when RTK_BIN points nowhere', async () => {
    // Availability is resolved per executor, so a missing binary is a silent
    // passthrough rather than a load failure.
    process.env['RTK_BIN'] = join(fakeRtkDir, 'does-not-exist')
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(RtkBashExecutor, {})
    const bash = ctx.shell as RtkBashExecutor
    expect(bash.resolve({ command: 'git status' }).command).toBe('git status')
  })

  it('reaches the seam: the resolved spec is what actually executes', async () => {
    // Guards the integration the resolve()-only assertions cannot.
    const { bash } = await setup({ rtkAvailable: false })
    const execution = await bash.execute(bash.resolve({ command: 'echo dsh-rtk-exec-ok' }))
    const result = await execution.result()
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toContain('dsh-rtk-exec-ok')
  })
})

describe('RtkSandboxBashExecutor', () => {
  it('exports as a distinct provider from the unconfined executor', async () => {
    // The two share their rewrite base but must stay separate classes: one
    // registers a sandboxing executor and the other does not.
    expect(RtkSandboxBashExecutor).not.toBe(RtkBashExecutor)
    expect(RtkSandboxBashExecutor.inject).toContain('sandbox')
  })
})

describe('stand-in rtk contract', () => {
  it('exits 3 while printing the rewrite, which is what the plugin must tolerate', () => {
    expect(execFileSync(fakeRtk, ['--version'], { encoding: 'utf8' }).trim()).toBe('rtk 9.9.9-test')
    let stdout = ''
    try {
      stdout = execFileSync(fakeRtk, ['rewrite', 'git status'], { encoding: 'utf8' })
    } catch (error) {
      const failed = error as { status?: number; stdout?: string }
      expect(failed.status).toBe(3)
      stdout = failed.stdout ?? ''
    }
    expect(stdout.trim()).toBe('rtk git status')
  })
})
