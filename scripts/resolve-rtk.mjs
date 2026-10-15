/**
 * Resolve the rtk binary a `test:integration` run should drive, and print its
 * absolute path on stdout.
 *
 * `tests/integration.rtk.spec.ts` skips unless `RTK_INTEGRATION_BIN` names a real
 * rtk, and it checks that with `existsSync`. A bare `rtk` (which is what a user
 * naturally has on PATH) is not a path, so it would be treated as "no binary" —
 * the suite would report 36 skipped and look like a pass. Resolving here keeps
 * the convenience form working without weakening the skip guard.
 *
 * Precedence: `RTK_INTEGRATION_BIN` if it exists → `RTK_INTEGRATION_BIN` looked up
 * on PATH → `rtk` looked up on PATH. Prints whatever it found either way; the
 * spec's own guard is what decides whether tests run.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const requested = process.env['RTK_INTEGRATION_BIN'] || 'rtk'

if (existsSync(requested)) {
  process.stdout.write(requested)
} else {
  try {
    const found = execFileSync('which', [requested], { encoding: 'utf8' }).trim()
    process.stdout.write(found)
  } catch {
    // Nothing found: emit the requested name so the spec's guard skips cleanly
    // rather than failing the run for a machine that simply has no rtk.
    process.stdout.write(requested)
  }
}
