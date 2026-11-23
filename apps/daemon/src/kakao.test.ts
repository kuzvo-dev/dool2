import { describe, expect, it } from 'vitest'
import type { HandsCaller } from './hands.js'
import { KAKAO, KakaoChat } from './kakao.js'

type Win = { title: string; front: boolean }

/** A KakaoTalk stand-in: chat windows open when a row is opened, the front window can be forced */
function fake(o: { rows?: string[]; open?: string[]; stuckFront?: string } = {}) {
  const calls: [string, Record<string, unknown> | undefined][] = []
  let wins: Win[] = [
    { title: '카카오톡', front: true },
    ...(o.open ?? []).map((t) => ({ title: t, front: false })),
  ]
  const front = (t: string) => {
    wins = wins.map((w) => ({ ...w, front: w.title === (o.stuckFront ?? t) }))
  }
  const hands: HandsCaller = {
    available: () => true,
    call: async (cmd, args) => {
      calls.push([cmd, args])
      if (cmd === 'windows') return wins
      if (cmd === 'open_row') {
        const want = String(args?.text)
        const hit = (o.rows ?? []).filter((r) => r.includes(want))
        if (hit.length !== 1) return { opened: '', names: hit, visible: o.rows ?? [] }
        if (!wins.some((w) => w.title === hit[0])) wins.push({ title: hit[0] as string, front: false })
        front(hit[0] as string)
        return { opened: hit[0], names: hit }
      }
      if (cmd === 'raise') front(String(args?.title))
      if (cmd === 'snapshot') return { text: 'a\nb\n오후 8:13\n"다이소"' }
      return {}
    },
  }
  const asked: string[] = []
  const chat = new KakaoChat({
    hands,
    check: async () => undefined,
    requestEnter: async (_b, window, what) => {
      asked.push(`${window}|${what}`)
      return { content: [{ type: 'text', text: 'asked' }] }
    },
    selfFinal: () => false,
  })
  return { chat, calls, asked }
}
const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? '').join('\n')

describe('kakao_send / kakao_read', () => {
  it('opens the chat, types, and asks approval for Enter in that window', async () => {
    const { chat, calls, asked } = fake({ rows: ['🤍마눌들고양이❤️', '팀 단톡'] })
    await chat.send({ to: '마눌', text: '지금 출발해' })
    expect(
      calls.some(([c, a]) => c === 'input_text' && a?.text === '지금 출발해' && a?.bundleId === KAKAO),
    ).toBe(true)
    expect(asked).toEqual(['🤍마눌들고양이❤️|KakaoTalk 🤍마눌들고양이❤️: "지금 출발해"'])
  })

  it('uses a chat window that is already open', async () => {
    const { chat, calls, asked } = fake({ open: ['JOO MYEONGDON'] })
    await chat.send({ to: 'JOO MYEONGDON', text: 'hi' })
    expect(calls.some(([c]) => c === 'open_row')).toBe(false)
    expect(asked[0]).toContain('JOO MYEONGDON|')
  })

  it('does not type when several chats match, and lists them', async () => {
    const { chat, calls } = fake({ rows: ['김민수', '김민수 팀장'] })
    const r = await chat.send({ to: '김민수', text: 'hi' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('김민수 팀장')
    expect(calls.some(([c]) => c === 'input_text')).toBe(false)
  })

  it('lists the chats on screen when a nickname matches none', async () => {
    const { chat } = fake({ rows: ['🤍마눌들고양이❤️'] })
    const r = await chat.send({ to: '와이프', text: 'hi' })
    expect(text(r)).toContain('🤍마눌들고양이❤️')
    expect(text(r)).toContain('memory_save')
  })

  it('types nothing when the chat does not come to the front', async () => {
    const { chat, calls } = fake({ rows: ['엄마'], stuckFront: '카카오톡' })
    const r = await chat.send({ to: '엄마', text: 'hi' })
    expect(r.isError).toBe(true)
    expect(calls.some(([c]) => c === 'input_text')).toBe(false)
  })

  it('reads the front chat', async () => {
    const { chat } = fake({ rows: ['🤍마눌들고양이❤️'] })
    expect(text(await chat.read({ to: '마눌' }))).toContain('다이소')
  })
})
