/**
 * The line-delimited JSON command loop, identical to @dool2/hands-mac:
 *
 *   → {"id":1,"cmd":"snapshot","args":{"bundleId":"slack.exe"}}
 *   ← {"id":1,"ok":true,"result":{…}}      or      {"id":1,"ok":false,"error":"…"}
 *
 * One request object per line in; one response object per line out. The daemon starts the helper as a child process and
 * drives it over stdin/stdout. `dispatch` is pure (string in, string-or-null out) so the whole loop is unit-tested
 * without a real process; cli.ts just wires it to stdin/stdout.
 */
import { Hands } from './hands.js'
import { MSG } from './locales/messages.js'
import { HandsError } from './safety.js'

export interface HandsRequest {
  id: unknown
  cmd: string
  args?: Record<string, unknown>
}

export interface HandsResponse {
  id: unknown
  ok: boolean
  result?: unknown
  error?: string
}

function serialize(res: HandsResponse): string {
  return JSON.stringify(res)
}

/**
 * Handle one input line. Returns the JSON response line, or null for a blank line (which the loop ignores, like a
 * keep-alive newline). A malformed line gets a clean error response rather than being dropped.
 */
export async function dispatch(hands: Hands, line: string): Promise<string | null> {
  const trimmed = line.trim()
  if (!trimmed) return null

  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return serialize({ id: null, ok: false, error: MSG.badJson })
  }
  if (typeof obj !== 'object' || obj === null) {
    return serialize({ id: null, ok: false, error: MSG.notAnObject })
  }
  const req = obj as Partial<HandsRequest>
  const id = 'id' in req ? req.id : null
  if (typeof req.cmd !== 'string' || !req.cmd) {
    return serialize({ id, ok: false, error: MSG.noCmd })
  }
  const args = typeof req.args === 'object' && req.args !== null ? req.args : {}
  try {
    const result = await hands.run(req.cmd, args)
    return serialize({ id, ok: true, result })
  } catch (e) {
    const error = e instanceof HandsError ? e.message : e instanceof Error ? e.message : String(e)
    return serialize({ id, ok: false, error })
  }
}

/**
 * Drive the command loop over an async line source, writing each response with `write`. Resolves when the input ends
 * (the daemon closed stdin). Exposed for cli.ts and testable with a fake source.
 */
export async function runLoop(
  hands: Hands,
  lines: AsyncIterable<string>,
  write: (line: string) => void,
): Promise<void> {
  for await (const line of lines) {
    const res = await dispatch(hands, line)
    if (res !== null) write(res)
  }
}

export { Hands }
