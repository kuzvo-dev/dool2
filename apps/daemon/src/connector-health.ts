// 서비스 도구 건강 기록 (ADR 0020): 실행할 때마다 결과를 남기고, 잇달아 깨지는 도구는 잠시 쉬게 한다.
// 사이트가 바뀌어 막힌 도구를 같은 사용자가 계속 만나지 않게. 쉬는 동안 두리는 범용 브라우저로 일을 끝낸다.
// 기록은 이 PC에만 남는다.
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

/** ok 잘 됨 · broke 막힘(시끄러운 고장) · empty 칸이 빔(조용한 고장) · stopped 정상 멈춤(마감·로그인 필요 등) */
export type Outcome = 'ok' | 'broke' | 'empty' | 'stopped' | 'blocked'

interface Rec {
  at: number
  outcome: Outcome
  detail?: string
  /** 도구 정의 지문: 정의가 바뀌면(고친 도구가 들어오면) 예전 고장은 세지 않는다 */
  v?: string
}

/** 잇달아 이만큼 깨지면 쉰다 */
export const REST_AFTER = 3
/** 깨진 기록을 이 안에서만 센다 */
export const REST_WINDOW_MS = 24 * 3600_000
/** 쉬는 시간 (지나면 다음 부탁에서 한 번 다시 해 본다) */
export const REST_MS = 6 * 3600_000

const bad = (o: Outcome) => o === 'broke' || o === 'empty'

export class ConnectorHealth {
  private data: Record<string, Rec[]> = {}
  private saving?: Promise<void>

  constructor(
    private readonly file?: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!file) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (raw && typeof raw === 'object') this.data = raw as Record<string, Rec[]>
    } catch {}
  }

  record(tool: string, outcome: Outcome, detail?: string, v?: string) {
    const list = this.data[tool] ?? []
    this.data[tool] = list
    list.push({
      at: this.now(),
      outcome,
      ...(detail ? { detail: detail.slice(0, 200) } : {}),
      ...(v ? { v } : {}),
    })
    if (list.length > 20) list.splice(0, list.length - 20)
    this.save()
  }

  /** 쉬는 중이면 언제까지·왜. v(지금 정의의 지문)를 주면 다른 정의 때의 기록은 넘긴다 */
  resting(tool: string, v?: string): { until: number; reason: string } | undefined {
    const list = (this.data[tool] ?? []).filter((r) => !v || !r.v || r.v === v)
    const last = list.slice(-REST_AFTER)
    if (last.length < REST_AFTER || !last.every((r) => bad(r.outcome))) return undefined
    const first = last[0] as Rec
    const end = last.at(-1) as Rec
    if (this.now() - first.at > REST_WINDOW_MS) return undefined
    const until = end.at + REST_MS
    if (this.now() >= until) return undefined
    return { until, reason: end.detail ?? (end.outcome === 'empty' ? '결과 칸이 비어 와요' : '막혀요') }
  }

  /** 도구마다 마지막 결과와 하루 안 고장 수 (화면·점검용) */
  summary(): Record<string, { last: Outcome; at: number; failures24h: number; resting: boolean }> {
    const out: Record<string, { last: Outcome; at: number; failures24h: number; resting: boolean }> = {}
    for (const [tool, list] of Object.entries(this.data)) {
      const end = list.at(-1)
      if (!end) continue
      out[tool] = {
        last: end.outcome,
        at: end.at,
        failures24h: list.filter((r) => bad(r.outcome) && this.now() - r.at < REST_WINDOW_MS).length,
        resting: Boolean(this.resting(tool)),
      }
    }
    return out
  }

  private save() {
    if (!this.file || this.saving) return
    const file = this.file
    // 잇단 실행을 한 번에 쓰기
    this.saving = new Promise<void>((r) => setTimeout(r, 500))
      .then(() => writeFile(file, JSON.stringify(this.data)))
      .catch(() => {})
      .finally(() => {
        this.saving = undefined
      })
  }
}
