// 일한 기록 (문제를 찾을 때 보는 것): 연결하기·서비스 도구·답 한 차례·확장 연결이 어떻게 됐는지를 이 PC에 며칠만 남긴다.
//
// - 날마다 파일 하나 (<데이터 폴더>/logs/2026-11-18.jsonl), 한 줄에 한 가지 일
// - 멈춘 순간의 화면은 그림으로 (logs/shots/), 글 기록보다 짧게 둔다
// - 며칠 지나면 지운다 (글 7일, 그림 3일). 다 합쳐 정해 둔 크기를 넘으면 오래된 것부터 지운다
// - 아이디·비밀번호·인증번호는 적지 않는다. 글에 섞여 온 이메일·긴 숫자도 가린다
// - 이 PC 밖으로 나가지 않는다 (본체 API로만 읽는다)
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** 글 기록을 두는 날 수 */
export const KEEP_DAYS = 7
/** 화면 그림을 두는 날 수 */
export const SHOT_DAYS = 3
/** 기록 전체 크기 한도 */
export const MAX_BYTES = 40 * 1024 * 1024

export interface JournalEntry {
  /** 언제 (ISO) */
  at: string
  /** 무슨 일: connect-start · connect-step · connect-end · tool · turn · extension · note … */
  kind: string
  [field: string]: unknown
}

export interface JournalOptions {
  keepDays?: number
  shotDays?: number
  maxBytes?: number
  now?: () => Date
}

/** 값을 적으면 안 되는 칸 이름 */
const SECRET_KEY = /pass|pw$|^pw|secret|token|otp|credential|비밀|암호|인증번호/i

/** 가리지 않고 그대로 두는 칸 (본체가 만든 값: 그림 파일 이름, 시각) */
const PLAIN_KEY = new Set(['shot', 't'])

/** 글에 섞인 개인 정보 가리기: 이메일은 앞 한 글자만, 6자리 넘는 숫자(전화·인증번호·카드)는 별표로 */
export function scrubText(text: string, max = 400): string {
  return text
    .replace(/([\w.+-])[\w.+-]*@([\w-]+\.[\w.-]+)/g, '$1***@$2')
    .replace(/\d[\d\s-]{4,}\d/g, (m) => (m.replace(/\D/g, '').length >= 6 ? '***' : m))
    .slice(0, max)
}

/** 주소에서 물음표 뒤(검색어·토큰이 실린다)를 뗀다 */
export function scrubUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`.slice(0, 200)
  } catch {
    return ''
  }
}

function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return depth > 3 ? [] : value.slice(0, 40).map((v) => scrub(v, depth + 1))
  if (value && typeof value === 'object') {
    if (depth > 3) return {}
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue
      // 그림 파일 이름·시각은 그대로 (숫자 가리기에 걸리면 그림을 못 찾고 언제인지 모른다)
      out[k] = SECRET_KEY.test(k)
        ? '(가림)'
        : PLAIN_KEY.has(k) && typeof v === 'string'
          ? v.slice(0, 80)
          : scrub(v, depth + 1)
    }
    return out
  }
  return undefined
}

const day = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export class Journal {
  private readonly keepDays: number
  private readonly shotDays: number
  private readonly maxBytes: number
  private readonly now: () => Date
  private timer?: ReturnType<typeof setInterval>
  private seq = 0

  /** dir이 없으면 아무것도 남기지 않는다 (테스트·점검 모드) */
  constructor(
    private readonly dir?: string,
    opts: JournalOptions = {},
  ) {
    this.keepDays = opts.keepDays ?? KEEP_DAYS
    this.shotDays = opts.shotDays ?? SHOT_DAYS
    this.maxBytes = opts.maxBytes ?? MAX_BYTES
    this.now = opts.now ?? (() => new Date())
    if (!dir) return
    try {
      mkdirSync(join(dir, 'shots'), { recursive: true })
      this.prune()
      // 켜 둔 채 며칠이 지나도 지워지게
      this.timer = setInterval(() => this.prune(), 6 * 3600_000)
      this.timer.unref?.()
    } catch {}
  }

  get shotsDir(): string | undefined {
    return this.dir ? join(this.dir, 'shots') : undefined
  }

  /** 한 줄 남기기. 기록을 못 남겨도 하던 일은 계속한다 */
  write(kind: string, fields: Record<string, unknown> = {}) {
    if (!this.dir) return
    const at = this.now()
    const entry = { at: at.toISOString(), kind, ...(scrub(fields) as Record<string, unknown>) }
    try {
      appendFileSync(join(this.dir, `${day(at)}.jsonl`), `${JSON.stringify(entry)}\n`)
    } catch {}
  }

  /** 화면 그림 남기기 (JPEG base64). 파일 이름을 돌려준다 */
  shot(label: string, base64: string): string | undefined {
    if (!this.dir || !base64) return undefined
    const at = this.now()
    const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
    const name = `${stamp}-${String(++this.seq).padStart(2, '0')}-${label.replace(/[^\w-]/g, '').slice(0, 40) || 'shot'}.jpg`
    try {
      writeFileSync(join(this.dir, 'shots', name), Buffer.from(base64, 'base64'))
      return name
    } catch {
      return undefined
    }
  }

  /** 최근 기록 읽기 (오래된 것부터). kind를 주면 그 말로 시작하는 것만 */
  read(o: { days?: number; kind?: string; limit?: number } = {}): JournalEntry[] {
    if (!this.dir) return []
    const days = Math.min(Math.max(o.days ?? 2, 1), this.keepDays)
    const from = day(new Date(this.now().getTime() - (days - 1) * 86_400_000))
    const out: JournalEntry[] = []
    for (const f of this.dayFiles()) {
      if (f.slice(0, 10) < from) continue
      let raw = ''
      try {
        raw = readFileSync(join(this.dir, f), 'utf8')
      } catch {
        continue
      }
      for (const line of raw.split('\n')) {
        if (!line) continue
        try {
          const e = JSON.parse(line) as JournalEntry
          if (!o.kind || e.kind.startsWith(o.kind)) out.push(e)
        } catch {}
      }
    }
    return o.limit ? out.slice(-o.limit) : out
  }

  /** 날짜가 지난 기록·그림을 지우고, 그래도 크면 오래된 것부터 더 지운다 */
  prune() {
    if (!this.dir) return
    const now = this.now().getTime()
    const oldest = day(new Date(now - (this.keepDays - 1) * 86_400_000))
    try {
      for (const f of this.dayFiles()) if (f.slice(0, 10) < oldest) rmSync(join(this.dir, f), { force: true })
      const shots = this.shotFiles()
      for (const s of shots) if (now - s.mtime > this.shotDays * 86_400_000) rmSync(s.path, { force: true })
      // 크기 한도: 그림부터, 그다음 오래된 날 기록
      const left = [
        ...this.shotFiles(),
        ...this.dayFiles()
          .slice(0, -1)
          .map((f) => {
            const path = join(this.dir as string, f)
            const st = statSync(path)
            return { path, size: st.size, mtime: st.mtimeMs }
          }),
      ]
      let total =
        left.reduce((n, f) => n + f.size, 0) +
        (this.dayFiles()
          .slice(-1)
          .map((f) => statSync(join(this.dir as string, f)).size)[0] ?? 0)
      for (const f of left) {
        if (total <= this.maxBytes) break
        rmSync(f.path, { force: true })
        total -= f.size
      }
    } catch {}
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private dayFiles(): string[] {
    if (!this.dir || !existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
  }

  private shotFiles(): { path: string; size: number; mtime: number }[] {
    const dir = this.shotsDir
    if (!dir || !existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jpg'))
      .sort()
      .map((f) => {
        const path = join(dir, f)
        const st = statSync(path)
        return { path, size: st.size, mtime: st.mtimeMs }
      })
  }
}
