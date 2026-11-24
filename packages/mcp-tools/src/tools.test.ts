import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { createServer, servicesOf, statusText } from './index.js'
import { ON_DEMAND_TOOLS } from './on-demand.js'

const fixed = () => new Date('2026-11-14T03:00:00Z')

describe('두리 MCP 도구', () => {
  it('상태 글에 한국 시각을 넣는다', () => {
    expect(statusText({ now: fixed })).toContain('Sat, November 14, 2026 at 12:00')
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
      'browser_steps',
      'browser_route',
      'browser_select',
      'browser_scroll',
      'browser_screenshot',
      'browser_back',
      'browser_wait',
      'browser_tabs',
      'browser_login',
      'browser_request_login',
      'browser_fill_profile',
      'browser_wait_auth',
      'browser_request_code',
      'browser_request_tap',
      'browser_request_profile',
      'browser_request_approval',
      'browser_checkout',
      'browser_order_done',
      'browser_dialog',
      'browser_handoff',
      'browser_close',
      'kakao_send',
      'goal_create',
      'goal_list',
      'goal_update',
      'library_save',
      'library_find',
      'memory_save',
      'know_save',
      'know_find',
      'know_update',
      'memory_forget',
      'photo_view',
      'connect_ask',
      'profile_view',
      'pay_method_list',
      'vault_find',
      'show_cards',
      'show_list',
      'show_result',
      'show_draft',
      'phone_sms',
      'feed_tell',
      'feed_find',
      'conversation_search',
      'file_find',
      'service_find',
      'orders_all',
      'service_call',
      'tool_find',
      'tool_call',
    ])

    const res = await client.callTool({ name: 'status', arguments: {} })
    const content = res.content as { type: string; text: string }[]
    expect(content[0]?.text).toContain('Dool2 connected')
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
    expect(r).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Not connected to the Dool2 daemon' }],
    })
  })
})

describe('서비스 도구 (ADR 0018)', () => {
  const spec = {
    name: 'demo_eats_search',
    title: '데모맛집: 식당 찾기',
    description: '[데모맛집 · 찾아보기] 식당을 찾는다.',
    input: {
      properties: {
        keyword: { type: 'string', description: '지역' },
        date: { type: 'string', format: 'date', description: '날짜' },
        people: { type: 'integer', minimum: 1, maximum: 20, description: '인원' },
      },
      required: ['keyword'],
    },
    output: {
      shops: {
        type: 'list',
        description: '가게',
        fields: { name: { type: 'string' }, rating: { type: 'number' } },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }

  it('연결한 서비스의 도구를 입력·출력 모양과 힌트를 달아 내보이고, 목록이 바뀌면 따라간다', async () => {
    let catalog: unknown[] = [spec]
    const calls: unknown[] = []
    const services = async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'catalog') return { tools: catalog } as never
      calls.push([tool, args])
      return {
        content: [{ type: 'text' as const, text: '1. 가게 가' }],
        structuredContent: { shops: [{ name: '가게 가', rating: 4.5 }] },
      } as never
    }
    const server = createServer({ services })
    await servicesOf(server)?.sync()
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientT)
    const tool = (await client.listTools()).tools.find((t) => t.name === 'demo_eats_search')
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true })
    expect(tool?.inputSchema.required).toEqual(['keyword'])
    expect(tool?.inputSchema.properties).toHaveProperty('date.pattern')
    expect(tool?.outputSchema?.properties).toHaveProperty('shops')

    const r = await client.callTool({ name: 'demo_eats_search', arguments: { keyword: '성수', people: 4 } })
    expect(r.structuredContent).toEqual({ shops: [{ name: '가게 가', rating: 4.5 }] })
    expect(calls[0]).toEqual(['call', { tool: 'demo_eats_search', input: { keyword: '성수', people: 4 } }])
    // 입력 모양이 틀리면 본체까지 가지 않는다
    const bad = await client.callTool({ name: 'demo_eats_search', arguments: { keyword: '성수', people: 0 } })
    expect(bad.isError).toBe(true)
    expect(calls).toHaveLength(1)

    catalog = []
    await servicesOf(server)?.sync()
    expect((await client.listTools()).tools.some((t) => t.name === 'demo_eats_search')).toBe(false)
    servicesOf(server)?.stop()
  })
})

describe('tools on demand (ADR 0033)', () => {
  async function connect() {
    const calls: [string, unknown][] = []
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await createServer({
      files: async (tool, args) => {
        calls.push([tool, args])
        return { content: [{ type: 'text', text: `ran ${tool}` }] }
      },
    }).connect(serverT)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientT)
    const text = (r: { content: unknown }) => (r.content as { text: string }[])[0]?.text ?? ''
    return { client, calls, text }
  }

  it('keeps these tools aside (the eval bank reads tool names from this file)', () => {
    expect([...ON_DEMAND_TOOLS]).toEqual([
      'video_style',
      'video_clip',
      'video_motion',
      'video_make',
      'image_make',
      'file_move',
      'file_convert',
      'file_print',
      'file_pdf',
      'file_trash',
      'file_download',
      'pc_screen',
      'browser_hover',
      'browser_upload',
      'show_route',
      'goal_delete',
      'screen_status',
      'screen_apps',
      'screen_open',
      'screen_read',
      'screen_click',
      'screen_type',
      'screen_login',
      'screen_key',
      'screen_screenshot',
      'screen_request_app',
      'screen_request_approval',
      'kakao_read',
      'file_read',
      'file_write',
      'file_render',
      'browser_new_password',
      'feed_post',
      'idea_suggest',
    ])
  })

  it('brings a whole group in full when asked by the start of the names', async () => {
    const { client, text } = await connect()
    const screen = text(await client.callTool({ name: 'tool_find', arguments: { query: 'screen' } }))
    for (const n of ['screen_apps', 'screen_click', 'screen_request_approval'])
      expect(screen).toContain(`## ${n}`)
    expect(screen).not.toContain('## kakao_read')
    expect(screen).toContain('"bundleId"')
    await client.close()
  })

  it('lists the tools kept aside in tool_find, and shows one in full with its input', async () => {
    const { client, text } = await connect()
    const { tools } = await client.listTools()
    expect(tools.find((t) => t.name === 'tool_find')?.description).toContain('file_pdf (Merge or split PDFs)')
    const one = text(await client.callTool({ name: 'tool_find', arguments: { query: 'file_pdf' } }))
    expect(one).toContain('## file_pdf')
    expect(one).toContain('"paths"')
    await client.close()
  })

  it('tool_call runs the same handler with checked input, and refuses bad input or names', async () => {
    const { client, calls, text } = await connect()
    const ok = await client.callTool({
      name: 'tool_call',
      arguments: { tool: 'file_pdf', input: { paths: ['~/Downloads/a.pdf'], split: true } },
    })
    expect(text(ok)).toBe('ran file_pdf')
    expect(calls).toEqual([['file_pdf', { paths: ['~/Downloads/a.pdf'], split: true }]])
    const bad = await client.callTool({ name: 'tool_call', arguments: { tool: 'file_pdf', input: {} } })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toContain('Fix the input for file_pdf')
    const none = await client.callTool({ name: 'tool_call', arguments: { tool: 'rm_rf', input: {} } })
    expect(none.isError).toBe(true)
    await client.close()
  })
})
