// 외부 확장 등록: 두리 확장을 Chrome·Edge에 "설치 대기"로 올려 둔다. 브라우저를 다음에 켤 때
// "새 확장 프로그램이 추가됨 · [사용 설정]"이 뜨고, 사용자는 한 번만 누르면 된다.
//   맥:     ~/Library/Application Support/<브라우저>/External Extensions/<id>.json
//           (브라우저 데이터 폴더 안이다. 기본 데이터 폴더를 쓰는 평소 Chrome에 맞는다.
//            2026-11-17 맥 Chrome 157에서 확인: 웹 스토어에서 받아 '사용 설정 대기'로 설치됨)
//            {"external_update_url": "<웹 스토어 업데이트 주소>"}
//   윈도우: <루트>\Software\<브라우저>\Extensions\<id>  값 update_url = <웹 스토어 업데이트 주소>
// - 맥·윈도우는 웹 스토어에 올라간 확장만 이렇게 설치된다 (로컬 crx는 안 됨).
// - 브라우저는 켤 때만 이 등록을 읽는다. 이미 켜져 있으면 다음에 켤 때 뜬다.
// - 사용자가 확장을 지우면 다시 깔지 않는다(브라우저가 막아 둔다). 억지로 되살리지 않는다.
// - 공식 문서는 윈도우에 HKLM만 적어 두었다. 두리는 관리자 권한 없이 깔리므로 HKCU에 쓴다.
//   Chromium은 HKCU도 읽지만 문서에 없으니 윈도우에서 실제로 확인해야 한다 (안 되면 웹 스토어 페이지 [추가]로).
// https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions
// https://learn.microsoft.com/microsoft-edge/extensions/developer-guide/alternate-distribution-options
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { runOnce } from '@dool2/engine'
import { CHROME_STORE_UPDATE_URL } from '@dool2/protocol'
import type { Exec } from './chrome.js'

export type ExternalTarget =
  | { kind: 'file'; browser: string; dir: string; file: string; body: string }
  | { kind: 'reg'; browser: string; key: string; value: string }

/** 브라우저별 외부 확장 등록 위치. Edge도 Chrome 웹 스토어 주소를 받는다 */
export function externalTargets(
  platform: NodeJS.Platform,
  home: string,
  id: string,
  updateUrl = CHROME_STORE_UPDATE_URL,
): ExternalTarget[] {
  if (!/^[a-p]{32}$/.test(id)) throw new Error(`확장 id 형식이 아니에요: ${id}`)
  if (platform === 'win32')
    return [
      { browser: 'Chrome', path: 'Google\\Chrome' },
      { browser: 'Edge', path: 'Microsoft\\Edge' },
    ].map(({ browser, path }) => ({
      kind: 'reg',
      browser,
      key: `HKCU\\Software\\${path}\\Extensions\\${id}`,
      value: updateUrl,
    }))
  if (platform === 'darwin') {
    const base = posix.join(home, 'Library', 'Application Support')
    const body = `${JSON.stringify({ external_update_url: updateUrl })}\n`
    return [
      { browser: 'Chrome', dir: 'Google/Chrome' },
      { browser: 'Edge', dir: 'Microsoft Edge' },
    ].map(({ browser, dir }) => {
      const d = posix.join(base, dir, 'External Extensions')
      return { kind: 'file', browser, dir: d, file: posix.join(d, `${id}.json`), body }
    })
  }
  // 리눅스는 배포 대상이 아니다 (필요하면 /opt/google/chrome/extensions, 관리자 권한)
  return []
}

export interface ExternalOptions {
  id: string
  platform?: NodeJS.Platform
  home?: string
  exec?: Exec
}

/** 외부 확장으로 등록한다. 몇 번 불러도 같다. 쓴 위치(브라우저 이름)를 돌려준다 */
export async function registerExternalExtension(opts: ExternalOptions): Promise<string[]> {
  const platform = opts.platform ?? process.platform
  const exec = opts.exec ?? ((cmd, args) => runOnce(cmd, args, { timeoutMs: 15_000 }))
  const done: string[] = []
  for (const t of externalTargets(platform, opts.home ?? homedir(), opts.id)) {
    try {
      if (t.kind === 'reg') {
        const r = await exec('reg', ['add', t.key, '/v', 'update_url', '/t', 'REG_SZ', '/d', t.value, '/f'])
        if (r.code !== 0) continue
      } else {
        await mkdir(t.dir, { recursive: true })
        await writeFile(t.file, t.body)
      }
      done.push(t.browser)
    } catch {
      // 한 브라우저에 못 써도 나머지는 계속한다
    }
  }
  return done
}

/** 등록을 지운다 (두리를 지울 때). 이미 설치된 확장은 브라우저가 그대로 둔다 */
export async function unregisterExternalExtension(opts: ExternalOptions): Promise<void> {
  const platform = opts.platform ?? process.platform
  const exec = opts.exec ?? ((cmd, args) => runOnce(cmd, args, { timeoutMs: 15_000 }))
  for (const t of externalTargets(platform, opts.home ?? homedir(), opts.id)) {
    if (t.kind === 'reg') await exec('reg', ['delete', t.key, '/f']).catch(() => undefined)
    else await rm(t.file, { force: true })
  }
}
