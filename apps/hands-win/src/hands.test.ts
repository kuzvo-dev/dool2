import { beforeEach, describe, expect, it } from 'vitest'
import { Hands } from './hands.js'
import { type FakeApp, InMemoryUiaBackend, uiaEl } from './in-memory-backend.js'
import { HandsError } from './safety.js'

function seed(): FakeApp[] {
  return [
    {
      app: 'demo.exe',
      name: 'Demo',
      pid: 1000,
      active: true,
      windows: [
        {
          title: 'Sign in',
          front: true,
          root: uiaEl({
            controlType: 'Window',
            name: 'Sign in',
            rect: { x: 0, y: 0, width: 400, height: 300 },
            children: [
              uiaEl({ controlType: 'Edit', name: '이메일', handle: 'email' }),
              uiaEl({
                controlType: 'Edit',
                name: '비밀번호',
                isPassword: true,
                value: 'hunter2',
                handle: 'pw',
              }),
              uiaEl({ controlType: 'Button', name: '로그인', handle: 'submit' }),
            ],
          }),
        },
      ],
    },
    { app: 'other.exe', name: 'Other', pid: 1001, running: false },
  ]
}

describe('Hands commands', () => {
  let backend: InMemoryUiaBackend
  let hands: Hands

  beforeEach(() => {
    backend = new InMemoryUiaBackend(seed())
    hands = new Hands(backend)
  })

  it('apps() lists running apps in the mac result shape', async () => {
    const apps = (await hands.run('apps', {})) as Array<Record<string, unknown>>
    expect(apps).toEqual([{ bundleId: 'demo.exe', name: 'Demo', pid: 1000, active: true }])
  })

  it('installed() includes non-running apps', async () => {
    const apps = (await hands.run('installed', {})) as Array<Record<string, unknown>>
    expect(apps.map((a) => a.bundleId)).toContain('other.exe')
  })

  it('status() reports the mac-shaped permission object', async () => {
    const s = (await hands.run('status', {})) as Record<string, unknown>
    expect(s).toEqual({ accessibility: true, screenRecording: true, locked: false, platform: 'win' })
  })

  it('snapshot sets refs; click by ref dispatches to the right element', async () => {
    await hands.run('snapshot', { bundleId: 'demo.exe' })
    const res = (await hands.run('click', { bundleId: 'demo.exe', ref: 'e3' })) as Record<string, unknown>
    expect(res).toEqual({ via: 'element' })
    expect(backend.actions.clickedElements).toEqual(['submit'])
  })

  it('click by x/y goes to a point', async () => {
    const res = (await hands.run('click', { bundleId: 'demo.exe', x: 10, y: 20 })) as Record<string, unknown>
    expect(res).toEqual({ via: 'point' })
    expect(backend.actions.clickedPoints).toEqual([{ app: 'demo.exe', x: 10, y: 20 }])
  })

  it('type into a normal field focuses and sets its value', async () => {
    await hands.run('snapshot', { bundleId: 'demo.exe' })
    const res = (await hands.run('type', { bundleId: 'demo.exe', ref: 'e1', text: 'a@b.com' })) as Record<
      string,
      unknown
    >
    expect(res).toEqual({ typed: 7 })
    expect(backend.actions.focused).toEqual(['email'])
    expect(backend.actions.setValues).toEqual([{ handle: 'email', text: 'a@b.com' }])
  })

  it('type refuses a secure/password field', async () => {
    await hands.run('snapshot', { bundleId: 'demo.exe' })
    await expect(hands.run('type', { bundleId: 'demo.exe', ref: 'e2', text: 'x' })).rejects.toBeInstanceOf(
      HandsError,
    )
    expect(backend.actions.setValues).toEqual([])
  })

  it('key refuses a destructive combo but sends an ordinary key', async () => {
    await expect(
      hands.run('key', { bundleId: 'demo.exe', key: 'F4', modifiers: ['alt'] }),
    ).rejects.toBeInstanceOf(HandsError)
    const res = (await hands.run('key', { bundleId: 'demo.exe', key: 'Enter' })) as Record<string, unknown>
    expect(res).toEqual({ pressed: 'Enter' })
    expect(backend.actions.keys).toEqual([{ app: 'demo.exe', key: 'Enter', modifiers: [] }])
  })

  it('screenshot returns the expected shape', async () => {
    const shot = (await hands.run('screenshot', { bundleId: 'demo.exe' })) as Record<string, unknown>
    expect(shot.mime).toBe('image/jpeg')
    expect(typeof shot.data).toBe('string')
    expect(shot.window).toBe('Sign in')
    expect(typeof shot.width).toBe('number')
    expect(typeof shot.height).toBe('number')
  })

  it('open launches an app', async () => {
    const res = (await hands.run('open', { bundleId: 'demo.exe' })) as Record<string, unknown>
    expect(res).toEqual({ bundleId: 'demo.exe', opened: true })
    expect(backend.actions.launched).toEqual(['demo.exe'])
  })

  it('refuses a hard-blocked app on every acting command', async () => {
    await expect(hands.run('snapshot', { bundleId: 'chrome.exe' })).rejects.toBeInstanceOf(HandsError)
    await expect(hands.run('open', { bundleId: '1password.exe' })).rejects.toBeInstanceOf(HandsError)
  })

  it('a stale ref after re-snapshot of another app is rejected', async () => {
    await hands.run('snapshot', { bundleId: 'demo.exe' })
    await expect(hands.run('click', { bundleId: 'other.exe', ref: 'e1' })).rejects.toBeInstanceOf(HandsError)
  })
})
