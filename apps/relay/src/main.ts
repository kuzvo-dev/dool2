#!/usr/bin/env node
// 자체 호스팅·개발용 실행: PORT, HOST, DOOL2_PHONE_APP(폰 앱 dist 폴더)
import { fileURLToPath } from 'node:url'
import { startRelay } from './index.js'

const appDir = process.env.DOOL2_PHONE_APP ?? fileURLToPath(new URL('../../phone/dist', import.meta.url))
const relay = await startRelay({
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',
  appDir,
  log: (l) => console.log(`[중계] ${l}`),
})
console.log(`두리 중계 서버: ${relay.url} (폰 앱 ${relay.url}/app/)`)
const stop = () => relay.close().then(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
