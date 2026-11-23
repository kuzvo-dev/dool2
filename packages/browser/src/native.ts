// Chrome native messaging format: each message is [4-byte length (this computer's byte order)][JSON UTF-8].
// https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
import { endianness } from 'node:os'

/** Max size of one host → Chrome message (Chrome's rule) */
export const MAX_TO_BROWSER = 1024 * 1024
/** Max size of one Chrome → host message (Chrome's rule, 64 MB). Screenshots come this way */
export const MAX_FROM_BROWSER = 64 * 1024 * 1024

const LE = endianness() === 'LE'

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  if (body.length > MAX_TO_BROWSER) throw new Error('Message to the browser is too large')
  const head = Buffer.alloc(4)
  if (LE) head.writeUInt32LE(body.length)
  else head.writeUInt32BE(body.length)
  return Buffer.concat([head, body])
}

/** Collects chunked input and takes out complete messages */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const out: unknown[] = []
    while (this.buf.length >= 4) {
      const len = LE ? this.buf.readUInt32LE(0) : this.buf.readUInt32BE(0)
      if (len > MAX_FROM_BROWSER) throw new Error('Message from the browser is too large')
      if (this.buf.length < 4 + len) break
      out.push(JSON.parse(this.buf.subarray(4, 4 + len).toString('utf8')))
      this.buf = this.buf.subarray(4 + len)
    }
    return out
  }
}

/** Between the daemon and the host (local socket): one JSON per line */
export class LineReader {
  private rest = ''

  push(chunk: Buffer | string): unknown[] {
    this.rest += chunk.toString()
    if (this.rest.length > MAX_FROM_BROWSER * 2) throw new Error('Message is too large')
    const lines = this.rest.split('\n')
    this.rest = lines.pop() ?? ''
    return lines.filter((l) => l.trim()).map((l) => JSON.parse(l))
  }
}
