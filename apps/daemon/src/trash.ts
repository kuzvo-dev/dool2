// Find and restore from the trash (ADR 0024 addendum). Emptying the trash and permanent delete are not built.
// - macOS: ~/.Trash. The original place comes from ptbL (folder) and ptbN (name), which Finder writes in the trash's .DS_Store.
//   Without Full Disk Access for Doori, macOS blocks reading the trash (EPERM) -> the reason and the next step
// - Windows: the shell's recycle bin (Shell.Application Namespace 10). The original place is System.Recycle.DeletedFrom
import { existsSync } from 'node:fs'
import { readdir, readFile, rename, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { Exec } from './file-ops.js'

export interface TrashItem {
  /** Name inside the trash (macOS: file name in ~/.Trash, Windows: $R... name). Used to pick it when restoring */
  id: string
  /** Original name */
  name: string
  /** Original folder (absent if unknown) */
  from?: string
  /** When it was deleted (ms, roughly) */
  at?: number
  size?: number
  dir?: boolean
}

export interface TrashContext {
  platform: NodeJS.Platform
  exec: Exec
  home: string
}

/** What to tell the user when the trash cannot be read */
export const MAC_TRASH_BLOCKED =
  'macOS is blocking access to the trash (Doori does not have "Full Disk Access", which only the person can turn on in System Settings > Privacy & Security > Full Disk Access). ' +
  'Without it the person can put a file back themselves: open the Trash at the end of the Dock, right-click the file and choose "Put Back". A file that was in iCloud Drive or OneDrive may also be in that service\'s "Recently Deleted", which Dool2 can open in the browser.'

/** UTF-16BE text */
const utf16be = (b: Buffer) => Buffer.from(b).swap16().toString('utf16le')

/**
 * Finds the "deleted from" records in the macOS trash .DS_Store: name in the trash -> { dir: 'Users/me/Documents/', name? }.
 * Record layout: [name length u32][name UTF-16BE][4-byte code 'ptbL'|'ptbN']['ustr'][value length u32][value UTF-16BE]
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
      // Leading name: grow the length k from 1 until [k][name, 2k bytes] fits
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

/** Trash list. If unreadable, the reason (text) */
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
        // Moving to the trash changes ctime, which is close to the deletion time
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
      return `Could not read the trash: ${r.stderr.split('\n')[0]?.slice(0, 160)}`
    let rows: { id?: string; name?: string; from?: string; at?: string; size?: number; dir?: boolean }[] = []
    try {
      const v = JSON.parse(r.stdout.trim() || '[]')
      rows = Array.isArray(v) ? v : [v]
    } catch {
      return 'Could not read the trash list.'
    }
    return rows
      .filter((x) => x.id)
      .map((x) => {
        // If Explorer hides extensions the name has none: add the extension of the $R name
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
  return 'The trash cannot be viewed on this PC yet (macOS and Windows only).'
}

/** Restore: that trash item into the dest folder as name (the caller makes sure the name is free) */
export async function trashRestore(
  ctx: TrashContext,
  item: TrashItem,
  dest: string,
  name: string,
): Promise<void> {
  if (ctx.platform === 'darwin') {
    if (item.id.includes('/') || item.id.includes('\\') || item.id === '..')
      throw new Error('Invalid trash item name')
    await rename(join(ctx.home, '.Trash', item.id), join(dest, name))
    return
  }
  // Windows: move through the shell so the recycle bin record is cleaned up too. It comes out under its original name (pick a folder without that name)
  const r = await ctx.exec(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WIN_TRASH_RESTORE],
    {
      timeout: 60_000,
      env: { DOOL2_ID: item.id, DOOL2_DEST: dest },
    },
  )
  if (!r.stdout.includes('ok'))
    throw new Error(r.stdout.includes('missing') ? 'Not in the trash' : 'Could not restore')
  for (let i = 0; i < 40 && !existsSync(join(dest, item.name)); i++)
    await new Promise((res) => setTimeout(res, 250))
  if (!existsSync(join(dest, item.name))) throw new Error('Could not confirm the restore')
  if (item.name !== name) await rename(join(dest, item.name), join(dest, name))
}

/** Whether the path is inside the folder (Windows ignores case) */
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
# 4: no progress window, 16: do not ask (only move into a folder without that name), 1024: no error window
$sh.Namespace($env:DOOL2_DEST).MoveHere($it, 1044)
Write-Output 'ok'`
