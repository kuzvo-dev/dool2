/**
 * 끝내기 전 검사 (ADR 0027): 두리가 도구로 일한 차례가 끝나면 따로 부른 AI가
 * "부탁 대비 끝났나, 남은 게 정말 사람 몫인가"를 판정한다. 안 끝났으면 같은 대화에 이어서 하라고 되돌려 보낸다.
 * 횟수는 일마다 다르다: 기본 2번, 새 도구를 써서 진전이 있으면 4번까지, 같은 이유로 두 번 막히면·20분 넘으면 멈춘다.
 */

export interface Verdict {
  done: boolean
  why: string
  next?: string
}

export interface FinishCheckOptions {
  /** 판정 글을 보내고 답 글을 받는다 (도구 없는 새 세션). 실패하면 undefined */
  ask: (prompt: string) => Promise<string | undefined>
  now?: () => number
  /** 진전이 없을 때 되돌려 보내는 횟수 */
  baseCycles?: number
  /** 진전이 있을 때 늘려 주는 최대 횟수 */
  maxCycles?: number
  /** 부탁을 받은 뒤 이 시간이 지나면 더 보내지 않는다 */
  maxMs?: number
}

interface AskState {
  gen: number
  ask: string
  started: number
  /** 되돌려 보낸 횟수 */
  cycles: number
  /** 지금까지 쓴 도구 */
  tools: Set<string>
  whys: string[]
}

export type CheckResult =
  | { kind: 'skip'; reason: string }
  | { kind: 'done'; why: string; cycles: number }
  | { kind: 'stop'; why: string; cycles: number; reason: string }
  | { kind: 'again'; why: string; next?: string; cycles: number; note: string }

/** 판정 AI에게 주는 지침 */
export const JUDGE_SYSTEM = [
  '당신은 개인 비서 AI "두리"의 일을 검사하는 사람이에요. 도구는 없고, 판정만 해요.',
  '두리가 할 수 있는 일: 사용자 PC의 브라우저로 사용자가 로그인해 둔 사이트·연결한 서비스 조회와 조작, 메일 찾기, 웹 검색, 기억(사용자 정보) 찾기·저장, 계정 찾기·가입, 서류 떼기, 초안 만들기, 비교·계산·추정.',
  '사람에게 넘겨도 되는 것은 이것뿐이에요: 결제 승인, 본인 인증(문자·인증서·간편 인증), 밖으로 보내기(문의·접수·메일·글 올리기) 승인, 사용자만 아는 사실(취향·결정·연결 안 된 곳의 비밀번호).',
  '사용자만 아는 것처럼 보여도, 메일·연결된 서비스·기억·고지서·결제 내역에서 찾거나 추정할 길이 남았으면 두리 몫이에요.',
  '남에게 보내는 요청·접수에 넣을 사실(주소·날짜·증상)을 사용자만 알면 그걸 모아 묻고 멈춘 건 끝난 거예요. 지어낸 값으로 보내라고 하지 마세요.',
  '"전화해 보세요"·"앱에서 하세요"·"직접 확인하세요"로 끝냈는데 두리가 웹으로 더 해 볼 길이 있으면 끝난 게 아니에요.',
  '부탁에서 요구한 것(예: 3곳 비교, 예약까지, 신청서 채우기)이 빠졌으면 끝난 게 아니에요. 승인 카드를 띄우고 기다리는 중이면 끝난 걸로 봐요.',
  '답은 JSON 한 줄만: {"done": true|false, "why": "남은 것 또는 끝난 이유 한 문장", "next": "안 끝났으면 두리가 해 볼 다른 길 한 문장"}',
].join('\n')

export function judgePrompt(i: { ask: string; answer: string; tools: string[]; cycle: number }): string {
  const tools = [...new Set(i.tools)].slice(0, 30).join(', ') || '(없음)'
  return [
    `사용자 부탁:\n${i.ask.slice(0, 1500)}`,
    `두리가 이번까지 쓴 도구: ${tools}`,
    i.cycle > 0 ? `(이미 ${i.cycle}번 되돌려 보냈어요. 정말 더 할 길이 있을 때만 false)` : '',
    `두리의 마지막 답:\n${i.answer.slice(0, 3000)}`,
    '이 부탁이 두리 몫까지 다 끝났나요? JSON 한 줄로만 답하세요.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function parseVerdict(text: string | undefined): Verdict | undefined {
  const m = text?.match(/\{[\s\S]*\}/)
  if (!m) return undefined
  try {
    const v = JSON.parse(m[0]) as Partial<Verdict>
    if (typeof v.done !== 'boolean') return undefined
    const why = typeof v.why === 'string' ? v.why.trim().slice(0, 200) : ''
    const next = typeof v.next === 'string' && v.next.trim() ? v.next.trim().slice(0, 200) : undefined
    return { done: v.done, why, ...(next ? { next } : {}) }
  } catch {
    return undefined
  }
}

/** 두 이유가 같은 막힘인지 (글자 두 개씩 겹치는 비율) */
export function sameBlocker(a: string, b: string): boolean {
  const grams = (s: string) => {
    const t = s.replace(/\s+/g, '')
    const out = new Set<string>()
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
    return out
  }
  const x = grams(a)
  const y = grams(b)
  if (!x.size || !y.size) return false
  let both = 0
  for (const g of x) if (y.has(g)) both++
  return both / Math.min(x.size, y.size) >= 0.6
}

export class FinishCheck {
  private readonly asks = new Map<string, AskState>()
  private gen = 0
  private readonly now: () => number

  constructor(private readonly opts: FinishCheckOptions) {
    this.now = opts.now ?? Date.now
  }

  /** 사용자가 새 부탁을 했다 (앱 알림이 아닌 말) */
  begin(threadId: string, ask: string): void {
    this.asks.set(threadId, {
      gen: ++this.gen,
      ask,
      started: this.now(),
      cycles: 0,
      tools: new Set(),
      whys: [],
    })
  }

  /** 지금 하고 있는 부탁 글 */
  askOf(threadId: string): string | undefined {
    return this.asks.get(threadId)?.ask
  }

  /** 사용자가 멈췄다: 이 부탁은 더 이어서 하지 않는다 */
  drop(threadId: string): void {
    this.asks.delete(threadId)
  }

  /** 지금 부탁의 번호 (판정하는 사이 새 부탁이 왔는지 보려고) */
  current(threadId: string): number | undefined {
    return this.asks.get(threadId)?.gen
  }

  async check(threadId: string, turn: { answer: string; tools: string[] }): Promise<CheckResult> {
    const s = this.asks.get(threadId)
    if (!s) return { kind: 'skip', reason: '부탁 없음' }
    const fresh = turn.tools.filter((t) => !s.tools.has(t))
    for (const t of turn.tools) s.tools.add(t)
    if (!s.tools.size) return { kind: 'skip', reason: '도구 안 씀' }
    if (!turn.answer.trim()) return { kind: 'skip', reason: '답 없음' }
    // 진전(앞에서 안 써 본 도구)이 있으면 최대까지, 없으면 기본 횟수까지
    const limit = fresh.length > 0 ? (this.opts.maxCycles ?? 4) : (this.opts.baseCycles ?? 2)
    const v = parseVerdict(
      await this.opts.ask(
        judgePrompt({ ask: s.ask, answer: turn.answer, tools: [...s.tools], cycle: s.cycles }),
      ),
    )
    if (!v) return { kind: 'skip', reason: '판정 실패' }
    if (v.done) {
      this.asks.delete(threadId)
      return { kind: 'done', why: v.why, cycles: s.cycles }
    }
    const stop = (reason: string): CheckResult => {
      this.asks.delete(threadId)
      return { kind: 'stop', why: v.why, cycles: s.cycles, reason }
    }
    if (s.cycles >= limit) return stop('횟수')
    if (this.now() - s.started > (this.opts.maxMs ?? 20 * 60_000)) return stop('시간')
    if (s.whys.some((w) => sameBlocker(w, v.why))) return stop('같은 막힘')
    s.whys.push(v.why)
    s.cycles++
    return {
      kind: 'again',
      why: v.why,
      ...(v.next ? { next: v.next } : {}),
      cycles: s.cycles,
      note: againNote(v),
    }
  }
}

/** 되돌려 보내는 알림 (첫 문장만 화면에 보이고 나머지는 AI에게만) */
export function againNote(v: Verdict): string {
  return [
    '끝내기 전에 다시 보니 남은 게 있어서 이어서 할게요.',
    `(끝내기 전 검사) 아직 남았어요: ${v.why}`,
    v.next ? `해 볼 길: ${v.next}` : '',
    '같은 방법은 되풀이하지 말고 다른 길로 이어서 해 주세요. 사용자만 아는 것이면 메일·연결된 곳·기억에서 먼저 찾거나 추정하고, 정말 없을 때만 한 번에 모아서 물어요. 끝나면 결과→한 일→남은 것 순서로 한 번에 알려 주세요.',
  ]
    .filter(Boolean)
    .join(' ')
}
