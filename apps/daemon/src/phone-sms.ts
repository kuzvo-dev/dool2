// 문자 보내기 (내 폰 번호로). AI는 받는 사람(이름이나 번호)과 글만 정한다.
// 사용자가 폰의 승인 카드에서 받는 사람·글을 보고 승인하면 폰 앱이 직접 보낸다 (다른 앱으로 넘기지 않는다).
// 이름이면 폰이 자기 연락처에서 번호를 찾는다: 번호는 PC·AI로 오지 않는다.
// 폰은 보낸 결과(sms-result)를 승인 서명(decide)보다 먼저 보낸다. PC는 서명이 맞을 때만 그 결과를 끝으로 적는다.
import type { Approvals } from './approvals.js'
import type { ToolResult } from './browser-tools.js'

/** 문자 승인의 탭 자리 (화면 제어 -1, PC 파일 -2) */
export const PHONE_TAB = -3

export interface PhoneSupport {
  /** 짝지은 폰 수 */
  paired: number
  /** 켜진 뒤 인사한 폰 중 문자 보내기가 되는 폰 수 / 안 되는 폰 수 (예전 앱). 아직 아무도 인사 안 했으면 둘 다 0 */
  sms: number
  old: number
}

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] })
const err = (t: string): ToolResult => ({ isError: true, content: [{ type: 'text', text: t }] })

export function isSmsApproval(url: string | undefined): boolean {
  return typeof url === 'string' && url.startsWith('sms:')
}

export class PhoneSms {
  private results = new Map<string, { ok: boolean; message: string }>()
  private waiters = new Map<string, (r: { ok: boolean; message: string }) => void>()

  constructor(
    private readonly approvals: Approvals,
    private readonly support: () => PhoneSupport,
    private readonly waitMs = 15_000,
  ) {}

  /** phone_sms: 승인 카드를 만든다 (보내기는 폰이) */
  request(args: Record<string, unknown>): ToolResult {
    const to = String(args.to ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40)
    const body = String(args.text ?? '').trim()
    if (!to) return err('to가 필요해요: 받는 사람의 연락처 이름(예: 엄마, 김민수 팀장님) 또는 전화번호.')
    if (!body) return err('text가 필요해요: 보낼 글 그대로.')
    if (body.length > 1000) return err('문자는 1000자까지만 보낼 수 있어요. 줄여서 다시 불러 주세요.')
    const s = this.support()
    if (!s.paired)
      return err(
        '문자는 사용자 폰의 두리 앱이 보내요. 아직 폰 앱이 연결돼 있지 않아요. 보낼 글은 show_draft(via: sms)로 붙여 두고, 폰 앱을 연결하면 바로 보낼 수 있다고 한 문장으로 알려 주세요.',
      )
    // 모든 폰이 예전 앱일 때만 막는다 (새 앱 폰이 하나라도 있거나, 아직 인사하지 않은 폰이 있으면 카드를 띄운다)
    if (!s.sms && s.old >= s.paired)
      return err(
        '연결된 폰 앱이 예전 판이라 문자를 보낼 수 없어요. 보낼 글은 show_draft(via: sms)로 붙여 두고, 폰 앱을 새 판으로 업데이트하면 보낼 수 있다고 한 문장으로 알려 주세요.',
      )
    const rec = this.approvals.create({
      tabId: PHONE_TAB,
      ref: 'sms',
      role: '문자',
      label: to,
      url: `sms:${to}`,
      kind: 'contact',
      reason: '다른 사람에게 문자를 보내요',
      what: body,
      where: '내 폰 문자',
      cancel: '보낸 문자는 되돌릴 수 없어요',
    })
    return text(
      `문자 승인 카드를 폰에 띄웠어요(${rec.id.slice(0, 8)}). 받는 사람 번호는 폰이 연락처에서 찾아 카드에 보여 주고, 여러 명이면 사용자가 골라요. ` +
        '사용자에게 "폰에서 받는 사람과 글을 확인하고 승인해 주세요"라고 한 문장으로 말하고 이번 답은 여기서 끝내세요. 승인하면 폰이 바로 보내고 결과가 이어서 와요.',
    )
  }

  /** 폰이 보낸 결과. 아직 승인 서명이 오기 전이라 적어 두기만 한다 */
  result(id: string, r: { ok: boolean; message: string }) {
    const rec = this.approvals.get(id)
    if (!rec || !isSmsApproval(rec.url) || rec.status !== 'pending') return
    this.results.set(id, r)
    this.waiters.get(id)?.(r)
  }

  /**
   * 승인 처리. fromPhone: 폰 서명이 확인된 승인 (그 폰이 이미 보냈거나 보내는 중).
   * PC 화면의 승인으로는 보내지 않는다: 보내는 건 폰이고, 받는 사람 번호도 폰만 안다
   */
  async approve(id: string, fromPhone: boolean): Promise<{ ok: boolean; message: string }> {
    const rec = this.approvals.get(id)
    if (!rec || rec.status !== 'pending')
      return { ok: false, message: '이미 처리했거나 시간이 지난 승인 요청이에요' }
    if (!fromPhone)
      return {
        ok: false,
        message: '문자는 폰에서 승인해야 보낼 수 있어요. 폰의 승인 카드에서 받는 사람을 확인하고 승인해 주세요.',
      }
    const r =
      this.results.get(id) ??
      (await new Promise<{ ok: boolean; message: string } | undefined>((done) => {
        const timer = setTimeout(() => done(undefined), this.waitMs)
        timer.unref?.()
        this.waiters.set(id, (x) => {
          clearTimeout(timer)
          done(x)
        })
      }))
    this.waiters.delete(id)
    this.results.delete(id)
    const out = r ?? {
      ok: false,
      message: '폰에서 승인은 받았지만 보낸 결과가 오지 않았어요. 폰 앱을 새 판으로 업데이트했는지 확인해 주세요.',
    }
    this.approvals.take(id)
    this.approvals.finish(id, out.ok, out.message)
    return out
  }
}
