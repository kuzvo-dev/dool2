// In-memory fake host bridges for tests and daemon development. They return canned data and record every call so a
// test can assert what the sandbox drove. They never return a secret value, matching the real vault's contract.

import type { FetchResponse, HostBridges, PageSnapshot, PcSnapshot, VaultItemSummary } from './bridges.js'

export interface FakeBridges extends HostBridges {
  /** Every bridge method call, in order, as `name.method[:firstArg]`. */
  calls: string[]
}

/** Build fake bridges. Each returned object is independent; `calls` records invocations across all four bridges. */
export function makeFakeBridges(): FakeBridges {
  const calls: string[] = []
  const rec = (label: string): void => {
    calls.push(label)
  }

  return {
    calls,
    page: {
      async snapshot(): Promise<PageSnapshot> {
        rec('page.snapshot')
        return {
          url: 'https://example.com/login',
          title: 'Example',
          nodes: [
            { ref: 'e1', role: 'textbox', name: 'Email' },
            { ref: 'e2', role: 'button', name: 'Sign in' },
          ],
        }
      },
      async fetch(url: string): Promise<FetchResponse> {
        rec(`page.fetch:${url}`)
        return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }
      },
      async goto(url: string): Promise<void> {
        rec(`page.goto:${url}`)
      },
      async click(ref: string): Promise<void> {
        rec(`page.click:${ref}`)
      },
      async type(ref: string): Promise<void> {
        rec(`page.type:${ref}`)
      },
      async press(key: string): Promise<void> {
        rec(`page.press:${key}`)
      },
      // The vault's secret fill path. The ref is recorded; the value is not, matching the real contract that a secret
      // never surfaces (not even into the call log a test reads).
      async fill(ref: string): Promise<void> {
        rec(`page.fill:${ref}`)
      },
    },
    vault: {
      async listItems(): Promise<VaultItemSummary[]> {
        rec('vault.listItems')
        return [
          { id: 'v1', site: 'naver.com', username: 'user@example.com', hasTotp: true },
          { id: 'v2', site: 'coupang.com', username: 'shopper', hasTotp: false },
        ]
      },
      async fillLogin(id: string): Promise<void> {
        rec(`vault.fillLogin:${id}`)
      },
      async fillTotp(id: string): Promise<void> {
        rec(`vault.fillTotp:${id}`)
      },
      async fillPaymentPin(id: string): Promise<void> {
        rec(`vault.fillPaymentPin:${id}`)
      },
    },
    pc: {
      async snapshot(): Promise<PcSnapshot> {
        rec('pc.snapshot')
        return { app: 'Finder', nodes: [{ nodeId: 'n1', role: 'window', name: 'Downloads' }] }
      },
      async launch(app: string): Promise<void> {
        rec(`pc.launch:${app}`)
      },
      async click(nodeId: string): Promise<void> {
        rec(`pc.click:${nodeId}`)
      },
      async type(nodeId: string): Promise<void> {
        rec(`pc.type:${nodeId}`)
      },
    },
    fs: {
      async read(path: string): Promise<string> {
        rec(`fs.read:${path}`)
        return 'file contents'
      },
      async list(path: string): Promise<string[]> {
        rec(`fs.list:${path}`)
        return ['a.txt', 'b.txt']
      },
      async write(path: string): Promise<void> {
        rec(`fs.write:${path}`)
      },
    },
  }
}
