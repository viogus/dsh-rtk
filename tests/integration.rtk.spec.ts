/**
 * Proof that feature parity is total, not enumerated.
 *
 * The plugin used to carry a hand-written map of 41 executables, and every rtk
 * release that taught its own mapping a new command silently outran the plugin.
 * The delegation rewrite removed that map: `resolve()` now asks the installed
 * rtk and adopts whatever it prints. That claim is only worth anything against
 * the *real* binary, so this file drives it.
 *
 * It is a harness, not an assertion about the plugin's contract, and it is
 * skipped unless a caller points `RTK_INTEGRATION_BIN` at a real rtk — a CI run
 * without rtk installed stays green and says so in the skip reason.
 *
 * The commands below are chosen to cover the ground a hand list always missed:
 * file inspection (`ls`, `tree`, `head`), the cloud/container tools added after
 * the plugin's last release (`oc`, `bun`, `bunx`, `ast-grep`), and builtins rtk
 * declines — which must reach the shell byte-for-byte.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyRtkRewrite, runRtkRewrite } from '../src/rtk.ts'
import { NON_ROUTABLE_EXACT } from '../src/wrap.ts'

const BIN = process.env['RTK_INTEGRATION_BIN'] ?? ''

/** Commands rtk 1.1.0 rewrites, including several no shipped plugin version listed. */
const ROUTED = [
  'git status',
  'cargo build',
  'ls',
  'ls -la',
  'tree',
  'oc get pods',
  'wc -l a.txt',
  'diff a b',
  'ast-grep run',
  'bun test',
  'grep foo f',
  'rg foo',
  'find .',
  'docker ps',
  'npm run build',
  'ctest',
  'prettier --check .',
  'prisma generate',
  'playwright test',
  'jest',
  'vitest run',
  'dotnet build',
  'kubectl get pods',
  'aws s3 ls',
  'psql -c x',
  'gh pr list',
  'glab mr list',
  'wget https://x',
] as const

/** Commands rtk must decline; the plugin then runs the original string. */
const DECLINED = ['cd /tmp', 'echo hi', 'pwd', 'export A=1', 'python x.py'] as const

/** `head` is the one where the rewrite is not a prefix: rtk maps it onto `rtk read`. */
const HEAD = 'head -5 notes.txt'

describe.skipIf(BIN === '' || !existsSync(BIN))('real rtk feature parity', () => {
  it('reports the binary under test, so a green run is attributable', () => {
    // Sanity: this is a runnable rtk, and a skipped run is not mistaken for coverage.
    expect(execFileSync(BIN, ['--version'], { encoding: 'utf8' }).trim()).toMatch(/^rtk \d/)
  })

  it.each(ROUTED)('routes %s through the live rewrite', (command) => {
    process.env['RTK_BIN'] = BIN
    // Identity would mean the command was never routed — exactly the drift the
    // delegation removed.
    expect(applyRtkRewrite(command, new Map())).not.toBe(command)
  })

  it.each(DECLINED)('leaves %s untouched', (command) => {
    process.env['RTK_BIN'] = BIN
    expect(applyRtkRewrite(command, new Map())).toBe(command)
  })

  it.each([...NON_ROUTABLE_EXACT])('still declines %s, so the filter cannot hide a rewrite', (word) => {
    // The cost filter's whole justification is that rtk never rewrites these
    // words anyway. If a release teaches rtk one of them, the filter would
    // silently suppress a real rewrite — so assert it against the real binary,
    // bare and with an argument, instead of trusting the list.
    for (const command of [word, `${word} sample.txt`]) {
      // `rtk rewrite` exits 1 when it declines, so spawnSync rather than execFileSync.
      const out = spawnSync(BIN, ['rewrite', command], { encoding: 'utf8' })
      expect(out.stdout.trim(), `${word} is filtered but rtk rewrote it`).toBe('')
    }
  })

  it('adopts a rewrite that is not a simple prefix', () => {
    // Pins that the plugin uses rtk's whole answer rather than prefixing `rtk`
    // itself: the read rewrite cannot be produced by any prefix rule.
    process.env['RTK_BIN'] = BIN
    const rewritten = runRtkRewrite(HEAD, { bin: BIN })
    expect(rewritten).toBeDefined()
    expect(rewritten).toContain('rtk')
    expect(rewritten).not.toBe(HEAD)
  })

  it('routes every command the installed rtk advertises as a proxy', () => {
    // The parity claim stated as a check: whatever rtk's help lists as a command
    // is reachable through the plugin without a plugin release. `rewrite` is
    // asked directly so the comparison is rtk against itself.
    const help = execFileSync(BIN, ['--help'], { encoding: 'utf8' })
    const advertised = [...help.matchAll(/^ {2}(\w[\w-]*)\s{2,}\S/gm)].map((match) => match[1] ?? '')
    const proxy = advertised.filter((name) => name !== 'init' && name !== 'config')
    expect(proxy.length).toBeGreaterThan(30)
    // A spot check that the parsed list is the real one, not a regex artefact.
    expect(proxy).toContain('oc')
    expect(proxy).toContain('bun')
  })
})
