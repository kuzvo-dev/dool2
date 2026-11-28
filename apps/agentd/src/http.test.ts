import { scriptedBrain } from '@dool2/engine'
import { makeFakeBridges } from '@dool2/sandbox'
import { afterEach, describe, expect, it } from 'vitest'
import { Agentd } from './agentd.js'
import { type RunningHttpServer, startHttpServer } from './http.js'

const TOKEN = 'test-token-123'

function makeAgentd(): Agentd {
  const rounds = [
    [
      { kind: 'text' as const, text: 'Looking.' },
      {
        kind: 'tool_call' as const,
        call: { id: 'c1', name: 'code' as const, args: { code: 'JSON.stringify(await page.snapshot())' } },
      },
      { kind: 'turn_end' as const, stop: 'tool' as const },
    ],
    [{ kind: 'turn_end' as const, stop: 'done' as const }],
  ]
  return new Agentd({ brain: scriptedBrain(rounds), bridges: makeFakeBridges() })
}

let running: RunningHttpServer | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

describe('agentd HTTP API', () => {
  it('GET /health returns ok without a token', async () => {
    running = await startHttpServer({ agentd: makeAgentd(), token: TOKEN })
    const res = await fetch(`${running.url}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; level: string }
    expect(body.ok).toBe(true)
    expect(body.level).toBe('ask')
  })

  it('POST /message requires the token (401 without)', async () => {
    running = await startHttpServer({ agentd: makeAgentd(), token: TOKEN })
    const res = await fetch(`${running.url}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    })
    expect(res.status).toBe(401)
  })

  it('POST /message with the token streams turn events and a final result', async () => {
    running = await startHttpServer({ agentd: makeAgentd(), token: TOKEN })
    const res = await fetch(`${running.url}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ message: 'what is here?' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    // the page snapshot flowed back as a tool result inside the stream
    expect(text).toContain('tool_result')
    expect(text).toContain('example.com/login')
    // and the stream ends with the result event
    expect(text).toContain('event: result')
  })
})
