import { describe, expect, it } from 'vitest'
import { Hands } from './hands.js'
import { makeFakeUiaBackend } from './in-memory-backend.js'
import { dispatch, runLoop } from './protocol.js'

function newHands(): Hands {
  return new Hands(makeFakeUiaBackend())
}

describe('dispatch', () => {
  it('turns a request line into one JSON result line', async () => {
    const out = await dispatch(newHands(), '{"id":1,"cmd":"apps"}')
    expect(out).not.toBeNull()
    const res = JSON.parse(out as string)
    expect(res.id).toBe(1)
    expect(res.ok).toBe(true)
    expect(res.result[0].bundleId).toBe('demo.exe')
  })

  it('carries the request id back on an error', async () => {
    const out = await dispatch(newHands(), '{"id":"x","cmd":"snapshot","args":{"bundleId":"chrome.exe"}}')
    const res = JSON.parse(out as string)
    expect(res).toMatchObject({ id: 'x', ok: false })
    expect(typeof res.error).toBe('string')
  })

  it('returns a clean error for malformed JSON', async () => {
    const res = JSON.parse((await dispatch(newHands(), '{not json')) as string)
    expect(res).toMatchObject({ id: null, ok: false })
    expect(typeof res.error).toBe('string')
  })

  it('returns a clean error when cmd is missing', async () => {
    const res = JSON.parse((await dispatch(newHands(), '{"id":3}')) as string)
    expect(res).toMatchObject({ id: 3, ok: false })
  })

  it('ignores a blank line', async () => {
    expect(await dispatch(newHands(), '   ')).toBeNull()
    expect(await dispatch(newHands(), '')).toBeNull()
  })

  it('reports an unknown command as an error, not a crash', async () => {
    const res = JSON.parse((await dispatch(newHands(), '{"id":9,"cmd":"nope"}')) as string)
    expect(res).toMatchObject({ id: 9, ok: false })
  })
})

describe('runLoop', () => {
  it('writes one response per non-blank line, in order', async () => {
    async function* lines(): AsyncIterable<string> {
      yield '{"id":1,"cmd":"status"}'
      yield ''
      yield '{"id":2,"cmd":"apps"}'
    }
    const out: string[] = []
    await runLoop(newHands(), lines(), (l) => out.push(l))
    expect(out).toHaveLength(2)
    expect(JSON.parse(out[0] as string).id).toBe(1)
    expect(JSON.parse(out[1] as string).id).toBe(2)
  })
})
