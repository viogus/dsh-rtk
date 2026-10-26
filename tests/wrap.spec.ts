import { describe, expect, it } from 'vitest'
import { isRoutableCandidate, wrapWithRtk } from '../src/wrap.ts'

describe('wrapWithRtk', () => {
  describe('rtk unavailable', () => {
    it('passes every command through unchanged', () => {
      expect(wrapWithRtk('git status', false)).toBe('git status')
      expect(wrapWithRtk('cargo build --release', false)).toBe('cargo build --release')
    })
  })

  describe('complex shell commands pass through unchanged', () => {
    it('pipes', () => {
      expect(wrapWithRtk('git status | grep modified', true)).toBe('git status | grep modified')
    })
    it('logical lists', () => {
      expect(wrapWithRtk('npm install && npm run build', true)).toBe('npm install && npm run build')
      expect(wrapWithRtk('cargo test || cargo check', true)).toBe('cargo test || cargo check')
    })
    it('semicolon lists', () => {
      expect(wrapWithRtk('cd src; git status', true)).toBe('cd src; git status')
    })
    it('redirections', () => {
      expect(wrapWithRtk('git log > /tmp/log.txt', true)).toBe('git log > /tmp/log.txt')
    })
    it('command substitution and variables', () => {
      expect(wrapWithRtk('echo $(git rev-parse HEAD)', true)).toBe('echo $(git rev-parse HEAD)')
      expect(wrapWithRtk('git commit -m "$MSG"', true)).toBe('git commit -m "$MSG"')
    })
  })

  describe('the gate errs toward yes', () => {
    it('accepts a command the old 41-entry whitelist would have missed', () => {
      // `tree`, `oc` and `head` are all routed by rtk 1.1.0 and none was ever on
      // the removed `RTK_COMMAND_MAP`. That drift — a hand list chasing rtk's
      // own mapping — is why the executor asks rtk via `rtk rewrite` now, and
      // why the surviving gate is a denylist of provably-unroutable words
      // rather than a whitelist of remembered ones.
      expect(wrapWithRtk('tree', true)).toBe('rtk tree')
      expect(wrapWithRtk('oc get pods', true)).toBe('rtk oc get pods')
      expect(wrapWithRtk('head -20 foo.txt', true)).toBe('rtk head -20 foo.txt')
    })
    it('declines the stale matching that the whitelist also declined', () => {
      expect(wrapWithRtk('cd /tmp', true)).toBe('cd /tmp')
      expect(wrapWithRtk('sudo git status', true)).toBe('sudo git status')
      expect(wrapWithRtk('FOO=bar git status', true)).toBe('FOO=bar git status')
    })
  })

  describe('whitelisted simple commands are wrapped', () => {
    it('git', () => {
      expect(wrapWithRtk('git status', true)).toBe('rtk git status')
    })
    it('cargo', () => {
      expect(wrapWithRtk('cargo build --release', true)).toBe('rtk cargo build --release')
    })
    it('npm', () => {
      expect(wrapWithRtk('npm install', true)).toBe('rtk npm install')
    })
    it('golangci-lint maps to its rtk subcommand', () => {
      expect(wrapWithRtk('golangci-lint run', true)).toBe('rtk golangci-lint run')
    })
    it('preserves arguments verbatim', () => {
      expect(wrapWithRtk('git log --oneline -10', true)).toBe('rtk git log --oneline -10')
    })
    it('matches the first token case-insensitively', () => {
      // The lookup is case-insensitive; the prefix keeps the source spelling,
      // because only the *match* is a case question, not the command.
      expect(wrapWithRtk('GIT status', true)).toBe('rtk GIT status')
    })
    it('wraps a bare command with no arguments', () => {
      expect(wrapWithRtk('git', true)).toBe('rtk git')
    })
  })

  describe('edge cases', () => {
    it('empty command passes through', () => {
      expect(wrapWithRtk('', true)).toBe('')
    })
    it('whitespace-only command passes through', () => {
      expect(wrapWithRtk('   ', true)).toBe('   ')
    })
    it('preserves leading whitespace', () => {
      expect(wrapWithRtk('  git status', true)).toBe('rtk git status')
    })
  })
})

describe('isRoutableCandidate', () => {
  describe('the leading word decides a single command', () => {
    it('accepts a plausible executable', () => {
      expect(isRoutableCandidate('ls -la')).toBe(true)
      expect(isRoutableCandidate('tree')).toBe(true)
      expect(isRoutableCandidate('FOO=bar git status')).toBe(true)
    })
    it('declines a bare builtin', () => {
      expect(isRoutableCandidate('cd /tmp')).toBe(false)
      expect(isRoutableCandidate('echo hi')).toBe(false)
      expect(isRoutableCandidate('export A=1')).toBe(false)
    })
    it('declines an empty command', () => {
      expect(isRoutableCandidate('')).toBe(false)
      expect(isRoutableCandidate('   ')).toBe(false)
    })
  })

  describe('every segment is considered, not just the leading one', () => {
    // `cd repo && <tool>` is the shape an agent writes most often; rtk rewrites
    // it to `cd repo && rtk <tool>`, so judging only `cd` would lose the rewrite.
    it('accepts a routable segment behind cd', () => {
      expect(isRoutableCandidate('cd /tmp && ls -la')).toBe(true)
      expect(isRoutableCandidate('cd repo; cargo test')).toBe(true)
      expect(isRoutableCandidate('cd repo && git status || echo failed')).toBe(true)
    })
    it('accepts a routable segment behind a pipeline stage', () => {
      expect(isRoutableCandidate('ls -la | head -3')).toBe(true)
      expect(isRoutableCandidate('echo hi | grep h')).toBe(true)
    })
    it('declines when every segment is a builtin', () => {
      expect(isRoutableCandidate('cd a; echo b')).toBe(false)
      expect(isRoutableCandidate('for f in *; do echo $f; done')).toBe(false)
      expect(isRoutableCandidate('true && false')).toBe(false)
    })
  })

  describe('redirects are not segment boundaries', () => {
    it('does not fabricate a command out of an fd redirect', () => {
      // `2>&1` must not split into `... 2>` + `1`, which would look routable.
      expect(isRoutableCandidate('echo hi 2>&1')).toBe(false)
      expect(isRoutableCandidate('echo hi &> out.txt')).toBe(false)
    })
    it('still accepts a routable command that carries a redirect', () => {
      expect(isRoutableCandidate('ls -la 2>&1')).toBe(true)
    })
  })
})
