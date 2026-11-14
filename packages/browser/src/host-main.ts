#!/usr/bin/env node
// Chrome이 실행하는 native messaging 호스트 진입점. 두리가 만든 실행 스크립트(register.ts)가
// DOOL2_DATA_DIR을 정해 이 파일을 띄운다. stdout은 Chrome과의 통로라서 기록은 stderr로만 쓴다.
import { runHost } from './host.js'

const log = (line: string) => process.stderr.write(`[두리 호스트] ${line}\n`)
const dataDir = process.env.DOOL2_DATA_DIR
if (!dataDir) {
  log('DOOL2_DATA_DIR이 없어요. 두리 앱을 다시 켜 주세요')
  process.exit(1)
}
await runHost({ dataDir, stdin: process.stdin, stdout: process.stdout, log })
process.exit(0)
