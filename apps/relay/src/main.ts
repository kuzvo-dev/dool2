#!/usr/bin/env node
// Self-hosted / dev runner: PORT, HOST, DOOL2_PHONE_APP (phone app dist folder)
import { fileURLToPath } from 'node:url'
import { startRelay } from './index.js'

const appDir = process.env.DOOL2_PHONE_APP ?? fileURLToPath(new URL('../../phone/dist', import.meta.url))
const relay = await startRelay({
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',
  appDir,
  log: (l) => console.log(`[relay] ${l}`),
})
console.log(`Dool2 relay: ${relay.url} (phone app ${relay.url}/app/)`)
const stop = () => relay.close().then(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
