import { describe, expect, it } from 'vitest'
import { checkPaygKey } from './payg-check.js'

const answer = (status: number) => async () => ({ status })

describe('API key check before saving', () => {
  it('stops only a key the company rejects', async () => {
    expect(await checkPaygKey('openrouter', 'undefined', { fetch: answer(401) })).toBe('rejected')
    expect(await checkPaygKey('openrouter', 'sk-or-good', { fetch: answer(200) })).toBe('ok')
    expect(await checkPaygKey('google', 'bad', { fetch: answer(400) })).toBe('rejected')
    // A server error or no network does not block setup
    expect(await checkPaygKey('openai', 'sk-x', { fetch: answer(500) })).toBe('unknown')
    expect(
      await checkPaygKey('anthropic', 'sk-ant', {
        fetch: async () => {
          throw new Error('offline')
        },
      }),
    ).toBe('unknown')
  })

  it('sends the key only to that company', async () => {
    const seen: string[] = []
    await checkPaygKey('openrouter', 'k', {
      fetch: async (url) => {
        seen.push(url)
        return { status: 200 }
      },
    })
    expect(seen).toEqual(['https://openrouter.ai/api/v1/key'])
  })
})
