// PC 파일 도구 둘째 묶음 (ADR 0024): 옮기기·이름 바꾸기, 사진 형식 바꾸기, 종이로 출력.
// 볼 수 있는 폴더(바탕화면·문서·다운로드·사진·동영상) 안에서만 하고(ADR 0022), 덮어쓰기·지우기는 없다.
// - 옮기기: 2개 이상이면 승인 카드(무엇을 어디로 — 목록)를 거치고, 옮긴 기록을 남겨 되돌릴 수 있다
// - 사진 바꾸기: 원본은 그대로 두고 새 파일을 만든다 (맥 sips, 윈도우 WPF 이미지 부품)
// - 출력: 종이가 나가는 일이라 늘 승인을 거친다 (맥 lp, 윈도우 파일을 여는 프로그램의 인쇄)
// - PDF 합치기·나누기(pdf-edit.ts), HTML을 PDF·PNG로(render.ts), 휴지통에서 되살리기(trash.ts), 내려받기(download.ts), 화면 잠그기(pc-power.ts)

import { execFile } from 'node:child_process'
import { constants, existsSync, realpathSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, sep } from 'node:path'
import type { Approvals } from './approvals.js'
import { download } from './download.js'
import { cleanName, freeName } from './file-names.js'
import { POWER_LABEL, POWER_OFF_TEXT, type PowerAction, powerCheck, powerDo } from './pc-power.js'
import { pdfText } from './pdf.js'
import { pdfTool } from './pdf-edit.js'
import { type HtmlRenderer, type RenderedFile, renderTool } from './render.js'
import { type TrashItem, trashList, trashRestore } from './trash.js'

export { cleanName, freeName } from './file-names.js'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  /** 프로그램이 없어서 못 돌렸을 때 */
  missing?: boolean
}
/** 바깥 프로그램 돌리기. 시험에서는 바꿔 끼운다 (실제 프린터로 보내지 않게) */
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

/** FileTools가 넘겨주는 경로 도우미 (볼 수 있는 폴더 경계는 한곳에서만 정한다) */
export interface FileScope {
  /** 볼 수 있는 폴더 안의 있는 경로 (실제 경로) */
  inside(p: string): string | undefined
  /** 아직 없을 수도 있는 폴더 경로: 있는 데까지 실제 경로로 바꿔 경계 안인지 본다 */
  insideNew(p: string): string | undefined
  /** 사용자에게 보여 줄 모양 (~/Downloads/a.pdf) */
  show(p: string): string
  /** 바탕화면·문서·다운로드·사진·동영상 폴더 자체 */
  roots(): string[]
  /** 손대지 않는 파일 (숨은 파일·인증서·키·비밀번호) */
  sensitive(p: string): boolean
  /** 홈 폴더 (실제 경로) */
  home: string
  /** 바탕화면·문서·다운로드·사진·동영상 중 하나의 첫 폴더 */
  folder(key: 'desktop' | 'documents' | 'downloads'): string | undefined
  /** 파일 읽기 (맥 iCloud에만 있는 파일은 내려받아). 못 읽으면 이유(글) */
  read(p: string): Promise<Buffer | string>
}

export interface FileOpsOptions {
  approvals?: Approvals
  /** 옮긴 기록 파일 (되돌리기용). 없으면 메모리에만 */
  movesLog?: string
  exec?: Exec
  platform?: NodeJS.Platform
  /** 사진 바꾸기 한 번에 쓰는 시간 (넘으면 거기까지 하고 이어서 하라고 알린다) */
  convertBudgetMs?: number
  /** 두리가 지금 하는 일: 답하는 대화 수와 연결 중인 서비스 (잠자기 전에 본다) */
  busy?: () => { turns: number; connecting: string[] }
  /** 내려받기 (시험에서 바꿔 끼운다) */
  fetch?: typeof fetch
  resolve?: typeof import('node:dns/promises').lookup
  downloadWaitMs?: number
  /** HTML을 PDF·PNG로 그리는 부품 (PC 앱이 준다). 없으면 file_render가 못 한다고 알린다 */
  renderFile?: HtmlRenderer
  /** 그리기 한 번에 기다리는 시간 (시험에서 줄인다) */
  renderTimeoutMs?: number
}

interface TrashPlan {
  item: TrashItem
  dest: string
  /** 사용자에게 보일 까닭 (원래 자리 / 바탕화면에 둔 까닭) */
  why: string
}

interface MovePlan {
  from: string
  to: string
  /** 같은 이름이 있어 번호를 붙였는지 */
  numbered?: boolean
}
interface MoveBatch {
  id: string
  at: string
  items: MovePlan[]
  /** 이번에 새로 만든 폴더 (되돌릴 때 비어 있으면 지운다) */
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

/** 승인 카드가 대화의 기록과 짝을 맞추는 표시 (파일 일은 탭이 없어 -2) */
export const FILE_TAB = -2

const IMG_EXT = /^\.(heic|heif|png|webp|jpe?g|tiff?|gif|bmp)$/i
const PRINT_EXT = /^\.(pdf|txt|jpe?g|png|gif|tiff?)$/i
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

  // ── 옮기기·이름 바꾸기 ─────────────────────────────

  async move(args: Record<string, unknown>): Promise<FileToolResult> {
    if (args.undo === true) return this.undo()
    const list = Array.isArray(args.moves) ? (args.moves as Record<string, unknown>[]) : []
    if (!list.length) return fail('옮길 것을 moves에 주세요. 되돌리려면 undo: true.')
    if (list.length > MAX_MOVES) return fail(`한 번에 ${MAX_MOVES}개까지만 옮겨요. 나눠서 부탁해 주세요.`)
    const taken = new Set<string>()
    const plan: MovePlan[] = []
    const skipped: string[] = []
    const roots = this.scope.roots()
    for (const m of list) {
      const raw = String(m?.from ?? '')
      const src = this.scope.inside(raw)
      const label = basename(raw) || raw
      if (!src) {
        skipped.push(`${label}(없거나 볼 수 있는 폴더 밖이에요)`)
        continue
      }
      if (roots.includes(src)) {
        skipped.push(`${label}(바탕화면·문서·다운로드·사진·동영상 폴더 자체는 옮기지 않아요)`)
        continue
      }
      if (this.scope.sensitive(src)) {
        skipped.push(`${label}(인증서·키·숨은 파일은 손대지 않아요)`)
        continue
      }
      const folder = typeof m.folder === 'string' && m.folder.trim() ? m.folder.trim() : undefined
      const dir = folder ? this.scope.insideNew(folder) : dirname(src)
      if (!dir) {
        skipped.push(`${label}(옮길 곳 "${folder}"이 바탕화면·문서·다운로드·사진·동영상 밖이에요)`)
        continue
      }
      if (dir === src || dir.startsWith(src + sep)) {
        skipped.push(`${label}(폴더를 자기 안으로는 못 옮겨요)`)
        continue
      }
      const s = await stat(src)
      let name = basename(src)
      if (typeof m.name === 'string' && m.name.trim()) {
        name = cleanName(m.name)
        const ext = extname(src)
        // 확장자는 그대로 둔다 (바꾸면 파일이 안 열린다. 형식 바꾸기는 file_convert)
        if (!s.isDirectory() && ext && extname(name).toLowerCase() !== ext.toLowerCase()) name += ext
        if (!name || name === ext) {
          skipped.push(`${label}(새 이름이 비었어요)`)
          continue
        }
      }
      const want = join(dir, name)
      if (want === src) {
        skipped.push(`${label}(이미 그 자리·그 이름이에요)`)
        continue
      }
      // 맥·윈도우는 대소문자만 다른 이름을 같은 파일로 본다: 그건 이름 바꾸기로 둔다
      const same = existsSync(want) && realOf(want) === src
      const to = same ? want : freeName(dir, name, taken)
      plan.push({ from: src, to, ...(to !== want ? { numbered: true } : {}) })
    }
    if (!plan.length) return fail(`옮길 수 있는 것이 없어요: ${skipped.join(', ')}`)
    const skipNote = skipped.length
      ? `\n건너뛴 것 ${skipped.length}개: ${skipped.slice(0, 20).join(', ')}`
      : ''
    // 하나만 부탁하면 바로 한다 (되돌릴 수 있다). 여럿이면 목록으로 승인을 받는다
    if (list.length < 2) {
      const r = await this.doMove(plan)
      return { ...(r.ok ? {} : { isError: true }), content: [{ type: 'text', text: r.message + skipNote }] }
    }
    if (!this.approvals) return fail('승인을 받을 수 없어 여러 개는 옮기지 않았어요.')
    const made = [...new Set(plan.flatMap((p) => this.missingDirs(dirname(p.to))))]
    const where = [...new Set(plan.map((p) => this.rootLabel(p.to)))].join('·')
    const rec = this.approvals.create({
      tabId: FILE_TAB,
      ref: 'file_move',
      role: '파일',
      label: '옮기기',
      url: 'file:move',
      kind: 'file',
      reason: '파일 옮기기·이름 바꾸기',
      what: `파일 ${plan.length}개 옮기기${made.length ? ` · 새 폴더 ${made.map((d) => basename(d)).join('·')}` : ''}`.slice(
        0,
        200,
      ),
      where,
      items: plan.map((p) => this.line(p)),
      cancel: '되돌리기: "방금 옮긴 것 되돌려 줘"라고 하면 원래 자리로 돌려놔요',
    })
    this.pending.set(rec.id, { kind: 'move', items: plan })
    return ok(
      `승인을 요청했어요(${rec.id.slice(0, 8)}). 옮길 것 ${plan.length}개${made.length ? `, 새로 만들 폴더 ${made.length}개` : ''}:\n` +
        plan
          .slice(0, 40)
          .map((p) => `- ${this.line(p)}`)
          .join('\n') +
        (plan.length > 40 ? `\n… 외 ${plan.length - 40}개` : '') +
        skipNote +
        '\n사용자에게 무엇을 어디로 옮길지 한두 문장으로 말하고 이번 답은 여기서 끝내세요. 승인하면 두리가 이 목록대로만 옮기고 다음 메시지로 결과를 알려 줘요.',
    )
  }

  /** 승인 카드·결과에 보이는 한 줄: "a.pdf → ~/Downloads/영수증/" (이름이 바뀌면 새 이름까지) */
  private line(p: MovePlan) {
    const renamed = basename(p.to) !== basename(p.from)
    return `${basename(p.from)} → ${this.scope.show(dirname(p.to))}${sep}${renamed ? basename(p.to) : ''}`
  }

  private rootLabel(p: string) {
    return this.scope.show(this.scope.roots().find((r) => p.startsWith(r + sep)) ?? dirname(p))
  }

  /** 아직 없는 폴더들 (위에서부터) */
  private missingDirs(dir: string): string[] {
    const out: string[] = []
    for (let d = dir; !existsSync(d) && dirname(d) !== d; d = dirname(d)) out.unshift(d)
    return out
  }

  private async doMove(plan: MovePlan[]): Promise<{ ok: boolean; message: string }> {
    const made = new Set<string>()
    const done: MovePlan[] = []
    const failed: string[] = []
    const renamed: string[] = []
    const taken = new Set<string>()
    for (const p of plan) {
      try {
        if (!existsSync(p.from)) throw new Error('그 사이 없어졌어요')
        for (const d of this.missingDirs(dirname(p.to))) made.add(d)
        await mkdir(dirname(p.to), { recursive: true })
        // 승인한 뒤 같은 이름이 생겼을 수 있다: 바로 직전에 다시 보고 번호를 붙인다
        const same = existsSync(p.to) && realOf(p.to) === p.from
        const to = same ? p.to : existsSync(p.to) ? freeName(dirname(p.to), basename(p.to), taken) : p.to
        await moveFile(p.from, to)
        if (p.numbered || to !== p.to) renamed.push(basename(to))
        done.push({ from: p.from, to })
      } catch (e) {
        failed.push(`${basename(p.from)}(${(e as Error).message})`)
      }
    }
    if (done.length) await this.record({ items: done, made: [...made] })
    const folders = [...new Set(done.map((d) => this.scope.show(dirname(d.to))))]
    const message =
      (done.length
        ? `${done.length}개를 옮겼어요 → ${folders.slice(0, 6).join(', ')}${folders.length > 6 ? ` 외 ${folders.length - 6}곳` : ''}.`
        : '하나도 옮기지 못했어요.') +
      (made.size
        ? ` 새로 만든 폴더: ${[...made]
            .map((d) => basename(d))
            .slice(0, 10)
            .join('·')}.`
        : '') +
      (renamed.length
        ? ` 같은 이름이 있어 번호를 붙인 것: ${renamed.slice(0, 10).join(', ')}${renamed.length > 10 ? ' …' : ''}.`
        : '') +
      (failed.length ? ` 못 옮긴 것 ${failed.length}개: ${failed.slice(0, 10).join(', ')}.` : '') +
      (done.length ? ' 되돌리려면 file_move에 undo: true ("방금 옮긴 것 되돌려 줘").' : '')
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

  /** 마지막으로 옮긴 묶음을 원래 자리로. 원래 자리에 같은 이름이 생겼으면 번호를 붙인다 */
  private async undo(): Promise<FileToolResult> {
    const list = await this.load()
    const b = [...list].reverse().find((x) => !x.undone)
    if (!b) return fail('되돌릴 옮긴 기록이 없어요.')
    const back: string[] = []
    const failed: string[] = []
    const taken = new Set<string>()
    for (const it of [...b.items].reverse()) {
      try {
        if (!existsSync(it.to)) throw new Error('옮긴 자리에 없어요. 그 뒤에 옮기거나 지운 것 같아요')
        const same = existsSync(it.from) && realOf(it.from) === it.to
        const dest =
          same || !existsSync(it.from) ? it.from : freeName(dirname(it.from), basename(it.from), taken)
        await mkdir(dirname(dest), { recursive: true })
        await moveFile(it.to, dest)
        back.push(dest === it.from ? basename(dest) : `${basename(dest)}(같은 이름이 있어 번호를 붙였어요)`)
      } catch (e) {
        failed.push(`${basename(it.to)}(${(e as Error).message})`)
      }
    }
    // 이번에 만든 폴더가 비었으면 치운다 (안에 다른 게 있으면 그대로)
    for (const d of [...b.made].reverse()) await rmdir(d).catch(() => undefined)
    b.undone = true
    await this.save()
    const when = new Date(b.at).toLocaleString('ko-KR', {
      timeZone: 'Asia/Seoul',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
    const more = list.some((x) => !x.undone)
    return {
      ...(back.length ? {} : { isError: true }),
      content: [
        {
          type: 'text',
          text:
            `${when}에 옮긴 ${b.items.length}개 중 ${back.length}개를 원래 자리로 돌려놨어요.` +
            (back.length ? ` (${back.slice(0, 10).join(', ')}${back.length > 10 ? ' …' : ''})` : '') +
            (failed.length ? ` 못 돌려놓은 것 ${failed.length}개: ${failed.slice(0, 10).join(', ')}.` : '') +
            (more ? ' 그 전에 옮긴 것도 있어요. 더 되돌리려면 undo: true를 한 번 더.' : ''),
        },
      ],
    }
  }

  // ── 사진 형식 바꾸기 ─────────────────────────────

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
    if (!paths.length) return fail('바꿀 사진(또는 사진이 든 폴더)을 paths에 주세요.')
    const outDir =
      typeof args.folder === 'string' && args.folder.trim()
        ? this.scope.insideNew(args.folder.trim())
        : undefined
    if (typeof args.folder === 'string' && args.folder.trim() && !outDir)
      return fail('새 파일을 둘 폴더는 바탕화면·문서·다운로드·사진·동영상 안이어야 해요.')
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
        skipped.push(`${basename(raw)}(없거나 볼 수 있는 폴더 밖이에요)`)
        continue
      }
      if (this.scope.sensitive(p)) continue
      const s = await stat(p)
      if (s.isDirectory()) {
        const entries = await readdir(p, { withFileTypes: true })
        for (const e of entries)
          if (e.isFile() && !e.name.startsWith('.') && want(e.name)) sources.push(join(p, e.name))
      } else if (!IMG_EXT.test(extname(p))) skipped.push(`${basename(p)}(사진 파일이 아니에요)`)
      else if (isTarget(extname(p))) skipped.push(`${basename(p)}(이미 ${to.toUpperCase()}예요)`)
      else sources.push(p)
    }
    const uniq = [...new Set(sources)]
    if (!uniq.length)
      return fail(
        `바꿀 사진을 찾지 못했어요${skipped.length ? `: ${skipped.slice(0, 10).join(', ')}` : '. 폴더를 줬다면 그 바로 안의 사진만 봐요(아래 폴더는 따로 주세요).'}`,
      )
    if (uniq.length > MAX_CONVERT) return fail(`한 번에 ${MAX_CONVERT}개까지만 바꿔요. 폴더를 나눠 주세요.`)
    if (this.platform !== 'darwin' && this.platform !== 'win32')
      return fail(
        '이 PC에서는 아직 사진 형식을 못 바꿔요(맥·윈도우만). 사진 앱에서 JPG로 내보내 달라고 안내해 주세요.',
      )

    // 새 파일 이름: 같은 이름이 있으면, 원본보다 새것이면 이미 바꾼 것으로 보고 건너뛴다
    const taken = new Set<string>()
    const jobs: { src: string; out: string }[] = []
    for (const src of uniq) {
      const dir = outDir ?? dirname(src)
      const name = `${basename(src, extname(src))}.${to}`
      const at = join(dir, name)
      if (existsSync(at)) {
        const [a, b] = await Promise.all([stat(at), stat(src)])
        if (a.mtimeMs >= b.mtimeMs) {
          skipped.push(`${basename(src)}(바꾼 ${name}이 이미 있어요)`)
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
            failed.push(`${basename(j.src)}(${firstLine(r.stderr) || '바꾸지 못했어요'})`)
          }
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()])
    } else {
      // 윈도우: 20개씩 PowerShell 한 번으로 (WPF 이미지 부품. HEIC·WEBP는 그 형식을 여는 확장이 깔려 있어야 한다)
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
          // 0x88982F50(-2003292336): 그 형식을 여는 부품(코덱)이 없다
          const codec = /-2003292336|88982F50/i.test(lines.find((l) => l.startsWith(`err ${i} `)) ?? '')
          if (codec) missingCodec = true
          failed.push(
            `${basename(j.src)}(${codec ? '이 PC에 이 형식을 여는 부품이 없어요' : firstLine(r.stderr) || '바꾸지 못했어요'})`,
          )
        }
      }
    }
    const left = jobs.length - next
    const shownDir = [...new Set(done.map((d) => this.scope.show(dirname(d))))]
    const text =
      (done.length
        ? `${done.length}개를 ${to.toUpperCase()}로 바꿨어요(원본은 그대로 뒀어요). 새 파일: ${done
            .slice(0, 5)
            .map((d) => basename(d))
            .join(
              ', ',
            )}${done.length > 5 ? ` 외 ${done.length - 5}개` : ''} → ${shownDir.slice(0, 3).join(', ')}.`
        : '하나도 바꾸지 못했어요.') +
      (left > 0
        ? ` 시간이 걸려 ${jobs.length}개 중 ${jobs.length - left}개까지 했어요. 같은 입력으로 다시 부르면 이미 바꾼 것은 건너뛰고 남은 ${left}개를 이어서 해요.`
        : '') +
      (skipped.length
        ? ` 건너뛴 것 ${skipped.length}개: ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? ' …' : ''}.`
        : '') +
      (failed.length ? ` 못 바꾼 것 ${failed.length}개: ${failed.slice(0, 8).join(', ')}.` : '') +
      (missingCodec
        ? ' HEIC는 Microsoft Store의 "HEIF 이미지 확장"(WEBP는 "WebP 이미지 확장")을 깔면 바꿀 수 있어요. 아니면 아이폰 설정 > 사진 > "Mac 또는 PC로 전송"을 "자동"으로 두면 처음부터 JPG로 옮겨져요.'
        : '')
    return { ...(done.length || left > 0 ? {} : { isError: true }), content: [{ type: 'text', text }] }
  }

  // ── 출력 ─────────────────────────────────────────

  async print(args: Record<string, unknown>): Promise<FileToolResult> {
    const printers = await this.printers()
    if (typeof printers === 'string') return fail(printers)
    const real = printers.filter((p) => !p.virtual)
    const listText = () =>
      printers
        .map(
          (p) =>
            `- ${p.name}${p.isDefault ? ' (기본)' : ''}: ${p.problem ?? '쓸 수 있어요'}${p.virtual ? ' · 종이가 나오지 않는 가상 프린터' : ''}`,
        )
        .join('\n')
    if (!real.length)
      return fail(
        `이 PC에 연결된 프린터가 없어요${printers.length ? `(가상 프린터만 있어요: ${printers.map((p) => p.name).join(', ')})` : ''}. ` +
          (this.platform === 'win32'
            ? '설정 > 블루투스 및 장치 > 프린터 및 스캐너에서 집 프린터를 추가해 달라고 안내해 주세요.'
            : '시스템 설정 > 프린터 및 스캐너에서 [+]로 집 프린터를 추가해 달라고 안내해 주세요(같은 와이파이에 켜져 있어야 보여요).') +
          ' 추가한 뒤 다시 부탁하면 출력해요.',
      )
    if (typeof args.path !== 'string' || !args.path.trim())
      return ok(`프린터 ${printers.length}대:\n${listText()}\n출력하려면 file_print에 path(파일)를 주세요.`)

    const p = this.scope.inside(args.path)
    if (!p)
      return fail(
        '바탕화면·문서·다운로드·사진·동영상 안의 파일만 출력할 수 있어요. file_find로 경로를 먼저 찾아 주세요.',
      )
    if (this.scope.sensitive(p)) return fail('인증서·키·비밀번호 같은 민감한 파일은 출력하지 않아요.')
    const s = await stat(p)
    if (s.isDirectory()) return fail('폴더는 출력할 수 없어요. 그 안의 파일을 골라 주세요.')
    const ext = extname(p)
    if (/^\.(heic|heif|webp)$/i.test(ext))
      return fail(
        '이 사진 형식은 바로 출력하지 못해요. file_convert로 JPG로 바꾼 뒤 그 파일을 출력해 주세요.',
      )
    if (!PRINT_EXT.test(ext))
      return fail(
        `${ext || '이'} 파일은 바로 출력하지 못해요(PDF·사진·txt만). 워드·엑셀·한글 문서는 그 프로그램에서 PDF로 저장해 주시면 바로 출력할 수 있다고 알려 주세요. 같은 이름의 PDF가 있는지 file_find로 먼저 찾아봐도 좋아요.`,
      )

    let printer = real.find((x) => x.isDefault)
    if (typeof args.printer === 'string' && args.printer.trim()) {
      const want = args.printer.trim().normalize('NFC').toLowerCase()
      printer = printers.find((x) => x.name.normalize('NFC').toLowerCase() === want)
      if (!printer) return fail(`"${args.printer}" 프린터가 없어요. 이 PC의 프린터:\n${listText()}`)
      if (printer.virtual) return fail(`${printer.name}은(는) 종이가 나오지 않는 가상 프린터예요.`)
    }
    if (!printer && real.length === 1) printer = real[0]
    if (!printer)
      return fail(
        `기본 프린터가 없고 프린터가 여러 대예요. 어느 것으로 할지 사용자에게 물어 printer로 주세요:\n${listText()}`,
      )
    if (printer.problem)
      return fail(
        `${printer.name}: ${printer.problem}. 프린터 전원과 와이파이(또는 선) 연결을 확인하고 다시 부탁해 달라고 알려 주세요. 다른 프린터가 있으면:\n${listText()}`,
      )
    const copies = Math.min(Math.max(Math.floor(Number(args.copies) || 1), 1), 20)
    const pages =
      typeof args.pages === 'string' && args.pages.trim() ? args.pages.replace(/\s+/g, '') : undefined
    if (pages && !/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(pages)) return fail('쪽은 "1-3,5"처럼 주세요.')
    if (!this.approvals) return fail('승인을 받을 수 없어 출력하지 않았어요.')
    // PDF는 쪽 수를 세어 몇 장이 나올지 알려 준다
    let sheets = ''
    if (/^\.pdf$/i.test(ext) && s.size < 30 << 20)
      try {
        const n = (await pdfText(await readFile(p))).pages
        sheets = pages ? ` · PDF ${n}쪽 중 ${pages}쪽` : ` · ${n}쪽 × ${copies}부 = ${n * copies}장`
      } catch {}
    const name = basename(p)
    const rec = this.approvals.create({
      tabId: FILE_TAB,
      ref: 'file_print',
      role: '프린터',
      label: '출력',
      url: 'file:print',
      kind: 'print',
      reason: '종이가 나가는 일',
      what: `"${name}" ${copies}부 출력${pages ? ` (${pages}쪽)` : ''}`,
      where: printer.name,
      items: [`${this.scope.show(p)}${sheets}`],
      ...(this.platform === 'win32' && pages
        ? { cancel: '윈도우에서는 쪽을 골라 출력하지 못해 전부 나와요' }
        : {}),
    })
    this.pending.set(rec.id, {
      kind: 'print',
      path: p,
      printer: printer.name,
      copies,
      ...(pages ? { pages } : {}),
    })
    return ok(
      `승인을 요청했어요(${rec.id.slice(0, 8)}). 프린터 ${printer.name}에 "${name}" ${copies}부${sheets}. ` +
        '사용자에게 무엇을 몇 부 출력할지 한 문장으로 말하고 이번 답은 여기서 끝내세요. 승인하면 두리가 그 파일만 프린터로 보내고 다음 메시지로 결과를 알려 줘요.',
    )
  }

  /** 프린터 목록과 상태. 출력 명령이 없으면 이유(글) */
  private async printers(): Promise<
    { name: string; isDefault: boolean; problem?: string; virtual?: boolean }[] | string
  > {
    if (this.platform === 'win32') {
      const r = await this.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PRINTERS])
      if (r.code !== 0 && !r.stdout.trim()) return `프린터 목록을 읽지 못했어요: ${firstLine(r.stderr)}`
      let rows: { Name?: string; Default?: boolean; WorkOffline?: boolean; PrinterStatus?: number }[] = []
      try {
        const v = JSON.parse(r.stdout.trim() || '[]')
        rows = Array.isArray(v) ? v : [v]
      } catch {
        return '프린터 목록을 읽지 못했어요.'
      }
      return rows
        .filter((x) => x.Name)
        .map((x) => ({
          name: String(x.Name),
          isDefault: Boolean(x.Default),
          ...(x.WorkOffline || x.PrinterStatus === 7
            ? { problem: '꺼져 있거나 연결이 끊겼어요(오프라인)' }
            : x.PrinterStatus === 6
              ? { problem: '출력이 멈춰 있어요' }
              : {}),
          ...(/pdf|xps|onenote|fax|팩스/i.test(String(x.Name)) ? { virtual: true } : {}),
        }))
    }
    // 맥(CUPS): lpstat 글은 맥 언어 설정을 따라 바뀌므로 이름은 lpstat -e, 상태는 lpoptions의 printer-state로 본다
    const e = await this.exec('lpstat', ['-e'])
    if (e.missing) return '이 PC에서는 출력 명령(lp)을 찾지 못했어요.'
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
            ? '출력이 멈춰 있어요(일시 정지). 시스템 설정 > 프린터 및 스캐너 > 프린터 대기열에서 [다시 시작]을 눌러 달라고 알려 주세요'
            : /offline/.test(reasons)
              ? '꺼져 있거나 연결이 끊겼어요(오프라인)'
              : /media-empty|media-needed/.test(reasons)
                ? '용지가 없어요'
                : undefined
        return { name, isDefault: name === def, ...(problem ? { problem } : {}) }
      }),
    )
  }

  // ── PDF 합치기·나누기 ─────────────────────────────

  pdf(args: Record<string, unknown>): Promise<FileToolResult> {
    return pdfTool(this.scope, args)
  }

  // ── HTML을 PDF·PNG로 (render.ts) ───────────────────

  /** 그려 만든 파일 (보관함에 올린다) */
  onRendered?: (f: RenderedFile) => void
  render(args: Record<string, unknown>): Promise<FileToolResult> {
    return renderTool(this.scope, args, this.opts.renderFile, this.onRendered, this.opts.renderTimeoutMs)
  }

  // ── 휴지통에서 찾기·되살리기 ─────────────────────────

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
          '휴지통이 비어 있어요. 이미 비웠다면 두리는 되살릴 수 없어요. iCloud·OneDrive에 있던 파일이면 그 서비스의 "최근 삭제된 항목"을 확인해 보라고 알려 주세요.',
        )
      if (!hits.length)
        return ok(
          `휴지통(${list.length}개)에서 "${String(args.query ?? '')}"이(가) 들어간 것을 못 찾았어요. 다른 낱말로 찾아보거나, iCloud·OneDrive에 있던 파일이면 그 서비스의 "최근 삭제된 항목"을 확인해 보라고 알려 주세요.`,
        )
      return ok(
        `휴지통에서 ${hits.length > 30 ? `${hits.length}개 중 최근 30개` : `${hits.length}개`}:\n` +
          hits
            .slice(0, 30)
            .map(
              (x) =>
                `- ${x.name}${x.dir ? sep : ''}${x.at ? ` · 지운 때 ${day(x.at)}` : ''} · 원래 자리 ${x.from ? this.showAny(x.from) : '모름'} · restore: ${JSON.stringify(x.id)}`,
            )
            .join('\n') +
          '\n되살리려면 file_trash에 restore: [위의 restore 값]을 주세요. 원래 자리를 모르거나 두리가 손댈 수 없는 폴더면 바탕화면에 둬요.',
      )
    }
    const desk = this.scope.folder('desktop') ?? this.scope.folder('downloads')
    if (!desk) return fail('되살린 파일을 둘 바탕화면 폴더를 찾지 못했어요.')
    const plan: TrashPlan[] = []
    const skipped: string[] = []
    for (const id of restore) {
      const item = list.find((x) => x.id === id) ?? list.find((x) => x.name === id)
      if (!item) {
        skipped.push(`${id}(휴지통에 없어요)`)
        continue
      }
      const back = item.from ? this.scope.inside(item.from) : undefined
      plan.push(
        back
          ? { item, dest: back, why: '원래 자리' }
          : {
              item,
              dest: desk,
              why: item.from
                ? `원래 자리 ${this.showAny(item.from)}는 두리가 손대는 폴더가 아니라 바탕화면`
                : '원래 자리를 몰라 바탕화면',
            },
      )
    }
    if (!plan.length)
      return fail(
        `되살릴 것이 없어요: ${skipped.join(', ')}. file_trash로 먼저 찾아 restore 값을 그대로 주세요.`,
      )
    const skipNote = skipped.length ? ` 못 찾은 것: ${skipped.join(', ')}.` : ''
    if (restore.length < 2) {
      const r = await this.doTrash(plan)
      return { ...(r.ok ? {} : { isError: true }), content: [{ type: 'text', text: r.message + skipNote }] }
    }
    if (!this.approvals) return fail('승인을 받을 수 없어 여러 개는 되살리지 않았어요.')
    const lines = plan.map((p) => `${p.item.name} → ${this.scope.show(p.dest)}${sep} (${p.why})`)
    const rec = this.approvals.create({
      tabId: FILE_TAB,
      ref: 'file_trash',
      role: '휴지통',
      label: '되살리기',
      url: 'file:trash',
      kind: 'file',
      reason: '휴지통에서 되살리기',
      what: `휴지통에서 ${plan.length}개 되살리기`,
      where: '휴지통',
      items: lines,
    })
    this.pending.set(rec.id, { kind: 'trash', items: plan })
    return ok(
      `승인을 요청했어요(${rec.id.slice(0, 8)}). 되살릴 것 ${plan.length}개:\n${lines.map((l) => `- ${l}`).join('\n')}${skipNote}` +
        '\n사용자에게 무엇을 어디로 되살릴지 한두 문장으로 말하고 이번 답은 여기서 끝내세요. 승인하면 두리가 이 목록대로만 되살리고 다음 메시지로 결과를 알려 줘요.',
    )
  }

  private async doTrash(plan: TrashPlan[]): Promise<{ ok: boolean; message: string }> {
    const done: string[] = []
    const failed: string[] = []
    const taken = new Set<string>()
    for (const p of plan) {
      try {
        let dest = p.dest
        let name = basename(freeName(dest, p.item.name, taken))
        // 윈도우 셸은 원래 이름으로만 꺼낸다: 같은 이름이 있으면 새 빈 폴더에 꺼낸다 (덮어쓰지 않게)
        if (this.platform === 'win32' && name !== p.item.name) {
          dest = freeName(dest, '휴지통에서 되살린 파일', taken)
          name = p.item.name
        }
        await mkdir(dest, { recursive: true })
        await trashRestore(this.trashCtx(), p.item, dest, name)
        done.push(
          `${p.item.name} → ${this.scope.show(join(dest, name))} (${p.why}${name !== p.item.name ? ', 같은 이름이 있어 번호를 붙였어요' : ''})`,
        )
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        failed.push(
          `${p.item.name}(${code === 'EPERM' || code === 'EACCES' ? '맥이 막았어요. Finder 휴지통에서 "되돌려 놓기"를 눌러 달라고 알려 주세요' : (e as Error).message})`,
        )
      }
    }
    return {
      ok: done.length > 0,
      message:
        (done.length
          ? `${done.length}개를 되살렸어요: ${done.slice(0, 10).join(', ')}.`
          : '하나도 되살리지 못했어요.') +
        (failed.length ? ` 못 되살린 것: ${failed.slice(0, 10).join(', ')}.` : ''),
    }
  }

  /** 볼 수 있는 폴더 밖 경로도 사용자에게 보일 모양으로 (~/…) */
  private showAny(p: string) {
    const home = this.scope.home
    return p === home || p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p
  }

  // ── 파일 내려받기 ─────────────────────────────────

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
    if (!url) return fail('받을 주소(url)를 주세요.')
    const dir = this.scope.folder('downloads')
    if (!dir) return fail('다운로드 폴더를 찾지 못했어요.')
    const name = typeof args.name === 'string' && args.name.trim() ? args.name : undefined
    const show = (p: string) => this.scope.show(p)
    const r = await download(dir, url, { ...(name ? { name } : {}), show }, this.downloadDeps())
    if (r.kind === 'fail') return fail(r.text)
    if (r.kind === 'done') return ok(r.text)
    // 실행 파일: 받기 전에 승인
    if (args.confirm !== true)
      return fail(
        `"${r.name}"는 실행 파일(열면 프로그램이 도는 파일)이라 받기 전에 사용자 승인이 필요해요. 공식 사이트 주소인지 확인하고, 같은 url에 confirm: true를 더해 다시 불러 승인을 요청하세요.`,
      )
    if (!this.approvals) return fail('승인을 받을 수 없어 실행 파일은 받지 않았어요.')
    const size = r.size ? ` · ${(r.size / (1 << 20)).toFixed(1)}MB` : ''
    const rec = this.approvals.create({
      tabId: FILE_TAB,
      ref: 'file_download',
      role: '파일',
      label: '받기',
      url: 'file:download',
      kind: 'file',
      reason: '실행 파일 받기',
      what: `"${r.name}" 받기 (실행 파일${size})`,
      where: r.host,
      items: [url.slice(0, 300)],
      cancel: '받기만 해요. 여는 건 사용자가 직접 하고, 처음 여는 프로그램은 맥·윈도우가 한 번 더 확인해요',
    })
    this.pending.set(rec.id, { kind: 'download', url, ...(name ? { name } : {}) })
    return ok(
      `승인을 요청했어요(${rec.id.slice(0, 8)}). ${r.host}의 "${r.name}"${size}. 사용자에게 어디서 무엇을 받을지 한 문장으로 말하고 이번 답은 여기서 끝내세요. 승인하면 두리가 다운로드 폴더에 받고 다음 메시지로 결과를 알려 줘요.`,
    )
  }

  private async doDownload(url: string, name?: string): Promise<{ ok: boolean; message: string }> {
    const dir = this.scope.folder('downloads')
    if (!dir) return { ok: false, message: '다운로드 폴더를 찾지 못했어요.' }
    const show = (p: string) => this.scope.show(p)
    const r = await download(
      dir,
      url,
      { ...(name ? { name } : {}), approved: true, show },
      this.downloadDeps(),
    )
    if (r.kind === 'done') return { ok: true, message: r.text }
    return { ok: false, message: r.kind === 'fail' ? r.text : '받지 못했어요.' }
  }

  // ── 화면 잠그기·잠자기 ──────────────────────────────

  /** 두리가 하는 다른 일 (잠자기하면 멈춘다). min은 지금 부른 대화만큼 빼고 본다 */
  private otherWork(min: number): string | undefined {
    const b = this.opts.busy?.()
    if (!b) return undefined
    const parts = [
      ...(b.turns > min ? [`답하는 대화 ${b.turns - min}개`] : []),
      ...(b.connecting.length ? [`${b.connecting.slice(0, 3).join('·')} 연결`] : []),
    ]
    return parts.length ? parts.join(', ') : undefined
  }

  async power(args: Record<string, unknown>): Promise<FileToolResult> {
    const action = String(args.action ?? '')
    if (action === 'off') return ok(POWER_OFF_TEXT)
    if (action !== 'lock' && action !== 'sleep')
      return fail('action은 lock(화면 잠그기)·sleep(잠자기)·off(끄기 부탁) 중 하나예요.')
    if (action === 'sleep') {
      const other = this.otherWork(1)
      if (other)
        return fail(
          `지금 두리가 다른 일(${other})을 하는 중이라 잠자기하면 그 일이 멈춰요. 끝난 뒤에 다시 부탁해 달라고 하거나, 화면 잠그기(lock)는 일을 멈추지 않으니 그걸 권해 주세요.`,
        )
    }
    const check = await powerCheck(action, this.platform, this.exec)
    if (!check.ok) return fail(check.why)
    if (!this.approvals) return fail('승인을 받을 수 없어 하지 않았어요.')
    const label = POWER_LABEL[action]
    const rec = this.approvals.create({
      tabId: FILE_TAB,
      ref: 'pc_screen',
      role: 'PC',
      label,
      url: 'file:pc',
      kind: 'pc',
      reason: action === 'sleep' ? '잠자기하면 두리도 멈춰요' : '화면 잠그기',
      what: `이 PC ${label}`,
      where: '이 PC',
      cancel:
        check.note ??
        (action === 'lock'
          ? '잠가도 두리는 하던 일을 계속해요'
          : '다시 열면 하던 그대로예요. 잠자는 동안 두리는 폰 부탁을 받지 못해요'),
    })
    this.pending.set(rec.id, { kind: 'power', action })
    return ok(
      `승인을 요청했어요(${rec.id.slice(0, 8)}). 사용자에게 "${label}"을 승인해 달라고 한 문장으로 말하고 이번 답은 여기서 끝내세요. 승인하면 두리가 바로 해요.` +
        (check.note ? ` (${check.note})` : ''),
    )
  }

  private async doPower(action: PowerAction): Promise<{ ok: boolean; message: string }> {
    if (action === 'sleep') {
      const other = this.otherWork(0)
      if (other)
        return {
          ok: false,
          message: `두리가 아직 다른 일(${other})을 하는 중이라 잠자기하지 않았어요. 끝난 뒤에 다시 부탁해 주세요.`,
        }
      // 승인 결과가 화면·폰에 닿을 틈을 두고 잠든다
      setTimeout(() => void powerDo('sleep', this.platform, this.exec), 3000).unref()
      return { ok: true, message: '3초 뒤 PC가 잠자기에 들어가요. 다시 열면 하던 그대로예요.' }
    }
    const why = await powerDo('lock', this.platform, this.exec)
    return why
      ? { ok: false, message: `화면을 잠그지 못했어요: ${why}` }
      : { ok: true, message: '화면을 잠갔어요. 두리는 하던 일을 계속해요.' }
  }

  // ── 승인 뒤 ──────────────────────────────────────

  /** 사용자가 승인한 그 일 하나만 한다 */
  async approve(id: string): Promise<{ ok: boolean; message: string }> {
    const rec = this.approvals?.take(id)
    if (!rec) return { ok: false, message: '이미 처리했거나 시간이 지난 승인 요청이에요' }
    const plan = this.pending.get(id)
    this.pending.delete(id)
    const finish = (r: { ok: boolean; message: string }) => {
      this.approvals?.finish(id, r.ok, r.message)
      return r
    }
    if (!plan)
      return finish({ ok: false, message: '두리를 다시 켜서 승인할 내용이 사라졌어요. 다시 부탁해 주세요.' })
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
    if (!existsSync(p.path)) return { ok: false, message: '출력할 파일이 그 사이 없어졌어요.' }
    const name = basename(p.path)
    if (this.platform === 'win32') {
      // 파일을 여는 프로그램(PDF 보기·사진 앱 등)에게 인쇄를 시킨다. 매수만큼 보낸다
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
          return {
            ok: false,
            message: `프린터로 보내지 못했어요(${firstLine(r.stderr) || '이 파일을 인쇄할 프로그램이 없어요'}). 파일을 열어 Ctrl+P로 출력해 달라고 알려 주세요.`,
          }
      }
      return {
        ok: true,
        message: `프린터 ${p.printer}에 "${name}" ${p.copies}부를 보냈어요. 종이가 안 나오면 프린터 전원·용지를 확인해 달라고 알려 주세요.`,
      }
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
      return { ok: false, message: `프린터로 보내지 못했어요: ${firstLine(r.stderr) || '알 수 없는 이유'}` }
    const job = /([\w.-]+-\d+)/.exec(r.stdout)?.[1]
    return {
      ok: true,
      message: `프린터 ${p.printer}에 "${name}" ${p.copies}부를 보냈어요${job ? `(작업 ${job})` : ''}. 종이가 안 나오면 프린터 전원·용지·잉크를 확인해 달라고 알려 주세요.`,
    }
  }
}

/** 이름 비교 모양 (맥은 한글 이름을 자모로 나눠 저장한다) */
const norm = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, '')
const day = (t: number) =>
  new Date(t).toLocaleString('ko-KR', {
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

/** 옮기기: 같은 디스크면 rename, 다른 디스크(EXDEV)면 복사한 뒤 원본을 치운다(파일만) */
async function moveFile(from: string, to: string) {
  try {
    await rename(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    if ((await stat(from)).isDirectory()) throw new Error('다른 디스크로는 폴더를 옮기지 못해요')
    await copyFile(from, to, constants.COPYFILE_EXCL)
    await rm(from)
  }
}

/** 윈도우 사진 바꾸기: DOOL2_JOBS([{i,src,out,fmt}])를 차례로. 줄마다 "ok i" 또는 "err i HRESULT 메시지" */
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

/** 윈도우 프린터 목록 (이름은 한글일 수 있어 UTF-8로) */
const WIN_PRINTERS = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Get-CimInstance Win32_Printer | Select-Object Name, Default, WorkOffline, PrinterStatus | ConvertTo-Json -Compress`

/** 윈도우 출력: 파일을 여는 프로그램의 "인쇄 대상"(PrintTo)으로 그 프린터에 보낸다 */
const WIN_PRINT = `
$ErrorActionPreference = 'Stop'
Start-Process -FilePath $env:DOOL2_FILE -Verb PrintTo -ArgumentList ('"' + $env:DOOL2_PRINTER + '"') -WindowStyle Hidden`
