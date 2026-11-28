// The real process wiring, kept behind the SpawnCli / WhichFn types so tests never spawn an actual CLI. The default
// spawner starts the official binary, writes the prompt to stdin and closes it, and reads stdout as NDJSON lines.
// Nothing here sets a user agent or a client id; the official CLI runs unmodified and owns its own auth.

import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { CliExit, CliProcess, SpawnCli, WhichFn } from './types.js'

const IS_WIN = process.platform === 'win32'

/**
 * Finds an executable without running it. GUI apps often do not inherit the shell PATH (especially on macOS), so the
 * common install locations are checked alongside PATH. Offline-safe: it only touches the filesystem.
 */
export const which: WhichFn = async (name) => {
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : ['']
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter),
    join(homedir(), '.local', 'bin'),
    ...(IS_WIN ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']),
  ].filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = join(dir, name + ext)
      try {
        await access(p, IS_WIN ? constants.F_OK : constants.X_OK)
        return p
      } catch {}
    }
  }
  return undefined
}

/** Starts the CLI, writes the prompt to stdin (then closes it), and reads stdout line by line (NDJSON). */
export const defaultSpawn: SpawnCli = (command, args, opts): CliProcess => {
  const child = spawn(command, args, {
    env: opts.env ?? process.env,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderrTail = ''
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    stderrTail = (stderrTail + d).slice(-4000)
  })
  // Writing to a child that already ended must not crash the daemon.
  child.stdin.on('error', () => {})
  if (opts.stdin !== undefined) child.stdin.end(opts.stdin, 'utf8')
  else child.stdin.end()

  const onAbort = () => child.kill()
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  const exit = new Promise<CliExit>((resolve) => {
    child.on('error', (err) => {
      stderrTail += `\n${err.message}`
      resolve({ code: -1, stderrTail })
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code, stderrTail })
    })
  })

  async function* lines(): AsyncGenerator<string> {
    let buf = ''
    child.stdout.setEncoding('utf8')
    for await (const chunk of child.stdout as AsyncIterable<string>) {
      buf += chunk
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (line.trim()) yield line
        nl = buf.indexOf('\n')
      }
    }
    if (buf.trim()) yield buf
  }

  return { lines: lines(), exit, kill: () => child.kill() }
}
