import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { createServer, statusText } from './index.js'

const fixed = () => new Date('2026-11-14T03:00:00Z')

describe('두리 MCP 도구', () => {
  it('상태 글에 한국 시각을 넣는다', () => {
    expect(statusText({ now: fixed })).toContain('2026년 11월 14일 토 12:00')
  })

  it('MCP로 status 도구를 부를 수 있다', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await createServer({ now: fixed }).connect(serverT)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientT)

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual([
      'status',
      'browser_open',
      'browser_navigate',
      'browser_read',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_scroll',
      'browser_screenshot',
      'browser_back',
      'browser_close',
    ])

    const res = await client.callTool({ name: 'status', arguments: {} })
    const content = res.content as { type: string; text: string }[]
    expect(content[0]?.text).toContain('두리 연결됨')
    await client.close()
  })
})

describe('브라우저 도구', () => {
  it('본체에 그대로 넘기고 결과(오류 포함)를 돌려준다', async () => {
    const calls: [string, unknown][] = []
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await createServer({
      browser: async (tool, args) => {
        calls.push([tool, args])
        return tool === 'click'
          ? { isError: true, content: [{ type: 'text', text: '멈췄어요: "결제"' }] }
          : { content: [{ type: 'text', text: '[탭 3] 두리 시험 가게' }] }
      },
    }).connect(serverT)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientT)

    const ok = await client.callTool({ name: 'browser_open', arguments: { url: 'https://example.com' } })
    expect((ok.content as { text: string }[])[0]?.text).toContain('[탭 3]')
    const no = await client.callTool({ name: 'browser_click', arguments: { tabId: 3, ref: 'e5' } })
    expect(no.isError).toBe(true)
    expect(calls).toEqual([
      ['open', { url: 'https://example.com' }],
      ['click', { tabId: 3, ref: 'e5' }],
    ])
    // ref 형식이 틀리면 본체까지 가지 않는다
    const bad = await client.callTool({ name: 'browser_click', arguments: { tabId: 3, ref: '#buy' } })
    expect(bad.isError).toBe(true)
    expect(calls).toHaveLength(2)
    await client.close()
  })

  it('본체 주소가 없으면 알려 준다', async () => {
    const { daemonClient } = await import('./browser.js')
    const r = await daemonClient({})('open', {})
    expect(r).toEqual({ isError: true, content: [{ type: 'text', text: '두리 본체와 연결돼 있지 않아요' }] })
  })
})
