// Native messaging host: a small program Chrome starts when the Dool2 extension asks.
// It makes no decisions; it only relays Chrome (stdin/stdout, length + JSON) ↔ the Dool2 daemon (local socket, one JSON per line).
import { readFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { BRIDGE_FILE, type BridgeInfo } from './bridge.js'
import { encodeFrame, FrameReader, LineReader } from './native.js'

export interface HostOptions {
  dataDir: string
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  /** How long to wait if the Dool2 daemon isn't up yet */
  waitMs?: number
  log?: (line: string) => void
}

/** Returns when it ends (either side closes) */
export async function runHost(opts: HostOptions): Promise<void> {
  const log = opts.log ?? (() => {})
  const sock = await connectDaemon(opts.dataDir, opts.waitMs ?? 10_000)
  if (!sock) {
    log("couldn't connect to the Dool2 daemon")
    // Tell the extension and stop. The extension retries a bit later
    opts.stdout.write(encodeFrame({ event: 'daemon-offline' }))
    return
  }
  log('connected to the Dool2 daemon')

  await new Promise<void>((resolve) => {
    const fromBrowser = new FrameReader()
    const fromDaemon = new LineReader()
    const finish = () => {
      sock.destroy()
      resolve()
    }
    opts.stdin.on('data', (chunk: Buffer) => {
      try {
        for (const msg of fromBrowser.push(chunk)) sock.write(`${JSON.stringify(msg)}\n`)
      } catch (e) {
        log(`couldn't read a browser message: ${(e as Error).message}`)
        finish()
      }
    })
    sock.on('data', (chunk) => {
      try {
        for (const msg of fromDaemon.push(chunk)) opts.stdout.write(encodeFrame(msg))
      } catch (e) {
        log(`couldn't relay a daemon message: ${(e as Error).message}`)
        finish()
      }
    })
    opts.stdin.on('end', finish)
    sock.on('close', finish)
    sock.on('error', finish)
  })
}

async function connectDaemon(dataDir: string, waitMs: number): Promise<Socket | undefined> {
  const until = Date.now() + waitMs
  for (;;) {
    const sock = await tryConnect(dataDir)
    if (sock) return sock
    if (Date.now() >= until) return undefined
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function tryConnect(dataDir: string): Promise<Socket | undefined> {
  let info: BridgeInfo
  try {
    info = JSON.parse(await readFile(join(dataDir, BRIDGE_FILE), 'utf8'))
  } catch {
    return undefined
  }
  return new Promise((resolve) => {
    const sock = connect(info.socket)
    sock.once('connect', () => {
      sock.write(`${JSON.stringify({ token: info.token })}\n`)
      resolve(sock)
    })
    sock.once('error', () => resolve(undefined))
  })
}
