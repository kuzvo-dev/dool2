// PC file tools, second set (ADR 0024): move and rename, convert photo formats, print on paper.
// Only inside the visible folders (Desktop, Documents, Downloads, Pictures, Movies) (ADR 0022). No overwriting or
// deleting.
// - Move: two or more go through an approval card (what goes where, as a list) and are logged so they can be undone
// - Convert photos: the original stays, a new file is made (macOS sips, Windows WPF imaging)
// - Print: paper comes out, so it always needs approval (macOS lp, Windows prints through the app that opens the file)
// - Merge and split PDFs (pdf-edit.ts), HTML to PDF/PNG (render.ts), restore from the trash (trash.ts),
//   downloads (download.ts), lock the screen (pc-power.ts)

import { execFile } from 'node:child_process'
import { constants, existsSync, realpathSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, sep } from 'node:path'
import type { Lang } from '@dool2/i18n'
import type { Approvals } from './approvals.js'
import { download } from './download.js'
import { cleanName, freeName } from './file-names.js'
import { filesCopy } from './locales/files.js'
import { POWER_LABEL, POWER_OFF_TEXT, type PowerAction, powerCheck, powerDo } from './pc-power.js'
import { pdfText } from './pdf.js'
import { pdfTool } from './pdf-edit.js'
import { KR_FAX_WORD } from './region/kr/files.js'
import { type HtmlRenderer, type RenderedFile, renderTool } from './render.js'
import { type TrashItem, trashList, trashRestore } from './trash.js'

export { cleanName, freeName } from './file-names.js'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  /** The program could not run because it is missing */
  missing?: boolean
}
/** Runs an outside program. Tests swap it out (so nothing goes to a real printer) */
export type Exec = (
  cmd: string,
  args: string[],
  o?: { timeout?: number; env?: Record<string, string> },
) => Promise<ExecResult>

export const execTool: Exec = (cmd, args, o = {}) =>
  new Promise((res) =>
    execFile(
      cmd,
      args,
      {
        timeout: o.timeout ?? 20_000,
        maxBuffer: 4 << 20,
        windowsHide: true,
        env: o.env ? { ...process.env, ...o.env } : process.env,
      },
      (e, stdout, stderr) => {
        const err = e as (NodeJS.ErrnoException & { code?: number | string }) | null
        res({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') || (err?.message ?? ''),
          ...(err?.code === 'ENOENT' ? { missing: true } : {}),
        })
      },
    ),
  )

export interface FileToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}
const ok = (text: string): FileToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): FileToolResult => ({ isError: true, content: [{ type: 'text', text }] })

/** Path helpers FileTools hands over (the visible-folder boundary is decided in one place only) */
export interface FileScope {
  /** An existing path inside the visible folders (real path) */
  inside(p: string): string | undefined
  /** A folder path that may not exist yet: resolves as far as it exists and checks it is inside the boundary */
  insideNew(p: string): string | undefined
  /** How the path is shown to the user (~/Downloads/a.pdf) */
  show(p: string): string
  /** The Desktop, Documents, Downloads, Pictures and Movies folders themselves */
  roots(): string[]
  /** Files never touched (hidden files, certificates, keys, password files) */
  sensitive(p: string): boolean
  /** Home folder (real path) */
  home: string
  /** The first folder of one of Desktop, Documents, Downloads */
  folder(key: 'desktop' | 'documents' | 'downloads'): string | undefined
  /** Reads a file (downloads it first if it is only in macOS iCloud). The reason as text when it cannot */
  read(p: string): Promise<Buffer | string>
}

export interface FileOpsOptions {
  approvals?: Approvals
  /** Move log file (for undo). Memory only when missing */
  movesLog?: string
  exec?: Exec
  platform?: NodeJS.Platform
  /** Time one photo conversion call may take (past it, stop and say to continue) */
  convertBudgetMs?: number
  /** What Dool2 is doing now: chats being answered and services being connected (checked before sleep) */
  busy?: () => { turns: number; connecting: string[] }
  /** Downloads (tests swap these out) */
  fetch?: typeof fetch
  resolve?: typeof import('node:dns/promises').lookup
  downloadWaitMs?: number
  /** Draws HTML into PDF/PNG (the desktop app provides it). Without it file_render says it cannot */
  renderFile?: HtmlRenderer
  /** How long one drawing may take (tests shorten it) */
  renderTimeoutMs?: number
  /** Language of the text people read (approval cards and results). Korean when not given */
  lang?: () => Lang
}

interface TrashPlan {
  item: TrashItem
  dest: string
  /** Reason shown to the user (original place / why it goes to the desktop) */
  why: string
}

interface MovePlan {
  from: string
  to: string
  /** Whether a number was added because the name was taken */
  numbered?: boolean
}
interface MoveBatch {
  id: string
  at: string
  items: MovePlan[]
  /** Folders made this time (removed on undo when empty) */
  made: string[]
  undone?: boolean
}
interface PrintPlan {
  path: string
  printer: string
  copies: number
  pages?: string
}
type Pending =
  | { kind: 'move'; items: MovePlan[] }
  | ({ kind: 'print' } & PrintPlan)
  | { kind: 'trash'; items: TrashPlan[] }
  | { kind: 'download'; url: string; name?: string }
  | { kind: 'power'; action: PowerAction }

/** Marks approval cards so they pair with the chat log (file work has no tab, so -2) */
export const FILE_TAB = -2

const IMG_EXT = /^\.(heic|heif|png|webp|jpe?g|tiff?|gif|bmp)$/i
const PRINT_EXT = /^\.(pdf|txt|jpe?g|png|gif|tiff?)$/i
/** Printers that put out no paper (PDF, XPS, OneNote, fax) */
const VIRTUAL_PRINTER = new RegExp(`pdf|xps|onenote|fax|${KR_FAX_WORD}`, 'i')
const MAX_MOVES = 300
const MAX_CONVERT = 1000

export class FileOps {
  private readonly approvals?: Approvals
  private readonly exec: Exec
  private readonly platform: NodeJS.Platform
  private readonly pending = new Map<string, Pending>()
  private batches: MoveBatch[] | undefined
  constructor(
    private readonly scope: FileScope,
    private readonly opts: FileOpsOptions = {},
  ) {
    this.approvals = opts.approvals
    this.exec = opts.exec ?? execTool
    this.platform = opts.platform ?? process.platform
  }

  /** Copy for people (approval cards and results) in the user's language */
  private t() {
    return filesCopy(this.opts.lang?.() ?? 'ko')
  }

  // ── Move and rename ─────────────────────────────

  async move(args: Record<string, unknown>): Promise<FileToolResult> {
    if (args.undo === true) return this.undo()
    const list = Array.isArray(args.moves) ? (args.moves as Record<string, unknown>[]) : []
    if (!list.length) return fail('Give what to move in moves. To undo, undo: true.')
    if (list.length > MAX_MOVES)
      return fail(`Up to ${MAX_MOVES} at a time. Ask the user to split it into smaller batches.`)
    const taken = new Set<string>()
    const plan: MovePlan[] = []
    const skipped: string[] = []
    const roots = this.scope.roots()
    for (const m of list) {
      const raw = String(m?.from ?? '')
      const src = this.scope.inside(raw)
      const label = basename(raw) || raw
      if (!src) {
        skipped.push(`${label} (missing or outside the visible folders)`)
        continue
      }
      if (roots.includes(src)) {
        skipped.push(
          `${label} (the Desktop, Documents, Downloads, Pictures and Movies folders themselves never move)`,
        )
        continue
      }
      if (this.scope.sensitive(src)) {
        skipped.push(`${label} (certificates, keys and hidden files are never touched)`)
        continue
      }
      const folder = typeof m.folder === 'string' && m.folder.trim() ? m.folder.trim() : undefined
      const dir = folder ? this.scope.insideNew(folder) : dirname(src)
      if (!dir) {
        skipped.push(
          `${label} (destination "${folder}" is outside Desktop, Documents, Downloads, Pictures, Movies)`,
        )
        continue
      }
      if (dir === src || dir.startsWith(src + sep)) {
        skipped.push(`${label} (a folder cannot move into itself)`)
        continue
      }
      const s = await stat(src)
      let name = basename(src)
      if (typeof m.name === 'string' && m.name.trim()) {
        name = cleanName(m.name)
        const ext = extname(src)
        // Keep the extension (changing it stops the file from opening; converting formats is file_convert)
        if (!s.isDirectory() && ext && extname(name).toLowerCase() !== ext.toLowerCase()) name += ext
        if (!name || name === ext) {
          skipped.push(`${label} (the new name is empty)`)
          continue
        }
      }
      const want = join(dir, name)
      if (want === src) {
        skipped.push(`${label} (already in that place with that name)`)
        continue
      }
      // macOS and Windows treat names differing only in case as the same file: leave that as a rename
      const same = existsSync(want) && realOf(want) === src
      const to = same ? want : freeName(dir, name, taken)
      plan.push({ from: src, to, ...(to !== want ? { numbered: true } : {}) })
    }
    if (!plan.length) return fail(`Nothing can be moved: ${skipped.join(', ')}`)
    const skipNote = skipped.length ? `\nSkipped ${skipped.length}: ${skipped.slice(0, 20).join(', ')}` : ''
    // One item runs right away (it can be undone). Several go through one approval with the list
    if (list.length < 2) {
      const r = await this.doMove(plan)
      return { ...(r.ok ? {} : { isError: true }), content: [{ type: 'text', text: r.message + skipNote }] }
    }
    if (!this.approvals) return fail('Approval is not available, so several files were not moved.')
    const made = [...new Set(plan.flatMap((p) => this.missingDirs(dirname(p.to))))]
    const where = [...new Set(plan.map((p) => this.rootLabel(p.to)))].join('·')
    const t = this.t()
    const rec = this.approvals.create({
      tabId: FILE_TAB,
      ref: 'file_move',
      role: t.moveRole,
      label: t.moveLabel,
      url: 'file:move',
      kind: 'file',
      reason: t.moveReason,
      what: t
        .moveWhat(
          plan.length,
          made.map((d) => basename(d)),
        )
        .slice(0, 200),
      where,
      items: plan.map((p) => this.line(p)),
      cancel: t.moveCancel,
    })
    this.pending.set(rec.id, { kind: 'move', items: plan })
    return ok(
      `Approval requested (${rec.id.slice(0, 8)}). ${plan.length} to move${made.length ? `, ${made.length} new folder(s) to make` : ''}:\n` +
        plan
          .slice(0, 40)
          .map((p) => `- ${this.line(p)}`)
          .join('\n') +
        (plan.length > 40 ? `\n… and ${plan.length - 40} more` : '') +
        skipNote +
        '\nTell the user in one or two sentences what moves where, and end this reply here. Once approved, Dool2 moves only what is on this list and reports the result in the next message.',
    )
  }

  /** One line on the approval card and result: "a.pdf → ~/Downloads/Receipts/" (plus the new name if renamed) */
  private line(p: MovePlan) {
    const renamed = basename(p.to) !== basename(p.from)
    return `${basename(p.from)} → ${this.scope.show(dirname(p.to))}${sep}${renamed ? basename(p.to) : ''}`
  }

  private rootLabel(p: string) {
    return this.scope.show(this.scope.roots().find((r) => p.startsWith(r + sep)) ?? dirname(p))
  }

  /** Folders that do not exist yet (top first) */
  private missingDirs(dir: string): string[] {
    const out: string[] = []
    for (let d = dir; !existsSync(d) && dirname(d) !== d; d = dirname(d)) out.unshift(d)
    return out
  }

  private async doMove(plan: MovePlan[]): Promise<{ ok: boolean; message: string }> {
    const t = this.t()
    const made = new Set<string>()
    const done: MovePlan[] = []
    const failed: string[] = []
    const renamed: string[] = []
    const taken = new Set<string>()
    for (const p of plan) {
      try {
        if (!existsSync(p.from)) throw new Error(t.goneMeanwhile)
        for (const d of this.missingDirs(dirname(p.to))) made.add(d)
        await mkdir(dirname(p.to), { recursive: true })
        // The same name may have appeared after approval: check again right before and add a number
        const same = existsSync(p.to) && realOf(p.to) === p.from
        const to = same ? p.to : existsSync(p.to) ? freeName(dirname(p.to), basename(p.to), taken) : p.to
        await moveFile(p.from, to, t.folderOtherDisk)
        if (p.numbered || to !== p.to) renamed.push(basename(to))
        done.push({ from: p.from, to })
      } catch (e) {
        failed.push(`${basename(p.from)}(${(e as Error).message})`)
      }
    }
    if (done.length) await this.record({ items: done, made: [...made] })
    const folders = [...new Set(done.map((d) => this.scope.show(dirname(d.to))))]
    const message =
      (done.length ? t.moved(done.length, folders.slice(0, 6), folders.length - 6) : t.movedNone) +
      (made.size ? t.movedNewFolders([...made].map((d) => basename(d)).slice(0, 10)) : '') +
      (renamed.length ? t.movedNumbered(renamed.slice(0, 10), renamed.length > 10) : '') +
      (failed.length ? t.movedFailed(failed.length, failed.slice(0, 10)) : '') +
      (done.length ? t.moveUndoHint : '')
    return { ok: done.length > 0, message }
  }

  private async load(): Promise<MoveBatch[]> {
    if (this.batches) return this.batches
    this.batches = []
    if (this.opts.movesLog)
      try {
        const v = JSON.parse(await readFile(this.opts.movesLog, 'utf8'))
        if (Array.isArray(v)) this.batches = v as MoveBatch[]
      } catch {}
    return this.batches
  }

  private async save() {
    if (!this.opts.movesLog || !this.batches) return
    await mkdir(dirname(this.opts.movesLog), { recursive: true })
    await writeFile(this.opts.movesLog, JSON.stringify(this.batches.slice(-20)))
  }

  private async record(b: Omit<MoveBatch, 'id' | 'at'>) {
    const list = await this.load()
    list.push({ id: Date.now().toString(36), at: new Date().toISOString(), ...b })
    this.batches = list.slice(-20)
    await this.save()
  }

  /** Moves the last batch back. Adds a number if the same name has appeared in the original place */
  private async undo(): Promise<FileToolResult> {
    const list = await this.load()
    const b = [...list].reverse().find((x) => !x.undone)
    if (!b) return fail('There is no move to undo.')
    const back: string[] = []
    const failed: string[] = []
    const taken = new Set<string>()
    for (const it of [...b.items].reverse()) {
      try {
        if (!existsSync(it.to))
          throw new Error('not where it was moved to; it seems to have been moved or deleted since')
        const same = existsSync(it.from) && realOf(it.from) === it.to
        const dest =
          same || !existsSync(it.from) ? it.from : freeName(dirname(it.from), basename(it.from), taken)
        await mkdir(dirname(dest), { recursive: true })
        await moveFile(it.to, dest, 'folders cannot be moved to another disk')
        back.push(
          dest === it.from ? basename(dest) : `${basename(dest)} (numbered because the name was taken)`,
        )
      } catch (e) {
        failed.push(`${basename(it.to)} (${(e as Error).message})`)
      }
    }
    // Remove folders made by that batch if they are empty (leave them if anything else is inside)
    for (const d of [...b.made].reverse()) await rmdir(d).catch(() => undefined)
    b.undone = true
    await this.save()
    const when = day(Date.parse(b.at))
    const more = list.some((x) => !x.undone)
    return {
      ...(back.length ? {} : { isError: true }),
      content: [
        {
          type: 'text',
          text:
            `Moved ${back.length} of the ${b.items.length} moved on ${when} back to where they were.` +
            (back.length ? ` (${back.slice(0, 10).join(', ')}${back.length > 10 ? ' …' : ''})` : '') +
            (failed.length ? ` Not moved back (${failed.length}): ${failed.slice(0, 10).join(', ')}.` : '') +
            (more ? ' There are earlier moves too. To undo more, call undo: true again.' : ''),
        },
      ],
    }
  }

  // ── Convert photo formats ─────────────────────────────

  async convert(args: Record<string, unknown>): Promise<FileToolResult> {
    const to = String(args.to ?? 'jpg').toLowerCase() === 'png' ? 'png' : 'jpg'
    const only = Array.isArray(args.only)
      ? (args.only as unknown[]).map((x) => `.${String(x).toLowerCase().replace(/^\./, '')}`)
      : undefined
    const paths = Array.isArray(args.paths)
      ? (args.paths as unknown[]).map(String)
      : typeof args.path === 'string'
        ? [args.path]
        : []
    if (!paths.length) return fail('Give the photos (or a folder of photos) to convert in paths.')
    const outDir =
      typeof args.folder === 'string' && args.folder.trim()
        ? this.scope.insideNew(args.folder.trim())
        : undefined
    if (typeof args.folder === 'string' && args.folder.trim() && !outDir)
      return fail(
        'The folder for the new files must be inside Desktop, Documents, Downloads, Pictures or Movies.',
      )
    const skipped: string[] = []
    const sources: string[] = []
    const isTarget = (ext: string) => (to === 'jpg' ? /^\.jpe?g$/i.test(ext) : ext.toLowerCase() === '.png')
    const want = (p: string) => {
      const ext = extname(p)
      if (!IMG_EXT.test(ext) || isTarget(ext)) return false
      return (
        !only || only.some((o) => o === ext.toLowerCase() || (o === '.heic' && ext.toLowerCase() === '.heif'))
      )
    }
    for (const raw of paths) {
      const p = this.scope.inside(raw)
      if (!p) {
        skipped.push(`${basename(raw)} (missing or outside the visible folders)`)
        continue
      }
      if (this.scope.sensitive(p)) continue
      const s = await stat(p)
      if (s.isDirectory()) {
        const entries = await readdir(p, { withFileTypes: true })
        for (const e of entries)
          if (e.isFile() && !e.name.startsWith('.') && want(e.name)) sources.push(join(p, e.name))
      } else if (!IMG_EXT.test(extname(p))) skipped.push(`${basename(p)} (not a photo file)`)
      else if (isTarget(extname(p))) skipped.push(`${basename(p)} (already ${to.toUpperCase()})`)
      else sources.push(p)
    }
    const uniq = [...new Set(sources)]
    if (!uniq.length)
      return fail(
        `Found no photos to convert${skipped.length ? `: ${skipped.slice(0, 10).join(', ')}` : '. For a folder, only the photos directly inside it count (give subfolders separately).'}`,
      )
    if (uniq.length > MAX_CONVERT)
      return fail(`Up to ${MAX_CONVERT} at a time. Split the folder into smaller batches.`)
    if (this.platform !== 'darwin' && this.platform !== 'win32')
      return fail(
        'This PC cannot convert photo formats yet (macOS and Windows only). Ask the user to export them as JPG from their photo app.',
      )

    // New file name: if the same name exists and is newer than the original, treat it as already converted and skip
    const taken = new Set<string>()
    const jobs: { src: string; out: string }[] = []
    for (const src of uniq) {
      const dir = outDir ?? dirname(src)
      const name = `${basename(src, extname(src))}.${to}`
      const at = join(dir, name)
      if (existsSync(at)) {
        const [a, b] = await Promise.all([stat(at), stat(src)])
        if (a.mtimeMs >= b.mtimeMs) {
          skipped.push(`${basename(src)} (converted ${name} already exists)`)
          continue
        }
      }
      if (outDir) await mkdir(outDir, { recursive: true })
      jobs.push({ src, out: freeName(dir, name, taken) })
    }
    const done: string[] = []
    const failed: string[] = []
    const budget = this.opts.convertBudgetMs ?? 70_000
    const end = Date.now() + budget
    let next = 0
    let missingCodec = false
    if (this.platform === 'darwin') {
      const worker = async () => {
        while (next < jobs.length && Date.now() < end) {
          const j = jobs[next++] as { src: string; out: string }
          const r = await this.exec(
            'sips',
            [
              '-s',
              'format',
              to === 'jpg' ? 'jpeg' : 'png',
              ...(to === 'jpg' ? ['-s', 'formatOptions', '90'] : []),
            ].concat([j.src, '--out', j.out]),
            { timeout: 60_000 },
          )
          if (r.code === 0 && existsSync(j.out)) done.push(j.out)
          else {
            await rm(j.out, { force: true })
            failed.push(`${basename(j.src)} (${firstLine(r.stderr) || 'could not convert'})`)
          }
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()])
    } else {
      // Windows: 20 per PowerShell call (WPF imaging. HEIC and WEBP need the extension that opens that format)
      while (next < jobs.length && Date.now() < end) {
        const chunk = jobs.slice(next, next + 20)
        next += chunk.length
        const r = await this.exec(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', WIN_CONVERT],
          {
            timeout: 120_000,
            env: {
              DOOL2_JOBS: JSON.stringify(chunk.map((j, i) => ({ i, src: j.src, out: j.out, fmt: to }))),
            },
          },
        )
        const lines = r.stdout.split(/\r?\n/)
        for (const [i, j] of chunk.entries()) {
          if (lines.includes(`ok ${i}`) && existsSync(j.out)) {
            done.push(j.out)
            continue
          }
          // 0x88982F50 (-2003292336): no component (codec) opens that format
          const codec = /-2003292336|88982F50/i.test(lines.find((l) => l.startsWith(`err ${i} `)) ?? '')
          if (codec) missingCodec = true
          failed.push(
            `${basename(j.src)} (${codec ? 'this PC has no component that opens this format' : firstLine(r.stderr) || 'could not convert'})`,
          )
        }
      }
    }
    const left = jobs.length - next
    const shownDir = [...new Set(done.map((d) => this.scope.show(dirname(d))))]
    const text =
      (done.length
        ? `Converted ${done.length} to ${to.toUpperCase()} (the originals are unchanged). New files: ${done
            .slice(0, 5)
            .map((d) => basename(d))
            .join(
              ', ',
            )}${done.length > 5 ? ` and ${done.length - 5} more` : ''} → ${shownDir.slice(0, 3).join(', ')}.`
        : 'Nothing was converted.') +
      (left > 0
        ? ` It took a while, so ${jobs.length - left} of ${jobs.length} are done. Call again with the same input: converted ones are skipped and the remaining ${left} continue.`
        : '') +
      (skipped.length
        ? ` Skipped ${skipped.length}: ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? ' …' : ''}.`
        : '') +
      (failed.length ? ` Not converted (${failed.length}): ${failed.slice(0, 8).join(', ')}.` : '') +
      (missingCodec
        ? ' HEIC converts once "HEIF Image Extensions" (for WEBP, "WebP Image Extensions") is installed from the Microsoft Store. Or, on the iPhone, Settings > Photos > "Transfer to Mac or PC" set to "Automatic" sends JPG from the start.'
        : '')
    return { ...(done.length || left > 0 ? {} : { isError: true }), content: [{ type: 'text', text }] }
  }

  // ── Print ─────────────────────────────────────────

  async print(args: Record<string, unknown>): Promise<FileToolResult> {
    const printers = await this.printers()
    if (typeof printers === 'string') return fail(printers)
    const real = printers.filter((p) => !p.virtual)
    const listText = () =>
      printers
        .map(
          (p) =>
            `- ${p.name}${p.isDefault ? ' (default)' : ''}: ${p.problem ?? 'ready'}${p.virtual ? ' · virtual printer, no paper comes out' : ''}`,
        )
        .join('\n')
    if (!real.length)
      return fail(
        `No printer is connected to this PC${printers.length ? ` (only virtual printers: ${printers.map((p) => p.name).join(', ')})` : ''}. ` +
          (this.platform === 'win32'
            ? 'Ask the user to add their home printer in Settings > Bluetooth & devices > Printers & scanners.'
            : 'Ask the user to add their home printer with [+] in System Settings > Printers & Scanners (it shows up when it is on and on the same Wi-Fi).') +
          ' Once added, ask again and it prints.',
      )
    if (typeof args.path !== 'string' || !args.path.trim())
      return ok(`${printers.length} printer(s):\n${listText()}\nTo print, give file_print a path (file).`)

    const p = this.scope.inside(args.path)
    if (!p)
      return fail(
        'Only files inside Desktop, Documents, Downloads, Pictures or Movies can be printed. Find the path with file_find first.',
      )
    if (this.scope.sensitive(p))
      return fail('Sensitive files such as certificates, keys and passwords are never printed.')
    const s = await stat(p)
    if (s.isDirectory()) return fail('A folder cannot be printed. Pick a file inside it.')
    const ext = extname(p)
    if (/^\.(heic|heif|webp)$/i.test(ext))
      return fail(
        'This photo format cannot be printed directly. Convert it to JPG with file_convert, then print that file.',
      )
    if (!PRINT_EXT.test(ext))
      return fail(
        `${ext || 'This'} file cannot be printed directly (PDF, photos and txt only). Tell the user that Word, Excel and Hangul documents print right away once saved as PDF from that app. You can also look for a PDF with the same name with file_find first.`,
      )

    let printer = real.find((x) => x.isDefault)
    if (typeof args.printer === 'string' && args.printer.trim()) {
      const want = args.printer.trim().normalize('NFC').toLowerCase()
      printer = printers.find((x) => x.name.normalize('NFC').toLowerCase() === want)
      if (!printer) return fail(`There is no printer "${args.printer}". Printers on this PC:\n${listText()}`)
      if (printer.virtual) return fail(`${printer.name} is a virtual printer; no paper comes out.`)
    }
    if (!printer && real.length === 1) printer = real[0]
    if (!printer)
      return fail(
        `There is no default printer and there are several printers. Ask the user which one and give it as printer:\n${listText()}`,
      )
    if (printer.problem)
      return fail(
        `${printer.name}: ${printer.problem}. Ask the user to check the printer's power and Wi-Fi (or cable) and ask again. Other printers:\n${listText()}`,
      )
    const copies = Math.min(Math.max(Math.floor(Number(args.copies) || 1), 1), 20)
    const pages =
      typeof args.pages === 'string' && args.pages.trim() ? args.pages.replace(/\s+/g, '') : undefined
    if (pages && !/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(pages)) return fail('Give pages like "1-3,5".')
    if (!this.approvals) return fail('Approval is not available, so nothing was printed.')
    // For a PDF, count pages to say how many sheets come out (card text for people, result text for the AI)
    const t = this.t()
    let sheets = ''
    let sheetsNote = ''
    if (/^\.pdf$/i.test(ext) && s.size < 30 << 20)
      try {
        const n = (await pdfText(await readFile(p))).pages
        sheets = pages ? t.printPagesOf(n, pages) : t.printSheets(n, copies)
        sheetsNote = pages
          ? ` · pages ${pages} of a ${n}-page PDF`
          : ` · ${n} pages × ${copies} = ${n * copies} sheets`
      } catch {}
    const name = basename(p)
    const rec = this.approvals.create({
      tabId: FILE_TAB,
      ref: 'file_print',
      role: t.printRole,
      label: t.printLabel,
      url: 'file:print',
      kind: 'print',
      reason: t.printReason,
      what: t.printWhat(name, copies, pages),
      where: printer.name,
      items: [`${this.scope.show(p)}${sheets}`],
      ...(this.platform === 'win32' && pages ? { cancel: t.printWinPages } : {}),
    })
    this.pending.set(rec.id, {
      kind: 'print',
      path: p,
      printer: printer.name,
      copies,
      ...(pages ? { pages } : {}),
    })
    return ok(
      `Approval requested (${rec.id.slice(0, 8)}). "${name}", ${copies} copy(ies) on ${printer.name}${sheetsNote}. ` +
        'Tell the user in one sentence what prints and how many copies, and end this reply here. Once approved, Dool2 sends only that file to the printer and reports the result in the next message.',
    )
  }

  /** Printers and their state. The reason as text when there is no print command */
  private async printers(): Promise<
    { name: string; isDefault: boolean; problem?: string; virtual?: boolean }[] | string
  > {
    if (this.platform === 'win32') {
      const r = await this.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PRINTERS])
      if (r.code !== 0 && !r.stdout.trim()) return `Could not read the printer list: ${firstLine(r.stderr)}`
      let rows: { Name?: string; Default?: boolean; WorkOffline?: boolean; PrinterStatus?: number }[] = []
      try {
        const v = JSON.parse(r.stdout.trim() || '[]')
        rows = Array.isArray(v) ? v : [v]
      } catch {
        return 'Could not read the printer list.'
      }
      return rows
        .filter((x) => x.Name)
        .map((x) => ({
          name: String(x.Name),
          isDefault: Boolean(x.Default),
          ...(x.WorkOffline || x.PrinterStatus === 7
            ? { problem: 'off or disconnected (offline)' }
            : x.PrinterStatus === 6
              ? { problem: 'printing is paused' }
              : {}),
          ...(VIRTUAL_PRINTER.test(String(x.Name)) ? { virtual: true } : {}),
        }))
    }
    // macOS (CUPS): lpstat text follows the Mac's language, so names come from lpstat -e and state from lpoptions' printer-state
    const e = await this.exec('lpstat', ['-e'])
    if (e.missing) return 'Could not find the print command (lp) on this PC.'
    const names = e.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (!names.length) return []
    const d = await this.exec('lpstat', ['-d'])
    const def = names.find((n) => d.stdout.trim().endsWith(` ${n}`) || d.stdout.trim().endsWith(`:${n}`))
    return Promise.all(
      names.map(async (name) => {
        const o = await this.exec('lpoptions', ['-p', name])
        const state = /printer-state=(\d)/.exec(o.stdout)?.[1]
        const reasons = /printer-state-reasons=(\S+)/.exec(o.stdout)?.[1] ?? ''
        const accepting = !/printer-is-accepting-jobs=(false|0)/.test(o.stdout)
        const problem =
          state === '5' || !accepting
            ? 'printing is paused. Ask the user to click [Resume] in System Settings > Printers & Scanners > Printer Queue'
            : /offline/.test(reasons)
              ? 'off or disconnected (offline)'
              : /media-empty|media-needed/.test(reasons)
                ? 'out of paper'
                : undefined
        return { name, isDefault: name === def, ...(problem ? { problem } : {}) }
      }),
    )
  }

  // ── Merge and split PDFs ─────────────────────────────

  pdf(args: Record<string, unknown>): Promise<FileToolResult> {
    return pdfTool(this.scope, args)
  }

  // ── HTML to PDF/PNG (render.ts) ───────────────────

  /** A file drawn from HTML (added to the Library) */
  onRendered?: (f: RenderedFile) => void
  render(args: Record<string, unknown>): Promise<FileToolResult> {
    return renderTool(this.scope, args, this.opts.renderFile, this.onRendered, this.opts.renderTimeoutMs)
  }

  // ── Find and restore from the trash ─────────────────────────

  private trashCtx() {
    return { platform: this.platform, exec: this.exec, home: this.scope.home }
  }

  async trash(args: Record<string, unknown>): Promise<FileToolResult> {
    const list = await trashList(this.trashCtx())
    if (typeof list === 'string') return fail(list)
    const restore = Array.isArray(args.restore) ? (args.restore as unknown[]).map(String).filter(Boolean) : []
    if (!restore.length) {
      const words = norm(String(args.query ?? ''))
        .split(/[,·]/)
        .map((w) => w.trim())
        .filter(Boolean)
      const hits = list
        .filter(
          (x) => !words.length || words.every((w) => norm(x.name).includes(w) || norm(x.id).includes(w)),
        )
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      if (!list.length)
        return ok(
          'The trash is empty. If it was already emptied, Dool2 cannot restore it. If the file was in iCloud or OneDrive, tell the user to check that service\'s "Recently Deleted".',
        )
      if (!hits.length)
        return ok(
          `Found nothing with "${String(args.query ?? '')}" in the trash (${list.length} items). Try other words, or if the file was in iCloud or OneDrive, tell the user to check that service's "Recently Deleted".`,
        )
      return ok(
        `In the trash, ${hits.length > 30 ? `latest 30 of ${hits.length}` : `${hits.length}`}:\n` +
          hits
            .slice(0, 30)
            .map(
              (x) =>
                `- ${x.name}${x.dir ? sep : ''}${x.at ? ` · deleted ${day(x.at)}` : ''} · original place ${x.from ? this.showAny(x.from) : 'unknown'} · restore: ${JSON.stringify(x.id)}`,
            )
            .join('\n') +
          '\nTo restore, give file_trash restore: [the restore values above]. If the original place is unknown or outside the folders Dool2 handles, it goes to the desktop.',
      )
    }
    const desk = this.scope.folder('desktop') ?? this.scope.folder('downloads')
    if (!desk) return fail('Could not find the desktop folder to put restored files in.')
    const t = this.t()
    const plan: TrashPlan[] = []
    const skipped: string[] = []
    for (const id of restore) {
      const item = list.find((x) => x.id === id) ?? list.find((x) => x.name === id)
      if (!item) {
        skipped.push(`${id} (not in the trash)`)
        continue
      }
      const back = item.from ? this.scope.inside(item.from) : undefined
      plan.push(
        back
          ? { item, dest: back, why: t.trashWhyOrigin }
          : {
              item,
              dest: desk,
              why: item.from ? t.trashWhyOutside(this.showAny(item.from)) : t.trashWhyUnknown,
            },
      )
    }
    if (!plan.length)
      return fail(
        `Nothing to restore: ${skipped.join(', ')}. Find it with file_trash first and give the restore value as is.`,
      )
    const skipNote = skipped.length ? ` Not found: ${skipped.join(', ')}.` : ''
    if (restore.length < 2) {
      const r = await this.doTrash(plan)
      return { ...(r.ok ? {} : { isError: true }), content: [{ type: 'text', text: r.message + skipNote }] }
    }
    if (!this.approvals) return fail('Approval is not available, so several files were not restored.')
    const lines = plan.map((p) => `${p.item.name} → ${this.scope.show(p.dest)}${sep} (${p.why})`)
    const rec = this.approvals.create({
      tabId: FILE_TAB,
      ref: 'file_trash',
      role: t.trashRole,
      label: t.trashLabel,
      url: 'file:trash',
      kind: 'file',
      reason: t.trashReason,
      what: t.trashWhat(plan.length),
      where: t.trashWhere,
      items: lines,
    })
    this.pending.set(rec.id, { kind: 'trash', items: plan })
    return ok(
      `Approval requested (${rec.id.slice(0, 8)}). ${plan.length} to restore:\n${lines.map((l) => `- ${l}`).join('\n')}${skipNote}` +
        '\nTell the user in one or two sentences what is restored where, and end this reply here. Once approved, Dool2 restores only what is on this list and reports the result in the next message.',
    )
  }

  private async doTrash(plan: TrashPlan[]): Promise<{ ok: boolean; message: string }> {
    const t = this.t()
    const done: string[] = []
    const failed: string[] = []
    const taken = new Set<string>()
    for (const p of plan) {
      try {
        let dest = p.dest
        let name = basename(freeName(dest, p.item.name, taken))
        // The Windows shell restores only under the original name: if the name is taken, restore into a new empty
        // folder (so nothing is overwritten)
        if (this.platform === 'win32' && name !== p.item.name) {
          dest = freeName(dest, t.trashRestoredFolder, taken)
          name = p.item.name
        }
        await mkdir(dest, { recursive: true })
        await trashRestore(this.trashCtx(), p.item, dest, name)
        done.push(
          t.trashRestoredLine(p.item.name, this.scope.show(join(dest, name)), p.why, name !== p.item.name),
        )
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        failed.push(
          `${p.item.name}(${code === 'EPERM' || code === 'EACCES' ? t.trashMacBlocked : (e as Error).message})`,
        )
      }
    }
    return {
      ok: done.length > 0,
      message:
        (done.length ? t.trashRestored(done.length, done.slice(0, 10)) : t.trashRestoredNone) +
        (failed.length ? t.trashFailed(failed.slice(0, 10)) : ''),
    }
  }

  /** Paths outside the visible folders, shown the way the user sees them (~/…) */
  private showAny(p: string) {
    const home = this.scope.home
    return p === home || p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p
  }

  // ── Download files ─────────────────────────────────

  private downloadDeps() {
    return {
      exec: this.exec,
      platform: this.platform,
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      ...(this.opts.resolve ? { resolve: this.opts.resolve } : {}),
      ...(this.opts.downloadWaitMs !== undefined ? { waitMs: this.opts.downloadWaitMs } : {}),
    }
  }

  async download(args: Record<string, unknown>): Promise<FileToolResult> {
    const url = String(args.url ?? '').trim()
    if (!url) return fail('Give the address to download (url).')
    const dir = this.scope.folder('downloads')
    if (!dir) return fail('Could not find the Downloads folder.')
    const name = typeof args.name === 'string' && args.name.trim() ? args.name : undefined
    const show = (p: string) => this.scope.show(p)
    const r = await download(dir, url, { ...(name ? { name } : {}), show }, this.downloadDeps())
    if (r.kind === 'fail') return fail(r.text)
    if (r.kind === 'done') return ok(r.text)
    // A program: approval before downloading
    if (args.confirm !== true)
      return fail(
        `"${r.name}" is a program (a file that runs when opened), so the user must approve before it is downloaded. Check that the address is the official site, then call again with the same url plus confirm: true to request approval.`,
      )
    if (!this.approvals) return fail('Approval is not available, so the program was not downloaded.')
    const size = r.size ? ` · ${(r.size / (1 << 20)).toFixed(1)}MB` : ''
    const t = this.t()
    const rec = this.approvals.create({
      tabId: FILE_TAB,
      ref: 'file_download',
      role: t.downloadRole,
      label: t.downloadLabel,
      url: 'file:download',
      kind: 'file',
      reason: t.downloadReason,
      what: t.downloadWhat(r.name, size),
      where: r.host,
      items: [url.slice(0, 300)],
      cancel: t.downloadCancel,
    })
    this.pending.set(rec.id, { kind: 'download', url, ...(name ? { name } : {}) })
    return ok(
      `Approval requested (${rec.id.slice(0, 8)}). "${r.name}" from ${r.host}${size}. Tell the user in one sentence what is downloaded from where, and end this reply here. Once approved, Dool2 downloads it to the Downloads folder and reports the result in the next message.`,
    )
  }

  private async doDownload(url: string, name?: string): Promise<{ ok: boolean; message: string }> {
    const t = this.t()
    const dir = this.scope.folder('downloads')
    if (!dir) return { ok: false, message: t.downloadNoFolder }
    const show = (p: string) => this.scope.show(p)
    const r = await download(
      dir,
      url,
      { ...(name ? { name } : {}), approved: true, show },
      this.downloadDeps(),
    )
    if (r.kind === 'done') return { ok: true, message: r.text }
    return { ok: false, message: r.kind === 'fail' ? r.text : t.downloadFailed }
  }

  // ── Lock the screen, sleep ──────────────────────────────

  /** Other work Dool2 is doing (sleep stops it). min leaves out the chat that called this */
  private otherWork(min: number, lang: Lang): string | undefined {
    const b = this.opts.busy?.()
    if (!b) return undefined
    const t = filesCopy(lang)
    const parts = [
      ...(b.turns > min ? [t.busyChats(b.turns - min)] : []),
      ...(b.connecting.length ? [t.busyConnecting(b.connecting.slice(0, 3))] : []),
    ]
    return parts.length ? parts.join(', ') : undefined
  }

  async power(args: Record<string, unknown>): Promise<FileToolResult> {
    const action = String(args.action ?? '')
    if (action === 'off') return ok(POWER_OFF_TEXT)
    if (action !== 'lock' && action !== 'sleep')
      return fail('action is one of lock (lock the screen), sleep, off (asking to shut down).')
    if (action === 'sleep') {
      const other = this.otherWork(1, 'en')
      if (other)
        return fail(
          `Dool2 is doing other work right now (${other}), and sleep would stop it. Ask the user to ask again when it is done, or suggest locking the screen (lock), which does not stop any work.`,
        )
    }
    const check = await powerCheck(action, this.platform, this.exec)
    if (!check.ok) return fail(check.why)
    if (!this.approvals) return fail('Approval is not available, so nothing was done.')
    const label = POWER_LABEL[action]
    const t = this.t()
    const rec = this.approvals.create({
      tabId: FILE_TAB,
      ref: 'pc_screen',
      role: 'PC',
      label,
      url: 'file:pc',
      kind: 'pc',
      reason: action === 'sleep' ? t.powerReasonSleep : t.powerReasonLock,
      what: t.powerWhat(label),
      where: t.powerWhere,
      cancel: check.note ?? (action === 'lock' ? t.powerCancelLock : t.powerCancelSleep),
    })
    this.pending.set(rec.id, { kind: 'power', action })
    return ok(
      `Approval requested (${rec.id.slice(0, 8)}). Ask the user in one sentence to approve "${label}", and end this reply here. Once approved, Dool2 does it right away.` +
        (check.note ? ` (${check.note})` : ''),
    )
  }

  private async doPower(action: PowerAction): Promise<{ ok: boolean; message: string }> {
    const lang = this.opts.lang?.() ?? 'ko'
    const t = filesCopy(lang)
    if (action === 'sleep') {
      const other = this.otherWork(0, lang)
      if (other) return { ok: false, message: t.sleepBusy(other) }
      // Sleep after a moment so the approval result reaches the screen and the phone
      setTimeout(() => void powerDo('sleep', this.platform, this.exec), 3000).unref()
      return { ok: true, message: t.sleepSoon }
    }
    const why = await powerDo('lock', this.platform, this.exec)
    return why ? { ok: false, message: t.lockFailed(why) } : { ok: true, message: t.locked }
  }

  // ── After approval ──────────────────────────────────────

  /** Does only the one thing the user approved */
  async approve(id: string): Promise<{ ok: boolean; message: string }> {
    const t = this.t()
    const rec = this.approvals?.take(id)
    if (!rec) return { ok: false, message: t.approvalGone }
    const plan = this.pending.get(id)
    this.pending.delete(id)
    const finish = (r: { ok: boolean; message: string }) => {
      this.approvals?.finish(id, r.ok, r.message)
      return r
    }
    if (!plan) return finish({ ok: false, message: t.approvalLost })
    try {
      if (plan.kind === 'move') return finish(await this.doMove(plan.items))
      if (plan.kind === 'trash') return finish(await this.doTrash(plan.items))
      if (plan.kind === 'download') return finish(await this.doDownload(plan.url, plan.name))
      if (plan.kind === 'power') return finish(await this.doPower(plan.action))
      return finish(await this.doPrint(plan))
    } catch (e) {
      return finish({ ok: false, message: (e as Error).message })
    }
  }

  private async doPrint(p: PrintPlan): Promise<{ ok: boolean; message: string }> {
    const t = this.t()
    if (!existsSync(p.path)) return { ok: false, message: t.printFileGone }
    const name = basename(p.path)
    if (this.platform === 'win32') {
      // Ask the app that opens the file (PDF viewer, photo app, ...) to print it, once per copy
      for (let i = 0; i < p.copies; i++) {
        const r = await this.exec(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', WIN_PRINT],
          {
            timeout: 60_000,
            env: { DOOL2_FILE: p.path, DOOL2_PRINTER: p.printer },
          },
        )
        if (r.code !== 0)
          return { ok: false, message: t.printWinFailed(firstLine(r.stderr) || t.printWinNoApp) }
      }
      return { ok: true, message: t.printWinSent(p.printer, name, p.copies) }
    }
    const r = await this.exec('lp', [
      '-d',
      p.printer,
      '-n',
      String(p.copies),
      ...(p.pages ? ['-o', `page-ranges=${p.pages}`] : []),
      '--',
      p.path,
    ])
    if (r.code !== 0)
      return { ok: false, message: t.printFailed(firstLine(r.stderr) || t.printUnknownReason) }
    const job = /([\w.-]+-\d+)/.exec(r.stdout)?.[1]
    return { ok: true, message: t.printSent(p.printer, name, p.copies, job) }
  }
}

/** Name for comparing (macOS stores Korean names as separate jamo: normalize to NFC) */
const norm = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, '')
/** Date and time for the AI (tool results) */
const day = (t: number) =>
  new Date(t).toLocaleString('en-US', {
    timeZone: 'Asia/Seoul',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

const firstLine = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
    ?.slice(0, 160) ?? ''

function realOf(p: string) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Move: rename on the same disk; on another disk (EXDEV) copy and then remove the original (files only).
 * folderError is the message when a folder would have to cross disks
 */
async function moveFile(from: string, to: string, folderError: string) {
  try {
    await rename(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    if ((await stat(from)).isDirectory()) throw new Error(folderError)
    await copyFile(from, to, constants.COPYFILE_EXCL)
    await rm(from)
  }
}

/** Windows photo conversion: runs DOOL2_JOBS ([{i,src,out,fmt}]) in order. Each line is "ok i" or "err i HRESULT message" */
const WIN_CONVERT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
$jobs = $env:DOOL2_JOBS | ConvertFrom-Json
foreach ($j in $jobs) {
  $made = $false
  try {
    $s = [IO.File]::OpenRead($j.src)
    try {
      $d = [Windows.Media.Imaging.BitmapDecoder]::Create($s, [Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat, [Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
      $f = $d.Frames[0]
      if ($j.fmt -eq 'png') { $e = New-Object Windows.Media.Imaging.PngBitmapEncoder }
      else {
        $e = New-Object Windows.Media.Imaging.JpegBitmapEncoder
        $e.QualityLevel = 90
        $f = New-Object Windows.Media.Imaging.FormatConvertedBitmap($f, [Windows.Media.PixelFormats]::Bgr24, $null, 0)
      }
      $e.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($f))
      $o = [IO.File]::Open($j.out, [IO.FileMode]::CreateNew)
      $made = $true
      try { $e.Save($o) } finally { $o.Close() }
      Write-Output ('ok ' + $j.i)
    } finally { $s.Close() }
  } catch {
    if ($made) { Remove-Item -LiteralPath $j.out -Force -ErrorAction SilentlyContinue }
    Write-Output ('err ' + $j.i + ' ' + $_.Exception.HResult)
  }
}`

/** Windows printer list (names may be Korean, so UTF-8) */
const WIN_PRINTERS = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Get-CimInstance Win32_Printer | Select-Object Name, Default, WorkOffline, PrinterStatus | ConvertTo-Json -Compress`

/** Windows printing: sends to that printer through the "Print to" (PrintTo) verb of the app that opens the file */
const WIN_PRINT = `
$ErrorActionPreference = 'Stop'
Start-Process -FilePath $env:DOOL2_FILE -Verb PrintTo -ArgumentList ('"' + $env:DOOL2_PRINTER + '"') -WindowStyle Hidden`
