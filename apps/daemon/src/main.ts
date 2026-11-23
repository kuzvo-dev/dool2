#!/usr/bin/env node
// Standalone run for development: `pnpm dev:daemon`. In the desktop app, Electron calls startDaemon() directly.
import { startDaemon } from './index.js'

const daemon = await startDaemon({ port: Number(process.env.DOOL2_PORT ?? 0) })
console.log(`dool2d running: ${daemon.url}`)
console.log(`token: ${daemon.token}`)

const stop = () => daemon.close().then(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
