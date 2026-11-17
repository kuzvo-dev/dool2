// 승인 게이트 회귀 테스트: 이 테스트가 깨지면 위험한 버튼이 승인 없이 눌릴 수 있다는 뜻이다
import { describe, expect, it } from 'vitest'
import { APPROVAL_KEEP_MS, APPROVAL_TTL_MS, Approvals } from './approvals.js'
import { BrowserTools } from './browser-tools.js'

const PAGE = `# 주문서
사과 1kg 9,900원 [e1 버튼 "장바구니 담기"] [e2 버튼 "결제하기"] [e3 버튼 "리뷰 보내기"]`

function shop(url = 'https://shop.example/item/1', text = PAGE) {
  const calls: string[] = []
  const state = { url, text }
  return {
    calls,
    state,
    call: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push(`${cmd}${args?.ref ? `:${args.ref}` : ''}`)
      if (cmd === 'snapshot')
        return { tabId: 1, url: state.url, title: '가게', text: state.text, truncated: false, captcha: false }
      if (cmd === 'screenshot') return { data: 'SHOT', mime: 'image/jpeg', url: state.url, title: '가게' }
      return { tabId: 1, url: state.url, title: '가게' }
    },
  }
}

const ask = {
  tabId: 1,
  ref: 'e2',
  what: '사과 1kg 결제',
  where: '시험 가게',
  amount: '9,900원',
  cancel: '안내 없음',
}

describe('승인 게이트', () => {
  it('위험한 버튼은 AI가 누를 수 없고, 승인을 요청하라고 한다', async () => {
    const b = shop()
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 1 })
    const r = await tools.run('click', { tabId: 1, ref: 'e2' })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r)).toContain('browser_request_approval')
    expect(b.calls).not.toContain('click:e2')
  })

  it('승인하면 본체가 그 버튼 하나만 누르고, 같은 승인은 다시 쓸 수 없다', async () => {
    const b = shop()
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 1 })
    await tools.run('request_approval', ask)
    const [pending] = tools.approvals.list()
    expect(pending).toMatchObject({ status: 'pending', label: '결제하기', role: '버튼', amount: '9,900원' })
    // 화면 캡처는 목록에는 없고 하나만 볼 때 있다
    expect(JSON.stringify(pending)).not.toContain('SHOT')
    expect(tools.approvals.get(pending?.id ?? '')?.shot).toBe('SHOT')

    // 승인했어도 AI가 직접 누를 수는 없다
    expect((await tools.run('click', { tabId: 1, ref: 'e2' })).isError).toBe(true)

    const done = await tools.approve(pending?.id ?? '')
    expect(done.ok).toBe(true)
    expect(b.calls.filter((c) => c === 'click:e2')).toHaveLength(1)
    expect((await tools.approve(pending?.id ?? '')).ok).toBe(false)
    expect(b.calls.filter((c) => c === 'click:e2')).toHaveLength(1)
  })

  it('승인한 뒤 화면이 바뀌었으면(버튼 글자·주소) 누르지 않는다', async () => {
    const b = shop()
    const tools = new BrowserTools(b)
    await tools.run('read', { tabId: 1 })
    await tools.run('request_approval', ask)
    const id = tools.approvals.list()[0]?.id ?? ''
    b.state.text = PAGE.replace('"결제하기"', '"정기결제 신청"')
    const r = await tools.approve(id)
    expect(r.ok).toBe(false)
    expect(b.calls).not.toContain('click:e2')

    await tools.run('read', { tabId: 1 })
    await tools.run('request_approval', { ...ask })
    const id2 = tools.approvals.list().find((x) => x.status === 'pending')?.id ?? ''
    b.state.url = 'https://shop.example.phish.io/item/1'
    expect((await tools.approve(id2)).ok).toBe(false)
    expect(b.calls).not.toContain('click:e2')
  })

  it('거절하거나 10분이 지나면 누르지 않는다', async () => {
    let now = 0
    const approvals = new Approvals(() => now)
    const b = shop()
    const tools = new BrowserTools(b, undefined, () => 'approve', approvals)
    await tools.run('read', { tabId: 1 })
    await tools.run('request_approval', ask)
    const id = approvals.list()[0]?.id ?? ''
    expect(approvals.reject(id)).toBe(true)
    expect((await tools.approve(id)).ok).toBe(false)

    await tools.run('request_approval', ask)
    const id2 = approvals.list().find((x) => x.status === 'pending')?.id ?? ''
    now += APPROVAL_TTL_MS + 1
    expect(approvals.get(id2)?.status).toBe('expired')
    expect((await tools.approve(id2)).ok).toBe(false)
    expect(b.calls).not.toContain('click:e2')
  })

  it('끝난 요청은 화면 캡처를 버리고, 오래되면 지운다 (하루 내내 쌓이지 않게)', async () => {
    let now = 0
    const approvals = new Approvals(() => now)
    const tools = new BrowserTools(shop(), undefined, () => 'approve', approvals)
    await tools.run('read', { tabId: 1 })
    await tools.run('request_approval', ask)
    const id = approvals.list()[0]?.id ?? ''
    expect(approvals.get(id)?.shot).toBe('SHOT')
    approvals.reject(id)
    expect(approvals.get(id)?.shot).toBeUndefined()
    now += APPROVAL_KEEP_MS + 1
    await tools.run('request_approval', ask)
    expect(approvals.get(id)).toBeUndefined()
    expect(approvals.list()).toHaveLength(1)
  })

  it('탭이 닫히면 그 탭의 기다리던 승인은 만료되고 탭 기록도 지운다', async () => {
    const approvals = new Approvals()
    const tools = new BrowserTools(shop(), undefined, () => 'approve', approvals)
    await tools.run('read', { tabId: 1 })
    await tools.run('request_approval', ask)
    const id = approvals.list()[0]?.id ?? ''
    tools.forgetTab(1)
    expect(approvals.get(id)?.status).toBe('expired')
    expect(approvals.get(id)?.shot).toBeUndefined()
    expect((await tools.approve(id)).ok).toBe(false)
    const r = await tools.run('click', { tabId: 1, ref: 'e1' })
    expect(r.isError).toBe(true) // 기록이 지워져서 다시 읽어야 한다
  })

  it('위험하지 않은 버튼은 승인 요청을 받지 않는다', async () => {
    const tools = new BrowserTools(shop())
    await tools.run('read', { tabId: 1 })
    const r = await tools.run('request_approval', { ...ask, ref: 'e1' })
    expect(r.isError).toBe(true)
    expect(tools.approvals.list()).toHaveLength(0)
  })

  it('"항상 직접 누르기"면 승인 요청 대신 사람에게 넘기라고 한다', async () => {
    const tools = new BrowserTools(shop(), undefined, () => 'self')
    await tools.run('read', { tabId: 1 })
    const click = await tools.run('click', { tabId: 1, ref: 'e2' })
    expect(JSON.stringify(click)).toContain('browser_handoff')
    const r = await tools.run('request_approval', ask)
    expect(r.isError).toBe(true)
    expect(tools.approvals.list()).toHaveLength(0)
  })
})
