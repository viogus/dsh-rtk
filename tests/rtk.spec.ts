import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  REWRITE_CACHE_MAX_ENTRIES,
  applyRtkRewrite,
  clearRewriteCache,
  probeRtkAvailable,
  resolveRtkBin,
  runRtkRewrite,
} from '../src/rtk.ts'
import type { RewriteCache } from '../src/rtk.ts'

let binDir: string
let originalRtkBin: string | undefined

/** Write an executable stand-in and return its path. */
function makeBin(name: string, source: string): string {
  const path = join(binDir, name)
  writeFileSync(path, `#!/usr/bin/env node\n${source}\n`)
  chmodSync(path, 0o755)
  return path
}

/** Counts invocations in a side file so a test can prove memoization happened. */
function countingBin(name: string, marker: string): { path: string; calls: () => number } {
  const counter = join(binDir, `${name}.count`)
  const path = makeBin(
    name,
    `const fs = require('node:fs')
const argv = process.argv.slice(2)
if (argv[0] === '--version') process.exit(0)
if (argv[0] !== 'rewrite') process.exit(1)
fs.appendFileSync(${JSON.stringify(counter)}, 'x')
process.stdout.write('rtk ' + (argv[1] ?? ''))
process.exit(3)`,
  )
  return {
    path,
    calls: () => {
      try {
        return (require('node:fs').readFileSync(counter, 'utf8') as string).length
      } catch {
        return 0
      }
    },
  }
}

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), 'dsh-rtk-unit-'))
  originalRtkBin = process.env['RTK_BIN']
})

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true })
})

beforeEach(() => {
  process.env['RTK_BIN'] = join(binDir, 'absent-on-purpose')
})

afterEach(() => {
  if (originalRtkBin === undefined) delete process.env['RTK_BIN']
  else process.env['RTK_BIN'] = originalRtkBin
})

describe('resolveRtkBin', () => {
  it('defaults to `rtk` on PATH', () => {
    delete process.env['RTK_BIN']
    expect(resolveRtkBin()).toBe('rtk')
  })

  it('honours RTK_BIN', () => {
    process.env['RTK_BIN'] = '/opt/custom/rtk'
    expect(resolveRtkBin()).toBe('/opt/custom/rtk')
  })

  it('treats an empty RTK_BIN as unset', () => {
    process.env['RTK_BIN'] = ''
    expect(resolveRtkBin()).toBe('rtk')
  })
})

describe('probeRtkAvailable', () => {
  it('is false for a missing binary', () => {
    expect(probeRtkAvailable(join(binDir, 'nope'))).toBe(false)
  })

  it('is true when --version exits 0', () => {
    const bin = makeBin('probe-ok', 'process.exit(0)')
    expect(probeRtkAvailable(bin)).toBe(true)
  })

  it('is false when --version exits non-zero', () => {
    const bin = makeBin('probe-bad', 'process.exit(1)')
    expect(probeRtkAvailable(bin)).toBe(false)
  })
})

describe('runRtkRewrite', () => {
  it('returns the rewrite printed on stdout despite a non-zero exit', () => {
    const bin = makeBin('rw-ok', `process.stdout.write('rtk git status');process.exit(3)`)
    expect(runRtkRewrite('git status', { bin })).toBe('rtk git status')
  })

  it('strips the trailing newline rtk prints', () => {
    const bin = makeBin('rw-nl', `process.stdout.write('rtk git status\\n');process.exit(0)`)
    expect(runRtkRewrite('git status', { bin })).toBe('rtk git status')
  })

  it('returns undefined when rtk declines by printing nothing', () => {
    const bin = makeBin('rw-empty', 'process.exit(1)')
    expect(runRtkRewrite('ls', { bin })).toBeUndefined()
  })

  it('returns undefined for a missing binary instead of throwing', () => {
    expect(runRtkRewrite('git status', { bin: join(binDir, 'nope') })).toBeUndefined()
  })

  it('returns undefined when the binary exceeds the timeout', () => {
    // A wedged rtk must never hold up resolve(); the budget turns it into a
    // plain passthrough instead of a hang.
    const bin = makeBin('rw-slow', `setTimeout(() => {}, 60000)`)
    expect(runRtkRewrite('git status', { bin, timeoutMs: 150 })).toBeUndefined()
  })

  it('does not leak a refusal message into the command', () => {
    // rtk's deny path prints nothing on stdout and writes to stderr; stdout is
    // the only stream read, so a stderr line can never become the command.
    const bin = makeBin('rw-stderr', `process.stderr.write('denied by policy\\n');process.exit(2)`)
    expect(runRtkRewrite('git push', { bin })).toBeUndefined()
  })
})

describe('applyRtkRewrite', () => {
  it('adopts the rewrite when rtk offers one', () => {
    const bin = makeBin('apply-ok', `process.stdout.write('rtk git status');process.exit(3)`)
    process.env['RTK_BIN'] = bin
    expect(applyRtkRewrite('git status', new Map())).toBe('rtk git status')
  })

  it('passes through when rtk offers nothing', () => {
    const bin = makeBin('apply-no', 'process.exit(1)')
    process.env['RTK_BIN'] = bin
    expect(applyRtkRewrite('ls -la', new Map())).toBe('ls -la')
  })

  it('passes through an empty command without probing', () => {
    process.env['RTK_BIN'] = join(binDir, 'nope')
    expect(applyRtkRewrite('', new Map())).toBe('')
  })

  it('skips the probe entirely when the candidate filter declines', () => {
    const { path, calls } = countingBin('apply-gate', 'x')
    process.env['RTK_BIN'] = path
    const filtered = applyRtkRewrite('echo hi', new Map(), () => false)
    expect(filtered).toBe('echo hi')
    expect(calls()).toBe(0)
  })

  it('memoizes so a repeated command costs one probe', () => {
    const { path, calls } = countingBin('apply-cache', 'x')
    process.env['RTK_BIN'] = path
    const cache: RewriteCache = new Map()
    expect(applyRtkRewrite('git status', cache)).toBe('rtk git status')
    expect(applyRtkRewrite('git status', cache)).toBe('rtk git status')
    expect(calls()).toBe(1)
  })

  it('memoizes a declined command too, so it is not re-probed', () => {
    const bin = makeBin('apply-declined', 'process.exit(1)')
    process.env['RTK_BIN'] = bin
    const cache: RewriteCache = new Map()
    expect(applyRtkRewrite('wc -l x', cache)).toBe('wc -l x')
    expect(cache.size).toBe(1)
    expect(applyRtkRewrite('wc -l x', cache)).toBe('wc -l x')
    expect(cache.size).toBe(1)
  })

  it('keys the cache by binary, so two rtk builds cannot be conflated', () => {
    const a = makeBin('key-a', `process.stdout.write('rtk-A git status');process.exit(3)`)
    const b = makeBin('key-b', `process.stdout.write('rtk-B git status');process.exit(3)`)
    const cache: RewriteCache = new Map()
    process.env['RTK_BIN'] = a
    expect(applyRtkRewrite('git status', cache)).toBe('rtk-A git status')
    process.env['RTK_BIN'] = b
    expect(applyRtkRewrite('git status', cache)).toBe('rtk-B git status')
  })

  it('evicts the oldest entry once the cap is reached, not the whole memo', () => {
    // A small ceiling keeps this to a handful of spawns while pinning the real
    // eviction contract: exactly one entry leaves, and it is the oldest.
    const bin = makeBin('apply-bound', 'process.exit(1)')
    process.env['RTK_BIN'] = bin
    const cache: RewriteCache = new Map()
    const cap = 4
    for (let index = 0; index < cap; index += 1) {
      applyRtkRewrite(`git status --n${index}`, cache, () => true, cap)
    }
    expect(cache.size).toBe(cap)
    const oldest = `${bin}\u0000git status --n0`
    expect(cache.has(oldest)).toBe(true)

    applyRtkRewrite(`git status --n${cap}`, cache, () => true, cap)

    expect(cache.size).toBe(cap)
    expect(cache.has(oldest)).toBe(false)
    expect(cache.has(`${bin}\u0000git status --n${cap}`)).toBe(true)
  })

  it('never exceeds the shipped cap', () => {
    const bin = makeBin('apply-bound-real', 'process.exit(1)')
    process.env['RTK_BIN'] = bin
    const cache: RewriteCache = new Map()
    for (let index = 0; index < REWRITE_CACHE_MAX_ENTRIES + 5; index += 1) {
      applyRtkRewrite(`git status --n${index}`, cache)
    }
    expect(cache.size).toBe(REWRITE_CACHE_MAX_ENTRIES)
  }, 30_000)

  it('clearRewriteCache empties the memo', () => {
    const bin = makeBin('apply-clear', 'process.exit(1)')
    process.env['RTK_BIN'] = bin
    const cache: RewriteCache = new Map()
    applyRtkRewrite('git status', cache)
    expect(cache.size).toBeGreaterThan(0)
    clearRewriteCache(cache)
    expect(cache.size).toBe(0)
  })
})
