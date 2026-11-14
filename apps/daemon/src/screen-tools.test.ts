import { describe, expect, it } from 'vitest'
import { Approvals } from './approvals.js'
import type { HandsCaller } from './hands.js'
import { ScreenTools } from './screen-tools.js'

const KAKAO = 'com.kakao.KakaoTalkMac'

/** 도우미 흉내: 카카오톡 채팅방 하나 */
function fakeHands(opts: { accessibility?: boolean; locked?: boolean } = {}) {
  const calls: [string, Record<string, unknown> | undefined][] = []
  let sendLabel = '전송'
  const hands: HandsCaller & { calls: typeof calls; setSend(l: string): void } = {
    calls,
    setSend: (l) => {
      sendLabel = l
    },
    available: () => true,
    call: async (cmd, args) => {
      calls.push([cmd, args])
      if (cmd === 'status')
        return {
          accessibility: opts.accessibility ?? true,
          screenRecording: true,
          locked: opts.locked ?? false,
        }
      if (cmd === 'apps') return [{ bundleId: KAKAO, name: '카카오톡', active: true }]
      if (cmd === 'installed') return [{ bundleId: 'com.apple.Notes', name: '메모' }]
      if (cmd === 'snapshot')
        return {
          app: '카카오톡',
          window: '엄마',
          text: `## 엄마\n오늘 몇 시에 와?\n[e1 입력칸 "메시지 입력"]\n[e2 버튼 "${sendLabel}"]\n[e3 버튼 "이모티콘"]`,
          truncated: false,
        }
      if (cmd === 'screenshot') return { data: 'SHOT', window: '엄마' }
      if (cmd === 'click') return { via: 'press' }
      return {}
    },
  }
  return hands
}

function setup(hands = fakeHands(), allowed: string[] = [KAKAO]) {
  let list = [...allowed]
  const tools = new ScreenTools(hands, new Approvals(), {
    allowed: () => list,
    setAllowed: (l) => {
      list = l
    },
    finalStep: () => 'approve',
  })
  return { tools, hands, allowed: () => list }
}

const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? '').join('\n')

describe('PC 화면 제어', () => {
  it('허용 안 한 앱은 다루지 않고, 허용 요청을 승인하면 허용 목록에 넣는다', async () => {
    const { tools, hands, allowed } = setup(fakeHands(), [])
    const r = await tools.run('read', { bundleId: KAKAO })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('screen_request_app')
    expect(hands.calls.some(([c]) => c === 'snapshot')).toBe(false)

    await tools.run('apps', {})
    await tools.run('request_app', { bundleId: KAKAO, why: '엄마에게 답장' })
    const rec = tools.approvals.list().find((a) => a.kind === 'app')
    expect(rec).toMatchObject({ label: '카카오톡', url: `app:${KAKAO}`, status: 'pending' })
    const done = await tools.approve(rec?.id ?? '')
    expect(done.ok).toBe(true)
    expect(allowed()).toEqual([KAKAO])
  })

  it('터미널·설정·Finder는 기본으로 막고, 허용 요청도 받지 않는다', async () => {
    const { tools } = setup()
    expect(text(await tools.run('read', { bundleId: 'com.apple.Terminal' }))).toContain('기본으로 막아 둔')
    expect((await tools.run('request_app', { bundleId: 'com.apple.finder' })).isError).toBe(true)
  })

  it('권한이 꺼져 있거나 화면이 잠겨 있으면 사용자에게 말하게 한다', async () => {
    expect(
      text(await setup(fakeHands({ accessibility: false })).tools.run('read', { bundleId: KAKAO })),
    ).toContain('손쉬운 사용')
    expect(text(await setup(fakeHands({ locked: true })).tools.run('read', { bundleId: KAKAO }))).toContain(
      '잠금을 풀어',
    )
  })

  it('읽고 입력·안전한 버튼은 바로 하고, 전송 버튼과 메신저 Enter는 승인을 받게 한다', async () => {
    const { tools, hands } = setup()
    expect(text(await tools.run('read', { bundleId: KAKAO }))).toContain('[e2 버튼 "전송"]')
    await tools.run('type', { bundleId: KAKAO, ref: 'e1', text: '7시에 도착해' })
    expect(hands.calls.at(-1)).toEqual(['type', { bundleId: KAKAO, text: '7시에 도착해', ref: 'e1' }])

    await tools.run('click', { bundleId: KAKAO, ref: 'e3' })
    expect(hands.calls.some(([c, a]) => c === 'click' && a?.ref === 'e3')).toBe(true)

    const send = await tools.run('click', { bundleId: KAKAO, ref: 'e2' })
    expect(send.isError).toBe(true)
    expect(text(send)).toContain('screen_request_approval')
    expect(hands.calls.some(([c, a]) => c === 'click' && a?.ref === 'e2')).toBe(false)

    const enter = await tools.run('key', { bundleId: KAKAO, key: 'Enter' })
    expect(text(enter)).toContain('key:Enter')
    expect(hands.calls.some(([c]) => c === 'key')).toBe(false)
    // Shift+Enter(줄 바꿈)는 괜찮다
    await tools.run('key', { bundleId: KAKAO, key: 'Enter', modifiers: ['shift'] })
    expect(hands.calls.some(([c]) => c === 'key')).toBe(true)
  })

  it('승인하면 다시 읽어 같은 버튼일 때만 누르고, 화면이 바뀌었으면 누르지 않는다', async () => {
    const { tools, hands } = setup()
    await tools.run('read', { bundleId: KAKAO })
    await tools.run('request_approval', {
      bundleId: KAKAO,
      ref: 'e2',
      what: "엄마에게 '7시에 도착해' 보내기",
    })
    const rec = tools.approvals.list().at(-1)
    expect(rec).toMatchObject({ kind: 'contact', label: '전송', where: '카카오톡', tabId: -1 })
    expect(tools.approvals.get(rec?.id ?? '')?.shot).toBe('SHOT')
    const ok = await tools.approve(rec?.id ?? '')
    expect(ok.ok).toBe(true)
    expect(hands.calls.at(-1)).toEqual(['click', { bundleId: KAKAO, ref: 'e2' }])
    // 한 번만 쓸 수 있다
    expect((await tools.approve(rec?.id ?? '')).ok).toBe(false)

    await tools.run('request_approval', { bundleId: KAKAO, ref: 'e2', what: '다시 보내기' })
    const again = tools.approvals.list().at(-1)
    hands.setSend('삭제')
    const changed = await tools.approve(again?.id ?? '')
    expect(changed.ok).toBe(false)
    expect(changed.message).toContain('화면이 바뀌어서')
  })

  it('메신저 Enter 승인은 Enter 하나만 누른다', async () => {
    const { tools, hands } = setup()
    await tools.run('request_approval', { bundleId: KAKAO, ref: 'key:Enter', what: '보내기' })
    const rec = tools.approvals.list().at(-1)
    expect((await tools.approve(rec?.id ?? '')).ok).toBe(true)
    expect(hands.calls.at(-1)).toEqual(['key', { bundleId: KAKAO, key: 'Enter', modifiers: [] }])
  })
})
