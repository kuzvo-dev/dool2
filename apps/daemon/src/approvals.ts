// 승인 게이트 (docs/architecture.md 4장, M3).
// 위험한 버튼(돈·연락·되돌릴 수 없음)은 AI가 누를 수 없다. AI는 "이 버튼을 눌러도 될지" 요청만 하고,
// 사용자가 화면 캡처와 내용을 보고 승인하면 **두리 본체가** 그 버튼 하나만 직접 누른다.
// - 한 번만 쓸 수 있고, 10분이 지나면 끝난다
// - 누르기 직전 페이지를 다시 읽어, 승인한 버튼(글자)과 주소가 그대로일 때만 누른다
// - AI가 적은 금액·내용은 틀릴 수 있다(프롬프트 주입). 그래서 승인 카드에 실제 화면 캡처를 함께 보여 준다
// 폰 생체인증 서명은 폰 앱(M6)과 함께 붙는다. 지금은 PC 앱의 화면용 토큰을 가진 쪽(사용자 화면)만 승인할 수 있다.
import { randomUUID } from 'node:crypto'
import type { ApprovalView } from '@dool2/protocol'

export const APPROVAL_TTL_MS = 10 * 60_000
/** 끝난 요청을 남겨 두는 시간 (폰 기록용). 지나면 지운다 — 본체가 하루 내내 켜져 있어도 쌓이지 않게 */
export const APPROVAL_KEEP_MS = 60 * 60_000

export interface ApprovalRecord extends ApprovalView {
  /** 승인 카드에 보여 줄 화면 캡처 (JPEG base64) */
  shot?: string
  /** 선택지 id → 결제 화면의 그 칸(표시와 글자). 화면에는 보내지 않는다 */
  choiceRefs?: Record<string, { ref: string; role: string; name: string; near?: string }>
  /** 세부 선택 묶음 → 그 펼침 목록 표시와 고를 것 글자들 */
  subRefs?: Record<string, { ref: string; options: string[] }>
}

export interface NewApproval {
  tabId: number
  ref: string
  role: string
  label: string
  url: string
  kind: ApprovalView['kind']
  reason: string
  what: string
  where: string
  amount?: string
  cancel?: string
  items?: string[]
  shot?: string
  choices?: ApprovalView['choices']
  choiceTitle?: string
  chose?: string[]
  choice?: string
  choiceRefs?: ApprovalRecord['choiceRefs']
  subChoices?: ApprovalView['subChoices']
  subRefs?: ApprovalRecord['subRefs']
  shipOptions?: ApprovalView['shipOptions']
  shipWarn?: string
  title?: string
  goods?: ApprovalView['goods']
  lines?: ApprovalView['lines']
  info?: ApprovalView['info']
}

export class Approvals {
  private items = new Map<string, ApprovalRecord>()
  /** 새 승인 요청이 생기면 (폰에 알리기) */
  onCreate?: (rec: ApprovalRecord) => void

  constructor(private readonly now: () => number = Date.now) {}

  create(n: NewApproval): ApprovalRecord {
    const t = this.now()
    this.prune(t)
    // 같은 탭·같은 버튼에 기다리는 요청이 있으면 새것으로 바꾼다
    for (const r of this.items.values())
      if (r.status === 'pending' && r.tabId === n.tabId && r.ref === n.ref && r.url === n.url)
        r.status = 'expired'
    const rec: ApprovalRecord = {
      ...n,
      id: randomUUID(),
      status: 'pending',
      createdAt: new Date(t).toISOString(),
      expiresAt: new Date(t + APPROVAL_TTL_MS).toISOString(),
    }
    this.items.set(rec.id, rec)
    this.onCreate?.(rec)
    return rec
  }

  get(id: string): ApprovalRecord | undefined {
    const r = this.items.get(id)
    if (r?.status === 'pending' && Date.parse(r.expiresAt) <= this.now()) {
      r.status = 'expired'
      r.shot = undefined
    }
    return r
  }

  list(): ApprovalView[] {
    return [...this.items.keys()].map((id) => {
      const { shot: _s, ...view } = this.get(id) as ApprovalRecord
      return view
    })
  }

  /** 기다리는 요청을 하나 꺼내 처리 중으로 바꾼다. 이미 처리됐거나 만료됐으면 undefined */
  take(id: string): ApprovalRecord | undefined {
    const r = this.get(id)
    if (!r || r.status !== 'pending') return undefined
    r.status = 'approved'
    return r
  }

  reject(id: string): boolean {
    const r = this.get(id)
    if (!r || r.status !== 'pending') return false
    r.status = 'rejected'
    r.shot = undefined
    return true
  }

  /** 탭이 닫히면 그 탭에서 기다리던 요청은 더 누를 수 없다. 새 요청이 같은 탭의 예전 요청을 대신할 때도 쓴다 */
  expireTab(tabId: number) {
    for (const r of this.items.values())
      if (r.status === 'pending' && r.tabId === tabId) {
        r.status = 'expired'
        r.shot = undefined
        this.onChange?.(r)
      }
  }
  /** 기다리던 요청이 만료됐을 때 (폰 카드를 닫는다) */
  onChange?: (rec: ApprovalRecord) => void

  /** 끝난 지 오래된 요청을 지우고, 끝난 요청의 화면 캡처(수백 KB)는 바로 버린다 */
  private prune(now: number) {
    for (const [id, r] of this.items) {
      this.get(id)
      if (r.status === 'pending') continue
      r.shot = undefined
      if (now - Date.parse(r.createdAt) > APPROVAL_KEEP_MS) this.items.delete(id)
    }
  }

  finish(id: string, ok: boolean, result: string) {
    const r = this.items.get(id)
    if (!r) return
    r.status = ok ? 'done' : 'failed'
    r.result = result
    r.shot = undefined
  }
}
