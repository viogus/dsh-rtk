#!/usr/bin/env node
/**
 * Grant `rtk`'s state directory a write exemption inside the macOS Seatbelt
 * profile that `workspace-write` sessions run under.
 *
 * Why this exists: rtk records savings in `~/Library/Application Support/rtk`
 * and keeps recall/tee backups beside it. A `workspace-write` session confines
 * commands to the workspace plus the platform temp area, so every rtk write is
 * denied — silently. Compression still works; the stats, the recall DB and the
 * tee backups do not.
 *
 * This patch adds exactly one path to the Seatbelt grant list, in the profile
 * builder of `@deepseek-ai/dsh-sandbox-local`, and nothing else. The in-process
 * filesystem fence (`@deepseek-ai/dsh-fs-sandbox`) is untouched: this widens
 * what a *shell command* may write, not what `read`/`write`/`edit` may touch.
 *
 * Usage:
 *   node scripts/allow-rtk-state-in-sandbox.mjs status
 *   node scripts/allow-rtk-state-in-sandbox.mjs apply
 *   node scripts/allow-rtk-state-in-sandbox.mjs revert
 *   node scripts/allow-rtk-state-in-sandbox.mjs apply --file <path to dsh-sandbox-local/lib/index.js>
 *
 * `apply` is idempotent, backs the file up next to itself, refuses to guess
 * when the target function no longer looks the way it expects, and ends with a
 * real `sandbox-exec` write test. A harness restart is required for the running
 * app to pick the change up.
 *
 * Re-run `status` after an app update: an update can reinstall the package and
 * drop the patch. `apply` puts it back.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const MARK_BEGIN = '// BEGIN dsh-rtk sandbox grant'
const MARK_END = '// END dsh-rtk sandbox grant'

/** rtk's fixed macOS state directory (history.db, recall.db, tee/). */
const RTK_STATE_DIR = join(homedir(), 'Library', 'Application Support', 'rtk')

/** The exact line the grant is inserted after, inside `seatbeltProfileArgs`. */
const ANCHOR = '\tconst roots = writableRoots(policy);'

/** The import line that must gain `homedir`. */
const OS_IMPORT = 'import { tmpdir } from "node:os";'
const OS_IMPORT_PATCHED = 'import { homedir, tmpdir } from "node:os";'

/**
 * Recursively find `@deepseek-ai/dsh-sandbox-local/lib/index.js` below `root`.
 * @param {string} root - directory to walk.
 * @param {number} depth - remaining levels to descend.
 * @returns {string[]} absolute candidate paths.
 */
function findUnder(root, depth = 7) {
  /** @type {string[]} */
  const found = []
  if (depth < 0) return found
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') {
      if (entry.isDirectory() && entry.name === 'node_modules') {
        const candidate = join(root, entry.name, '@deepseek-ai', 'dsh-sandbox-local', 'lib', 'index.js')
        if (existsSync(candidate)) found.push(candidate)
      }
      continue
    }
    found.push(...findUnder(join(root, entry.name), depth - 1))
  }
  return found
}

/**
 * Locate every dsh-sandbox-local profile builder this machine can boot from.
 * @returns {string[]} absolute candidate paths, most likely first.
 */
function locateTargets() {
  /** @type {string[]} */
  const candidates = []
  const appRoot = join(homedir(), 'Library', 'Application Support', 'dsh-tauri', 'dependencies')
  if (existsSync(appRoot)) candidates.push(...findUnder(appRoot))
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  for (const root of [join(home, 'profiles'), join(home, 'dependencies')]) {
    if (existsSync(root)) candidates.push(...findUnder(root))
  }
  // Profile packages are often symlinks into the same install; patch each file once.
  return [...new Set(candidates.map((candidate) => realpathSync(candidate)))]
}

/**
 * Pick the single file to patch.
 * @param {string[]} argv - command line without node/script.
 * @returns {string} absolute path.
 */
function resolveTarget(argv) {
  const flag = argv.indexOf('--file')
  if (flag !== -1) {
    const value = argv[flag + 1]
    if (value === undefined) throw new Error('--file needs a path')
    return value
  }
  const targets = locateTargets()
  if (targets.length === 0) throw new Error('no @deepseek-ai/dsh-sandbox-local/lib/index.js found')
  if (targets.length > 1) {
    throw new Error(`found ${targets.length} copies; pick one with --file:\n${targets.map((t) => `  ${t}`).join('\n')}`)
  }
  return targets[0]
}

/**
 * @param {string} file - patched file path.
 * @returns {boolean} whether the grant is present.
 */
function isApplied(file) {
  return readFileSync(file, 'utf8').includes(MARK_BEGIN)
}

/**
 * @param {string} file - patched file path.
 * @returns {string[]} backup paths, newest last.
 */
function backupsOf(file) {
  const dir = dirname(file)
  const base = 'index.js.dsh-rtk.bak-'
  return readdirSync(dir)
    .filter((name) => name.startsWith(base))
    .sort()
    .map((name) => join(dir, name))
}

/**
 * Explain the current state without changing anything.
 * @param {string} file - patched file path.
 */
function status(file) {
  const applied = isApplied(file)
  const backups = backupsOf(file)
  const mtime = statSync(file).mtime.toISOString()
  console.log(`file:    ${file}`)
  console.log(`mtime:   ${mtime}`)
  console.log(`grant:   ${applied ? 'present' : 'absent'}`)
  console.log(`backups: ${backups.length === 0 ? 'none' : backups.map((b) => b.split('/').pop()).join(', ')}`)
  console.log(`state:   ${RTK_STATE_DIR} (${existsSync(RTK_STATE_DIR) ? 'exists' : 'missing'})`)
  if (!applied && backups.length > 0) {
    console.log('note:    a backup exists but the grant is gone — an app update likely reinstalled the package. Re-run `apply`.')
  }
}

/**
 * Insert the grant after the writable-roots anchor.
 * @param {string} file - patched file path.
 */
function apply(file) {
  if (isApplied(file)) {
    console.log('already applied — nothing to do')
    return
  }
  let source = readFileSync(file, 'utf8')

  if (!source.includes(ANCHOR)) throw new Error(`anchor line not found in ${file}; refusing to patch a shape this script does not recognise`)
  if (source.split(ANCHOR).length !== 2) throw new Error(`anchor line appears more than once in ${file}; refusing to guess`)

  if (!/import\s*\{[^}]*\bhomedir\b[^}]*\}\s*from\s*"node:os"/.test(source)) {
    if (!source.includes(OS_IMPORT)) throw new Error('node:os import line not found; refusing to patch')
    source = source.replace(OS_IMPORT, OS_IMPORT_PATCHED)
  }

  const block = [
    ANCHOR,
    `\t${MARK_BEGIN} — see dsh-rtk/scripts/allow-rtk-state-in-sandbox.mjs`,
    '\tconst __rtkStateDir = canonicalPath(join(homedir(), "Library", "Application Support", "rtk"));',
    '\tif (existsSync(__rtkStateDir) && !roots.includes(__rtkStateDir)) roots.push(__rtkStateDir);',
    `\t${MARK_END}`,
  ].join('\n')

  mkdirSync(RTK_STATE_DIR, { recursive: true })
  const backup = `${file}.dsh-rtk.bak-${new Date().toISOString().replaceAll(':', '-')}`
  copyFileSync(file, backup)
  writeFileSync(file, source.replace(ANCHOR, block))
  console.log(`patched: ${file}`)
  console.log(`backup:  ${backup}`)

  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  console.log('syntax:  ok')
  verifySeatbelt()
  console.log('done — restart the harness for the running app to pick this up')
}

/**
 * Prove the added subpath actually permits an rtk write under Seatbelt.
 *
 * Runs the same profile shape the patched builder emits — deny all writes, then
 * allow the workspace temp area and rtk's state dir — and checks that running
 * `rtk ls` records a row in the real history database.
 */
function verifySeatbelt() {
  if (process.platform !== 'darwin') {
    console.log('verify:  skipped (Seatbelt is macOS-only)')
    return
  }
  const escape = (value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  // Seatbelt matches canonical spellings; `/tmp` is a symlink on macOS.
  const tempRoot = realpathSync('/tmp')
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (literal ${escape('/dev/null')}) (subpath ${escape(tempRoot)}) (subpath ${escape(RTK_STATE_DIR)}))`,
  ].join(' ')
  const historyDb = join(RTK_STATE_DIR, 'history.db')
  // Count via the CLI so a missing table or schema change reads as "no rows".
  const count = () => {
    try {
      const raw = execFileSync('rtk', ['gain', '--format', 'json'], { encoding: 'utf8', timeout: 10_000 })
      return JSON.parse(raw).summary.total_commands
    } catch {
      return 0
    }
  }
  const before = count()
  execFileSync('sandbox-exec', ['-p', profile, '--', 'rtk', 'ls', '-la', '/tmp'], { stdio: 'ignore', timeout: 15_000 })
  const after = count()
  if (after <= before) {
    throw new Error(`Seatbelt write test failed: history rows ${before} -> ${after}; ${historyDb} still looks read-only`)
  }
  console.log(`verify:  ok (history rows ${before} -> ${after} under the same profile)`)
}

/**
 * Restore the newest backup.
 * @param {string} file - patched file path.
 */
function revert(file) {
  const backups = backupsOf(file)
  if (backups.length === 0) {
    console.log('no backup to restore')
    return
  }
  const newest = backups.at(-1)
  copyFileSync(newest, file)
  console.log(`restored: ${file}`)
  console.log(`from:     ${newest}`)
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  console.log('syntax:  ok')
}

const argv = process.argv.slice(2)
const command = argv[0] ?? 'status'
if (!['status', 'apply', 'revert'].includes(command)) {
  console.error(`unknown command: ${command}\nusage: node scripts/allow-rtk-state-in-sandbox.mjs [status|apply|revert] [--file <path>]`)
  process.exit(2)
}
const target = resolveTarget(argv)
if (command === 'status') status(target)
else if (command === 'apply') apply(target)
else revert(target)
