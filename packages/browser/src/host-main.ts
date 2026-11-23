#!/usr/bin/env node
// Entry point of the native messaging host Chrome runs. The launch script Dool2 writes (register.ts)
// sets DOOL2_DATA_DIR and starts this file. stdout is the channel to Chrome, so logs go to stderr only.
import { runHost } from './host.js'

const log = (line: string) => process.stderr.write(`[dool2 host] ${line}\n`)
const dataDir = process.env.DOOL2_DATA_DIR
if (!dataDir) {
  log('DOOL2_DATA_DIR is not set. Restart the Dool2 app')
  process.exit(1)
}
await runHost({ dataDir, stdin: process.stdin, stdout: process.stdout, log })
process.exit(0)
