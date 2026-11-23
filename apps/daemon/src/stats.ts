// 사용 통계 (사용자가 동의했을 때만, 숫자만). 베타가 잘 쓰이는지 보려고 하루 단위 숫자를 dool2.com/api/stats로 보낸다.
// 보내는 것: 무작위 기기 번호(이 PC에서 만든 것, 이름·계정과 연결 안 됨), 날짜, 앱 버전·운영체제,
// 그날 부탁 수·답한 수·도구 성공/실패 수·끝내기 전 검사 결과 수, AI·확장 연결 여부, 연결한 서비스 개수.
// 대화 내용·사이트·파일 이름·서비스 이름은 보내지 않는다. 켜져 있는 동안 1시간마다 오늘 숫자를 고쳐 보낸다(같은 날은 덮어씀)
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JournalEntry } from './journal.js'

export const STATS_URL = 'https://dool2.com/api/stats'

export interface DayStats {
  iid: string
  day: string
  version: string
  platform: string
  arch: string
  turns: number
  answered: number
  toolsOk: number
  toolsFail: number
  finishDone: number
  finishAgain: number
  agents: string[]
  extension: boolean
  connections: number
}

/** 이 PC의 날짜 (YYYY-MM-DD, 현지 시간) */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 그날 기록에서 숫자만 센다 */
export function countDay(entries: JournalEntry[], day: string) {
  const c = { turns: 0, answered: 0, toolsOk: 0, toolsFail: 0, finishDone: 0, finishAgain: 0 }
  for (const e of entries) {
    if (localDay(new Date(e.at)) !== day) continue
    if (e.kind === 'turn') {
      c.turns++
      if (e.answered === true) c.answered++
    } else if (e.kind === 'tool' || e.kind === 'file-tool') {
      if (e.ok === false) c.toolsFail++
      else if (e.ok === true) c.toolsOk++
    } else if (e.kind === 'finish-check') {
      if (e.result === 'done') c.finishDone++
      else if (e.result === 'again') c.finishAgain++
    }
  }
  return c
}

export interface StatsDeps {
  /** 기기 번호·마지막 보낸 날을 둘 폴더 (데이터 폴더) */
  dir: string
  /** 사용자가 동의했는지 (설정 usageStats === true) */
  enabled: () => boolean
  version: string
  entries: () => JournalEntry[]
  /** 지금 상태 (로그인된 AI id, 확장 연결, 연결한 서비스 개수) */
  status: () => Promise<{ agents: string[]; extension: boolean; connections: number }>
  fetch?: typeof fetch
  now?: () => Date
  url?: string
}

export class StatsReporter {
  private timer?: NodeJS.Timeout
  constructor(private readonly d: StatsDeps) {}

  private async state(): Promise<{ iid: string; sent?: string }> {
    const file = join(this.d.dir, 'stats.json')
    if (existsSync(file)) {
      try {
        const s = JSON.parse(await readFile(file, 'utf8')) as { iid?: string; sent?: string }
        if (s.iid) return { iid: s.iid, ...(s.sent ? { sent: s.sent } : {}) }
      } catch {}
    }
    const s = { iid: randomUUID() }
    await writeFile(file, JSON.stringify(s), { mode: 0o600 })
    return s
  }

  private async save(s: { iid: string; sent?: string }) {
    await writeFile(join(this.d.dir, 'stats.json'), JSON.stringify(s), { mode: 0o600 }).catch(() => undefined)
  }

  /** 보낼 숫자 (동의 화면의 '무엇을 보내나요' 보기에도 쓴다) */
  async build(day: string, iid = 'example'): Promise<DayStats> {
    const st = await this.d.status().catch(() => ({ agents: [], extension: false, connections: 0 }))
    return {
      iid,
      day,
      version: this.d.version,
      platform: process.platform,
      arch: process.arch,
      ...countDay(this.d.entries(), day),
      agents: st.agents,
      extension: st.extension,
      connections: st.connections,
    }
  }

  /** 오늘 숫자를 보낸다. 날이 바뀌었으면 어제 것을 마지막으로 한 번 더 (꺼져 있던 날은 기록으로 채운다) */
  async tick(): Promise<number> {
    if (!this.d.enabled()) return 0
    const now = (this.d.now ?? (() => new Date()))()
    const today = localDay(now)
    const s = await this.state()
    const days = [today]
    if (s.sent && s.sent !== today) days.unshift(s.sent)
    let sent = 0
    for (const day of days) {
      const body = await this.build(day, s.iid)
      const r = await (this.d.fetch ?? fetch)(this.d.url ?? STATS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined)
      if (r?.ok) sent++
    }
    if (sent) await this.save({ iid: s.iid, sent: today })
    return sent
  }

  start() {
    const run = () => void this.tick().catch(() => undefined)
    setTimeout(run, 60_000).unref?.()
    this.timer = setInterval(run, 60 * 60_000)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }
}
