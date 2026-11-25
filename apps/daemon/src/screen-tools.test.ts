import { describe, expect, it } from 'vitest'
import { Approvals } from './approvals.js'
import type { HandsCaller } from './hands.js'
import { ScreenTools } from './screen-tools.js'

const KAKAO = 'com.kakao.KakaoTalkMac'

/** 도우미 흉내: 카카오톡 채팅방 하나 */
function fakeHands(opts: { accessibility?: boolean; locked?: boolean } = {}) {
  const calls: [string, Record<string, unknown> | undefined][] = []
  let sendLabel = '전송'
  let focusedRole: { role: string; subrole?: string } = { role: 'AXTextArea' }
  const hands: HandsCaller & {
    calls: typeof calls
    setSend(l: string): void
    setFocused(f: { role: string; subrole?: string }): void
  } = {
    calls,
    setFocused: (f) => {
      focusedRole = f
    },
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
      if (cmd === 'installed')
        return [
          { bundleId: 'com.apple.Notes', name: '메모' },
          { bundleId: 'com.example.Downloading', name: '받는중', installing: true },
        ]
      if (cmd === 'snapshot')
        return {
          app: '카카오톡',
          window: '엄마',
          text: `## 엄마\n오늘 몇 시에 와?\n[e1 입력칸 "메시지 입력"]\n[e2 버튼 "${sendLabel}"]\n[e3 버튼 "이모티콘"]`,
          truncated: false,
        }
      if (cmd === 'screenshot') return { data: 'SHOT', window: '엄마' }
      if (cmd === 'click') return { via: 'press' }
      if (cmd === 'focused') return focusedRole
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

  it('앱스토어에서 받는 중인 앱은 설치 중이라고 알린다 (빈 앱을 보고 설치됐다고 하지 않게)', async () => {
    const { tools } = setup()
    const r = text(await tools.run('apps', { query: '받는중' }))
    expect(r).toContain('받는중 (com.example.Downloading) · still installing')
    expect(text(await tools.run('apps', { query: '메모' }))).not.toContain('installing')
  })

  it('승인 카드 글은 사용자 언어로 (기본 한국어)', async () => {
    const ko = setup(fakeHands(), [])
    await ko.tools.run('apps', {})
    await ko.tools.run('request_app', { bundleId: KAKAO })
    expect(ko.tools.approvals.list()[0]).toMatchObject({ what: '두리가 카카오톡을 조작해도 될까요?' })
    const en = new ScreenTools(fakeHands(), new Approvals(), {
      allowed: () => [],
      setAllowed: () => {},
      finalStep: () => 'approve',
      lang: () => 'en',
    })
    await en.run('apps', {})
    await en.run('request_app', { bundleId: KAKAO })
    expect(en.approvals.list()[0]).toMatchObject({ what: 'Can Dool2 control 카카오톡?' })
  })

  it('터미널·설정·Finder는 기본으로 막고, 허용 요청도 받지 않는다', async () => {
    const { tools } = setup()
    expect(text(await tools.run('read', { bundleId: 'com.apple.Terminal' }))).toContain('blocked by default')
    expect((await tools.run('request_app', { bundleId: 'com.apple.finder' })).isError).toBe(true)
  })

  it('권한이 꺼져 있거나 화면이 잠겨 있으면 사용자에게 말하게 한다', async () => {
    expect(
      text(await setup(fakeHands({ accessibility: false })).tools.run('read', { bundleId: KAKAO })),
    ).toContain('Accessibility')
    expect(text(await setup(fakeHands({ locked: true })).tools.run('read', { bundleId: KAKAO }))).toContain(
      'unlock the PC',
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

describe('앱 로그인 (금고 계정)', () => {
  it('앱 이름과 맞는 사이트 계정만 고른다', async () => {
    const { vaultForApp } = await import('./screen-tools.js')
    const entries = [
      { origin: 'https://accounts.kakao.com', username: 'a' },
      { origin: 'https://nid.naver.com', username: 'b' },
      { origin: 'https://www.coupang.com', username: 'c' },
    ]
    expect(vaultForApp('com.kakao.KakaoTalkMac', entries).map((e) => e.username)).toEqual(['a'])
    expect(vaultForApp('com.apple.Notes', entries)).toEqual([])
  })

  it('금고 값은 도우미에게만 넘기고 AI에게 돌려주지 않는다', async () => {
    const hands = fakeHands()
    const tools = new ScreenTools(hands, new Approvals(), {
      allowed: () => [KAKAO],
      setAllowed: () => {},
      finalStep: () => 'approve',
      vaultList: async () => [
        { id: 'v1', origin: 'https://accounts.kakao.com', username: 'me@example.com' },
        { id: 'v2', origin: 'https://nid.naver.com', username: 'naver' },
      ],
      vaultReveal: async (id) =>
        id === 'v1' ? { username: 'me@example.com', password: 'S3cret!' } : undefined,
    })
    const r = await tools.run('login', { bundleId: KAKAO })
    expect(r.isError).toBeFalsy()
    expect(text(r)).not.toContain('S3cret!')
    const fill = hands.calls.find(([c]) => c === 'fill_login')
    expect(fill?.[1]).toMatchObject({ bundleId: KAKAO, username: 'me@example.com', password: 'S3cret!' })
  })

  it('맞는 계정이 없으면 로그인 카드로 받게 한다', async () => {
    const tools = new ScreenTools(fakeHands(), new Approvals(), {
      allowed: () => [KAKAO],
      setAllowed: () => {},
      finalStep: () => 'approve',
      vaultList: async () => [{ id: 'v2', origin: 'https://nid.naver.com', username: 'naver' }],
      vaultReveal: async () => undefined,
    })
    expect(text(await tools.run('login', { bundleId: KAKAO }))).toContain('browser_request_login')
  })
})

describe('메신저 Enter', () => {
  it('검색칸·목록에서 Enter(방 열기)는 승인 없이, 입력칸에서 Enter(보내기)는 승인을 받는다', async () => {
    const { tools, hands } = setup()
    const keys = () => hands.calls.filter(([c]) => c === 'key').length
    hands.setFocused({ role: 'AXTextField', subrole: 'AXSearchField' })
    expect((await tools.run('key', { bundleId: KAKAO, key: 'Enter' })).isError).toBeFalsy()
    hands.setFocused({ role: 'AXTable' })
    expect((await tools.run('key', { bundleId: KAKAO, key: 'Enter' })).isError).toBeFalsy()
    expect(keys()).toBe(2)
    hands.setFocused({ role: 'AXTextArea' })
    const r = await tools.run('key', { bundleId: KAKAO, key: 'Enter' })
    expect(text(r)).toContain('screen_request_approval')
    expect(keys()).toBe(2)
  })
})

describe('PC app actions give only what changed (as the browser does)', () => {
  /** An app whose window and lines the test changes */
  function app() {
    const lines = [
      '## Notes',
      'Shopping list',
      ...Array.from({ length: 12 }, (_, i) => `item ${i + 1}`),
      '[e1 버튼 "새 메모"]',
      '[e2 입력칸 "검색"]',
      '[e3 버튼 "공유"]',
    ]
    const state = { window: 'Shopping', lines }
    const hands: HandsCaller = {
      available: () => true,
      call: async (cmd) => {
        if (cmd === 'status') return { accessibility: true, screenRecording: true, locked: false }
        if (cmd === 'snapshot')
          return { app: 'Notes', window: state.window, text: state.lines.join('\n'), truncated: false }
        if (cmd === 'click') return { via: 'press' }
        return {}
      },
    }
    const { tools } = setup(hands as ReturnType<typeof fakeHands>, ['com.apple.Notes'])
    return { tools, state }
  }
  const N = 'com.apple.Notes'
  const ai = (viewer = 'chat-1') => ({ ai: true, viewer })

  it('after an action in a window the AI saw, only the changed lines; unchanged refs still work', async () => {
    const { tools, state } = app()
    expect(text(await tools.run('read', { bundleId: N }, ai()))).toContain('item 7')
    state.lines = [...state.lines.slice(0, 14), 'item 13', ...state.lines.slice(14)]
    const r = text(await tools.run('click', { bundleId: N, ref: 'e1' }, ai()))
    expect(r).toContain('Pressed "새 메모"')
    expect(r).toContain('[app Notes] window: Shopping')
    expect(r).toContain('Only what changed since you last saw this window: 1 new or changed lines of 18')
    expect(r).toContain('item 13')
    expect(r).not.toContain('item 7')
    // e3 was not shown again, but is still the same button
    expect(text(await tools.run('click', { bundleId: N, ref: 'e3' }, ai()))).toContain('Pressed "공유"')
  })

  it('nothing changed says so; screen_read always gives the whole screen', async () => {
    const { tools } = app()
    await tools.run('read', { bundleId: N }, ai())
    expect(text(await tools.run('key', { bundleId: N, key: 'Escape' }, ai()))).toContain(
      'The screen text did not change since you last saw this window',
    )
    expect(text(await tools.run('read', { bundleId: N }, ai()))).toContain('item 7')
  })

  it('another window, a mostly new screen, another chat or a new program get the whole screen', async () => {
    const { tools, state } = app()
    await tools.run('read', { bundleId: N }, ai())
    state.window = 'Recipes'
    expect(text(await tools.run('key', { bundleId: N, key: 'Escape' }, ai()))).toContain('item 7')
    state.lines = [
      '## Notes',
      ...Array.from({ length: 14 }, (_, i) => `step ${i + 1}`),
      '[e1 버튼 "새 메모"]',
    ]
    expect(text(await tools.run('key', { bundleId: N, key: 'Escape' }, ai()))).toContain('step 9')
    // Each chat keeps its own: chat-2 never saw this app
    expect(text(await tools.run('key', { bundleId: N, key: 'Escape' }, ai('chat-2')))).toContain('step 9')
    // A new agent program for chat-1 has not seen it in its context
    tools.forgetSeen('chat-1')
    expect(text(await tools.run('key', { bundleId: N, key: 'Escape' }, ai()))).toContain('step 9')
  })

  it("Dool2's own reads neither give only changes nor count as seen; the switch turns it off", async () => {
    const { tools } = app()
    await tools.run('read', { bundleId: N })
    expect(text(await tools.run('key', { bundleId: N, key: 'Escape' }))).toContain('item 7')
    // The AI never saw it: its first action gives the whole screen
    expect(text(await tools.run('key', { bundleId: N, key: 'Escape' }, ai()))).toContain('item 7')
    tools.changesOnly = false
    expect(text(await tools.run('key', { bundleId: N, key: 'Escape' }, ai()))).toContain('item 7')
  })
})
