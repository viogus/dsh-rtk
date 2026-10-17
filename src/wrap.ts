/**
 * Command routing policy for the rtk (Rust Token Killer) bash executors.
 *
 * The decision itself is **not** made here. rtk owns the mapping from a shell
 * command to its optimized equivalent and exposes it as `rtk rewrite`; this
 * module supplies the cheap pre-filter that keeps the plugin from paying for a
 * subprocess on every command, plus the legacy pure transform.
 *
 * ## Delegation
 *
 * {@link applyRtkRewrite} hands the command to `rtk rewrite` and uses whatever
 * rtk prints. Wrapping is a best-effort token optimization, never a semantic
 * change: a command rtk does not rewrite runs exactly as it was written.
 * Because the mapping lives in rtk, a new rtk release teaches the plugin new
 * commands with no plugin release.
 *
 * ## What is deliberately *not* filtered
 *
 * An earlier revision refused to route any command containing a shell
 * metacharacter, on the theory that wrapping would change what runs. rtk does
 * not wrap the whole string — it lexes it and rewrites the individual segments
 * it recognizes, preserving pipes, lists and redirections verbatim:
 *
 * ```
 * git status | grep modified   →  git status | rtk grep modified
 * npm install && npm run build →  npm install && rtk npm run build
 * git status; rm -rf /         →  rtk git status; rm -rf /   (tail untouched)
 * git log > /tmp/x             →  (declined; the redirect owns the output)
 * ```
 *
 * Pre-filtering on metacharacters would therefore only discard safe
 * optimizations. The filter that remains is {@link isRoutableCandidate}, which
 * asks only "could the first word of this command name an executable rtk knows
 * about" — and it errs toward yes.
 *
 * @module @viogus/dsh-rtk/wrap
 */

import { runRtkRewrite } from './rtk.ts'

/** A command that opens with an operator (`| foo`, `&& bar`) has no first word to match. */
const SHELL_OPERATOR = /^[|&;<>()]/

/**
 * Shell keywords that can occupy a command's first word but never name an
 * executable rtk could rewrite.
 */
const SHELL_KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'select',
  'coproc',
])

/**
 * Shell builtins and everyday inspection commands that rtk has no rule for.
 *
 * This is a cost filter, not a policy: every entry was verified against rtk
 * 1.0.1 to be declined by `rtk rewrite` both bare and with arguments, so
 * nothing here can suppress a rewrite. It earns its place because these are the
 * commands an agent runs most often, and each one skipped is one subprocess not
 * spent.
 *
 * Four commands that look like they belong here deliberately do not:
 * `nohup`, `command`, `builtin` and `exec` are prefixes rtk peels
 * (`nohup git status` → `nohup rtk git status`), and `time`, `timeout` and
 * `nice` are peeled the same way. Filtering any of them would lose a real
 * rewrite.
 */
const NON_ROUTABLE_EXACT: ReadonlySet<string> = new Set([
  'cd',
  'echo',
  'pwd',
  'true',
  'false',
  'wait',
  'export',
  'unset',
  'set',
  'shift',
  'trap',
  'type',
  'hash',
  'ulimit',
  'umask',
  'printf',
  'read',
  'sleep',
  'kill',
  'jobs',
  'bg',
  'fg',
  'alias',
])

/** `FOO=bar cmd` — rtk rewrites the command word and leaves the assignment in place. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Split a command into shell words, honouring simple single/double quotes. */
function shellWords(command: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: string | null = null
  for (const char of command.trimStart()) {
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current !== '') {
        words.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current !== '') words.push(current)
  return words
}

/**
 * Split a command into top-level segments at the shell's control operators —
 * `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines — honouring simple quoting.
 *
 * Redirect operators are *not* split points: `2>&1` and `&>file` are part of
 * the command they redirect, and splitting them would fabricate a segment that
 * starts with a descriptor number. Only the command position after a real
 * control operator opens a new segment, which is exactly the position rtk's own
 * rewrite considers a command.
 *
 * @param command - raw shell source.
 * @returns trimmed, non-empty segments in source order.
 */
function commandSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: string | null = null
  const flush = () => {
    const trimmed = current.trim()
    if (trimmed !== '') segments.push(trimmed)
    current = ''
  }
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote !== null) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === ';' || char === '\n') {
      flush()
      continue
    }
    if (char === '&') {
      const previous = current.slice(-1)
      if (previous === '>' || previous === '<' || command[index + 1] === '>') {
        // `2>&1`, `<&0`, `&>file` — a redirect, not a separator.
        current += char
        continue
      }
      flush()
      if (command[index + 1] === '&') index += 1
      continue
    }
    if (char === '|') {
      flush()
      const next = command[index + 1]
      if (next === '|' || next === '&') index += 1
      continue
    }
    current += char
  }
  flush()
  return segments
}

/** True when one segment opens with a word rtk could plausibly route. */
function segmentIsRoutable(segment: string): boolean {
  const words = shellWords(segment)
  if (words.length === 0) return false
  let index = 0
  while (index < words.length && ASSIGNMENT.test(words[index] ?? '')) index += 1
  const first = words[index]
  if (first === undefined) return false
  if (SHELL_OPERATOR.test(first)) return false
  const lower = first.toLowerCase()
  if (SHELL_KEYWORDS.has(lower)) return false
  return !NON_ROUTABLE_EXACT.has(lower)
}

/**
 * Cheap pre-filter: true when the command contains a command position whose
 * word could plausibly name an executable rtk knows, so the probe is worth
 * spending.
 *
 * This intentionally over-accepts. A false positive costs one ~11 ms probe; a
 * false negative silently loses a token optimization. Anything not provably
 * unroutable is handed to rtk to decide.
 *
 * Every segment is considered, not just the leading word. `cd repo && cargo
 * test` is the shape an agent writes most often, and rtk rewrites it to
 * `cd repo && rtk cargo test`; judging only the first word (`cd`) would skip the
 * whole command. A segment whose first word is a builtin still does not make the
 * command routable on its own — `cd /tmp` alone stays untouched.
 *
 * Process wrappers (`sudo`, `env`, `docker exec`, `uv run`, `poetry run`, …) are
 * *not* filtered: rtk peels them and may still rewrite the command underneath.
 *
 * @param command - raw shell source.
 * @returns true when `rtk rewrite` should be consulted.
 */
export function isRoutableCandidate(command: string): boolean {
  return commandSegments(command).some(segmentIsRoutable)
}

/**
 * The legacy static transform, kept so existing importers keep compiling.
 *
 * It cannot delegate: its second parameter is a boolean availability flag, not
 * an executor, so it has no budget to spawn rtk with. It therefore keeps the
 * old shape — prefix a single executable word with `rtk`, and decline anything
 * a static check cannot prove safe:
 *
 * - any shell metacharacter (`| & ; < > \` $`), so compound commands and
 *   substitutions are untouched;
 * - a leading `NAME=value` assignment or `sudo`, because inserting `rtk` at the
 *   front would make it an argument of the wrong program (or a syntax error);
 * - commands {@link isRoutableCandidate} rules out as a cheap cost filter.
 *
 * New code should call {@link applyRtkRewrite}, which delegates every one of
 * these cases to rtk and therefore handles assignments, wrappers and compound
 * commands correctly.
 *
 * @param command - the raw shell command.
 * @param rtkAvailable - whether the `rtk` binary resolved on PATH.
 * @returns the command to execute (possibly wrapped).
 * @deprecated Use {@link applyRtkRewrite}, which delegates the decision to rtk.
 */
export function wrapWithRtk(command: string, rtkAvailable: boolean): string {
  if (!rtkAvailable) return command
  if (command === '' || /[|&;<>`$]/.test(command)) return command
  const words = shellWords(command)
  const executable = words[0]
  if (executable === undefined) return command
  if (ASSIGNMENT.test(executable) || executable.toLowerCase() === 'sudo') return command
  if (!isRoutableCandidate(command)) return command
  const offset = command.length - command.trimStart().length
  const at = command.indexOf(executable, offset)
  const rest = command.slice(at + executable.length)
  return `rtk ${executable}${rest}`
}

export { runRtkRewrite }
