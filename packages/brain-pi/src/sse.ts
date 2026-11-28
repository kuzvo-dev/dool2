// A tiny Server-Sent-Events reader. Both the Anthropic and the OpenAI-compatible streams send one JSON object per
// `data:` line; this reads a byte stream, splits it into lines, and yields each parsed JSON payload. It never
// throws on a half line or on malformed JSON — it just skips what it cannot parse and waits for the next line.

function parseDataLine(line: string): unknown {
  if (!line.startsWith('data:')) return undefined
  const payload = line.slice('data:'.length).trim()
  if (!payload || payload === '[DONE]') return undefined
  try {
    return JSON.parse(payload)
  } catch {
    return undefined
  }
}

export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        const data = parseDataLine(line)
        if (data !== undefined) yield data
        nl = buf.indexOf('\n')
      }
    }
    const last = buf.trim()
    if (last) {
      const data = parseDataLine(last)
      if (data !== undefined) yield data
    }
  } finally {
    reader.releaseLock()
  }
}
