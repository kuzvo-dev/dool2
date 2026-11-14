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
    expect(tools.map((t) => t.name)).toEqual(['status'])

    const res = await client.callTool({ name: 'status', arguments: {} })
    const content = res.content as { type: string; text: string }[]
    expect(content[0]?.text).toContain('두리 연결됨')
    await client.close()
  })
})
