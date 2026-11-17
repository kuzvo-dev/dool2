import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHROME_STORE_UPDATE_URL } from '@dool2/protocol'
import { describe, expect, it } from 'vitest'
import { externalTargets, registerExternalExtension, unregisterExternalExtension } from './external.js'

const ID = 'abcdefghijklmnopabcdefghijklmnop'

describe('외부 확장 등록', () => {
  it('맥은 사용자 폴더의 External Extensions에 웹 스토어 주소를 적는다 (Chrome·Edge)', () => {
    const t = externalTargets('darwin', '/Users/a', ID)
    expect(t.map((x) => (x.kind === 'file' ? x.file : ''))).toEqual([
      `/Users/a/Library/Application Support/Google/Chrome/External Extensions/${ID}.json`,
      `/Users/a/Library/Application Support/Microsoft Edge/External Extensions/${ID}.json`,
    ])
    const first = t[0]
    expect(first?.kind === 'file' && JSON.parse(first.body)).toEqual({
      external_update_url: CHROME_STORE_UPDATE_URL,
    })
  })

  it('윈도우는 관리자 권한 없이 사용자 레지스트리(HKCU)에 쓴다', () => {
    const t = externalTargets('win32', 'C:\\Users\\a', ID)
    expect(t).toEqual([
      {
        kind: 'reg',
        browser: 'Chrome',
        key: `HKCU\\Software\\Google\\Chrome\\Extensions\\${ID}`,
        value: CHROME_STORE_UPDATE_URL,
      },
      {
        kind: 'reg',
        browser: 'Edge',
        key: `HKCU\\Software\\Microsoft\\Edge\\Extensions\\${ID}`,
        value: CHROME_STORE_UPDATE_URL,
      },
    ])
  })

  it('확장 id 형식이 아니면 쓰지 않는다 (경로·레지스트리에 이상한 글자가 들어가지 않게)', () => {
    expect(() => externalTargets('darwin', '/Users/a', '../../evil')).toThrow()
  })

  it('맥: 파일을 쓰고 지운다. 몇 번 불러도 같다', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dool2-ext-'))
    expect(await registerExternalExtension({ id: ID, platform: 'darwin', home })).toEqual(['Chrome', 'Edge'])
    expect(await registerExternalExtension({ id: ID, platform: 'darwin', home })).toEqual(['Chrome', 'Edge'])
    const f = join(home, 'Library/Application Support/Google/Chrome/External Extensions', `${ID}.json`)
    expect(JSON.parse(await readFile(f, 'utf8'))).toEqual({ external_update_url: CHROME_STORE_UPDATE_URL })
    await unregisterExternalExtension({ id: ID, platform: 'darwin', home })
    await expect(readFile(f, 'utf8')).rejects.toThrow()
  })

  it('윈도우: reg add로 update_url 값을 쓴다', async () => {
    const calls: string[][] = []
    const exec = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      return { code: 0, stdout: '', stderr: '' }
    }
    expect(
      await registerExternalExtension({ id: ID, platform: 'win32', home: 'C:\\Users\\a', exec }),
    ).toEqual(['Chrome', 'Edge'])
    expect(calls[0]).toEqual([
      'reg',
      'add',
      `HKCU\\Software\\Google\\Chrome\\Extensions\\${ID}`,
      '/v',
      'update_url',
      '/t',
      'REG_SZ',
      '/d',
      CHROME_STORE_UPDATE_URL,
      '/f',
    ])
  })
})
