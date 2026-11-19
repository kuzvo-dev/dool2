// 휴지통에서 찾기·되살리기 (ADR 0024 추가). 휴지통 비우기·영구 삭제는 만들지 않는다.
// - 맥: ~/.Trash. 원래 자리는 휴지통의 .DS_Store에 Finder가 적어 둔 ptbL(폴더)·ptbN(이름)으로 안다.
//   두리에게 전체 디스크 접근 권한이 없으면 맥이 휴지통 읽기를 막는다(EPERM) → 이유와 다음 길
// - 윈도우: 셸의 휴지통(Shell.Application Namespace 10). 원래 자리는 System.Recycle.DeletedFrom
import { existsSync } from 'node:fs'
import { readdir, readFile, rename, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { Exec } from './file-ops.js'

export interface TrashItem {
  /** 휴지통 안의 이름 (맥: ~/.Trash의 파일 이름, 윈도우: $R… 이름). 되살릴 때 이걸로 고른다 */
  id: string
  /** 원래 이름 */
  name: string
  /** 원래 있던 폴더 (모르면 없음) */
  from?: string
  /** 지운 때(ms, 대강) */
  at?: number
  size?: number
  dir?: boolean
}

export interface TrashContext {
  platform: NodeJS.Platform
  exec: Exec
  home: string
}

/** 휴지통을 못 읽을 때 사용자에게 전할 말 */
export const MAC_TRASH_BLOCKED =
  '맥이 휴지통 읽기를 막고 있어요(두리에게 "전체 디스크 접근 권한"이 없어요). 지금은 Dock 끝의 휴지통을 열어 파일을 오른쪽 클릭 > "되돌려 놓기"를 눌러 달라고 안내해 주세요. ' +
  '두리가 직접 찾고 되살리게 하려면 시스템 설정 > 개인정보 보호 및 보안 > 전체 디스크 접근 권한에서 두리를 켜면 돼요.'

/** UTF-16BE 글 */
const utf16be = (b: Buffer) => Buffer.from(b).swap16().toString('utf16le')

/**
 * 맥 휴지통 .DS_Store에서 "지운 자리" 기록을 찾는다: 휴지통 안 이름 → { dir: 'Users/me/Documents/', name? }.
 * 기록 모양: [이름 길이 u32][이름 UTF-16BE][코드 4바이트 'ptbL'|'ptbN']['ustr'][값 길이 u32][값 UTF-16BE]
 */
export function putBackInfo(ds: Buffer): Map<string, { dir?: string; name?: string }> {
  const out = new Map<string, { dir?: string; name?: string }>()
  for (const code of ['ptbL', 'ptbN'] as const) {
    const tag = Buffer.from(`${code}ustr`, 'latin1')
    for (let i = ds.indexOf(tag); i >= 0; i = ds.indexOf(tag, i + 8)) {
      if (i + 12 > ds.length) break
      const vlen = ds.readUInt32BE(i + 8)
      if (vlen > 2048 || i + 12 + vlen * 2 > ds.length) continue
      const value = utf16be(ds.subarray(i + 12, i + 12 + vlen * 2))
      // 앞쪽 이름: 길이 k를 1부터 늘려 가며 [k][이름 2k바이트]가 맞는 자리를 찾는다
      let name: string | undefined
      for (let k = 1; k <= 1024; k++) {
        const at = i - 2 * k - 4
        if (at < 0) break
        if (ds.readUInt32BE(at) === k) {
          const n = utf16be(ds.subarray(at + 4, i))
          if (!n.includes('\0')) {
            name = n
            break
          }
        }
      }
      if (!name) continue
      const rec = out.get(name) ?? {}
      if (code === 'ptbL') rec.dir = value
      else rec.name = value
      out.set(name, rec)
    }
  }
  return out
}

/** 휴지통 목록. 못 읽으면 이유(글) */
export async function trashList(ctx: TrashContext): Promise<TrashItem[] | string> {
  if (ctx.platform === 'darwin') {
    const dir = join(ctx.home, '.Trash')
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return []
      if (code === 'EPERM' || code === 'EACCES') return MAC_TRASH_BLOCKED
      throw e
    }
    const info = await readFile(join(dir, '.DS_Store'))
      .then(putBackInfo)
      .catch(() => new Map<string, { dir?: string; name?: string }>())
    const items: TrashItem[] = []
    for (const id of names) {
      if (id.startsWith('.')) continue
      const s = await stat(join(dir, id)).catch(() => undefined)
      const pb = info.get(id) ?? info.get(id.normalize('NFD')) ?? info.get(id.normalize('NFC'))
      items.push({
        id,
        name: pb?.name ?? id,
        ...(pb?.dir ? { from: `/${pb.dir.replace(/^\/+/, '').replace(/\/+$/, '')}` } : {}),
        // 휴지통으로 옮기면 바뀌는 때(ctime)가 지운 때에 가깝다
        ...(s ? { at: s.ctimeMs, size: s.size, dir: s.isDirectory() } : {}),
      })
    }
    return items
  }
  if (ctx.platform === 'win32') {
    const r = await ctx.exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WIN_TRASH_LIST],
      {
        timeout: 30_000,
      },
    )
    if (r.code !== 0 && !r.stdout.trim())
      return `휴지통을 읽지 못했어요: ${r.stderr.split('\n')[0]?.slice(0, 160)}`
    let rows: { id?: string; name?: string; from?: string; at?: string; size?: number; dir?: boolean }[] = []
    try {
      const v = JSON.parse(r.stdout.trim() || '[]')
      rows = Array.isArray(v) ? v : [v]
    } catch {
      return '휴지통 목록을 읽지 못했어요.'
    }
    return rows
      .filter((x) => x.id)
      .map((x) => {
        // 탐색기가 확장자를 숨기면 이름에 확장자가 없다: $R 이름의 확장자를 붙인다
        const ext = /\.[^.\\]+$/.exec(String(x.id))?.[0] ?? ''
        const name = String(x.name ?? x.id)
        return {
          id: String(x.id),
          name: !x.dir && ext && !name.toLowerCase().endsWith(ext.toLowerCase()) ? name + ext : name,
          ...(x.from ? { from: String(x.from) } : {}),
          ...(x.at ? { at: Date.parse(x.at) } : {}),
          ...(typeof x.size === 'number' ? { size: x.size } : {}),
          ...(x.dir ? { dir: true } : {}),
        }
      })
  }
  return '이 PC에서는 아직 휴지통을 못 봐요(맥·윈도우만).'
}

/** 되살리기: 휴지통의 그 항목을 dest 폴더에 name으로 (같은 이름이 없는 것은 부르는 쪽이 정한다) */
export async function trashRestore(
  ctx: TrashContext,
  item: TrashItem,
  dest: string,
  name: string,
): Promise<void> {
  if (ctx.platform === 'darwin') {
    if (item.id.includes('/') || item.id.includes('\\') || item.id === '..')
      throw new Error('휴지통 이름이 이상해요')
    await rename(join(ctx.home, '.Trash', item.id), join(dest, name))
    return
  }
  // 윈도우: 셸로 옮겨야 휴지통 기록도 같이 정리된다. 옮기면 원래 이름으로 나온다(같은 이름이 없는 폴더를 고른다)
  const r = await ctx.exec(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WIN_TRASH_RESTORE],
    {
      timeout: 60_000,
      env: { DOOL2_ID: item.id, DOOL2_DEST: dest },
    },
  )
  if (!r.stdout.includes('ok'))
    throw new Error(r.stdout.includes('missing') ? '휴지통에 없어요' : '되살리지 못했어요')
  for (let i = 0; i < 40 && !existsSync(join(dest, item.name)); i++)
    await new Promise((res) => setTimeout(res, 250))
  if (!existsSync(join(dest, item.name))) throw new Error('되살렸는지 확인하지 못했어요')
  if (item.name !== name) await rename(join(dest, item.name), join(dest, name))
}

/** 경로가 폴더 안인지 (윈도우는 대소문자를 가리지 않는다) */
export function under(p: string, root: string, win: boolean) {
  const a = win ? p.toLowerCase() : p
  const b = win ? root.toLowerCase() : root
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

const WIN_TRASH_LIST = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$rb = (New-Object -ComObject Shell.Application).Namespace(10)
@($rb.Items() | ForEach-Object {
  $d = $_.ExtendedProperty('System.Recycle.DateDeleted')
  [pscustomobject]@{
    id = (Split-Path $_.Path -Leaf); name = $_.Name; from = $_.ExtendedProperty('System.Recycle.DeletedFrom')
    at = $(if ($d) { ([datetime]$d).ToString('o') } else { $null }); size = $_.Size; dir = $_.IsFolder
  }
}) | ConvertTo-Json -Compress`

const WIN_TRASH_RESTORE = `
$sh = New-Object -ComObject Shell.Application
$it = $sh.Namespace(10).Items() | Where-Object { (Split-Path $_.Path -Leaf) -eq $env:DOOL2_ID } | Select-Object -First 1
if (-not $it) { Write-Output 'missing'; exit }
# 4: 진행 창 없이, 16: 묻지 않기(같은 이름이 없는 폴더로만 옮긴다), 1024: 오류 창 없이
$sh.Namespace($env:DOOL2_DEST).MoveHere($it, 1044)
Write-Output 'ok'`
