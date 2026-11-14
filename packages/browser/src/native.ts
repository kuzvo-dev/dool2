// Chrome native messaging 형식: 메시지마다 [길이 4바이트(이 컴퓨터 바이트 순서)][JSON UTF-8].
// https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
import { endianness } from 'node:os'

/** 호스트 → Chrome 한 메시지의 최대 크기 (Chrome 규칙) */
export const MAX_TO_BROWSER = 1024 * 1024
/** Chrome → 호스트 한 메시지의 최대 크기 (Chrome 규칙 64MB). 화면 캡처가 이쪽으로 온다 */
export const MAX_FROM_BROWSER = 64 * 1024 * 1024

const LE = endianness() === 'LE'

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  if (body.length > MAX_TO_BROWSER) throw new Error('브라우저로 보낼 메시지가 너무 커요')
  const head = Buffer.alloc(4)
  if (LE) head.writeUInt32LE(body.length)
  else head.writeUInt32BE(body.length)
  return Buffer.concat([head, body])
}

/** 조각난 입력을 모아 완성된 메시지를 꺼낸다 */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const out: unknown[] = []
    while (this.buf.length >= 4) {
      const len = LE ? this.buf.readUInt32LE(0) : this.buf.readUInt32BE(0)
      if (len > MAX_FROM_BROWSER) throw new Error('브라우저에서 온 메시지가 너무 커요')
      if (this.buf.length < 4 + len) break
      out.push(JSON.parse(this.buf.subarray(4, 4 + len).toString('utf8')))
      this.buf = this.buf.subarray(4 + len)
    }
    return out
  }
}

/** 본체 ↔ 호스트 사이(로컬 소켓)는 한 줄에 JSON 하나 */
export class LineReader {
  private rest = ''

  push(chunk: Buffer | string): unknown[] {
    this.rest += chunk.toString()
    if (this.rest.length > MAX_FROM_BROWSER * 2) throw new Error('메시지가 너무 커요')
    const lines = this.rest.split('\n')
    this.rest = lines.pop() ?? ''
    return lines.filter((l) => l.trim()).map((l) => JSON.parse(l))
  }
}
