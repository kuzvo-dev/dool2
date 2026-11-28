// How JSON-RPC messages move between the two ends of an MCP connection. The transport is the injection seam: the real
// one frames newline-delimited JSON over a pair of Node streams (the stdio of a CLI-spawned child, or a socket to the
// daemon); tests use an in-memory pair with no I/O at all. Everything above this (server.ts, client.ts) is transport-
// agnostic, so the same server code is exercised by a fake transport in a unit test and by a real CLI in production.

import type { Readable, Writable } from 'node:stream'
import type { JsonRpcMessage } from './jsonrpc.js'

/** One end of a bidirectional JSON-RPC channel. `onMessage` is called for each inbound message; `send` writes one. */
export interface McpTransport {
  send(message: JsonRpcMessage): void
  /** Register the inbound handler. Called at most once by the server/client; replaces any previous handler. */
  onMessage(handler: (message: JsonRpcMessage) => void): void
  /** Called when the peer closed the channel, so the server/client can stop. Optional for callers. */
  onClose(handler: () => void): void
  close(): void
}

/** A linked pair of in-memory transports: whatever one end sends, the other receives. For tests and in-process wiring. */
export interface TransportPair {
  client: McpTransport
  server: McpTransport
}

class MemoryTransport implements McpTransport {
  #inbound: ((m: JsonRpcMessage) => void) | undefined
  #closed: (() => void) | undefined
  #peer: MemoryTransport | undefined
  #isClosed = false

  link(peer: MemoryTransport): void {
    this.#peer = peer
  }

  send(message: JsonRpcMessage): void {
    if (this.#isClosed) return
    const peer = this.#peer
    if (!peer) return
    // Deliver asynchronously so a send during message handling cannot re-enter the handler synchronously.
    queueMicrotask(() => peer.#deliver(message))
  }

  #deliver(message: JsonRpcMessage): void {
    if (this.#isClosed) return
    this.#inbound?.(message)
  }

  onMessage(handler: (m: JsonRpcMessage) => void): void {
    this.#inbound = handler
  }

  onClose(handler: () => void): void {
    this.#closed = handler
  }

  close(): void {
    if (this.#isClosed) return
    this.#isClosed = true
    const peer = this.#peer
    if (peer && !peer.#isClosed) queueMicrotask(() => peer.#remoteClosed())
  }

  #remoteClosed(): void {
    if (this.#isClosed) return
    this.#isClosed = true
    this.#closed?.()
  }
}

/** Build two linked in-memory transports. No serialization, no I/O: messages pass by reference through a microtask. */
export function inMemoryTransportPair(): TransportPair {
  const client = new MemoryTransport()
  const server = new MemoryTransport()
  client.link(server)
  server.link(client)
  return { client, server }
}

/**
 * A transport that frames newline-delimited JSON-RPC over a readable/writable pair. This is the real stdio shape MCP
 * uses (one message per line), and it works just as well over a socket. A line that is not valid JSON is dropped
 * (matching how the CLI brains skip a stray log line), so a peer's debug output never crashes the channel.
 */
export function nodeStreamTransport(input: Readable, output: Writable): McpTransport {
  let inbound: ((m: JsonRpcMessage) => void) | undefined
  let closed: (() => void) | undefined
  let buf = ''
  let isClosed = false

  input.setEncoding('utf8')
  input.on('data', (chunk: string) => {
    buf += chunk
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (line.trim()) {
        try {
          inbound?.(JSON.parse(line) as JsonRpcMessage)
        } catch {
          // Not JSON — a stray log line. Drop it.
        }
      }
      nl = buf.indexOf('\n')
    }
  })
  const onEnd = (): void => {
    if (isClosed) return
    isClosed = true
    closed?.()
  }
  input.on('end', onEnd)
  input.on('close', onEnd)

  return {
    send(message: JsonRpcMessage): void {
      if (isClosed) return
      output.write(`${JSON.stringify(message)}\n`)
    },
    onMessage(handler) {
      inbound = handler
    },
    onClose(handler) {
      closed = handler
    },
    close(): void {
      if (isClosed) return
      isClosed = true
      // Do not destroy process.stdout; only end a stream we own. The caller decides; here we just stop writing.
    },
  }
}
