#!/usr/bin/env node
// The hands-win entry point: the Dool2 daemon starts this as a child process and drives it with one-line JSON over
// stdin/stdout (see protocol.ts), exactly as it drives the macOS helper. It picks the native UI Automation backend
// (the Windows-only seam, src/native-backend.ts) at runtime; with DOOL2_HANDS_FAKE=1 it uses the in-memory fake so the
// whole loop runs offline on any platform for a smoke.
import { createInterface } from 'node:readline'
import type { UiaBackend } from './backend.js'
import { Hands } from './hands.js'
import { makeFakeUiaBackend } from './in-memory-backend.js'
import { runLoop } from './protocol.js'

function hasFactory(m: unknown): m is { createNativeUiaBackend(): UiaBackend } {
  return typeof (m as { createNativeUiaBackend?: unknown }).createNativeUiaBackend === 'function'
}

async function chooseBackend(): Promise<UiaBackend> {
  if (process.env.DOOL2_HANDS_FAKE === '1') return makeFakeUiaBackend()
  // Resolved at runtime (not a static import) so the helper builds and type-checks without the Windows-only backend.
  try {
    const mod: unknown = await import(new URL('./native-backend.js', import.meta.url).href)
    if (hasFactory(mod)) return mod.createNativeUiaBackend()
  } catch {
    // fall through to the clear error below
  }
  throw new Error(
    'hands-win needs the native Windows UI Automation backend (src/native-backend.ts), which is built only on ' +
      'Windows. Set DOOL2_HANDS_FAKE=1 to run the in-memory fake for an offline smoke.',
  )
}

async function main(): Promise<void> {
  const backend = await chooseBackend()
  const hands = new Hands(backend)
  const rl = createInterface({ input: process.stdin })
  async function* lines(): AsyncIterable<string> {
    for await (const line of rl) yield line
  }
  await runLoop(hands, lines(), (out) => process.stdout.write(`${out}\n`))
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
