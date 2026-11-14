#!/usr/bin/env node
// 개발용 단독 실행: `pnpm dev:daemon`. PC 앱에서는 Electron이 startDaemon()을 직접 부른다.
import { startDaemon } from './index.js'

const daemon = await startDaemon({ port: Number(process.env.DOOL2_PORT ?? 0) })
console.log(`dool2d 실행 중: ${daemon.url}`)
console.log(`토큰: ${daemon.token}`)

const stop = () => daemon.close().then(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
