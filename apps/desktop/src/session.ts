// The in-process daemon session the desktop app holds. One Agentd (@dool2/agentd) composes the engine turn loop, a
// brain, the host bridges, the vault and the autonomy gate; the Electron main process (main.ts) owns an instance and
// calls send()/setLevel() on it. This module imports NO electron, so the brain/bridge wiring stays unit-testable.
//
// Two bridge builds:
//   - offline (default, and always in the smoke test): @dool2/sandbox fake bridges — canned page/vault, no network,
//     no Chromium download. The "watch Dool2's browser" pane then has nothing real to show (captureFrame is null).
//   - built-in browser (DOOL2_BUILTIN_BROWSER=1): the REAL hidden Chromium — a @dool2/browser CdpBrowserCaller driven
//     over a DevTools pipe, wrapped by @dool2/page-bridge. The window never appears; the pane mirrors it via
//     captureFrame (a periodic screenshot). onAction is left unset on the page bridge: the sandbox already reports
//     every acting call to the gate, so wiring it here too would gate the same action twice (see agentd/bridges.ts).

import { Agentd, InMemoryVault, makeVaultBridge } from '@dool2/agentd'
import type { Brain } from '@dool2/brains'
import { CdpBrowserCaller } from '@dool2/browser'
import type { AutonomyLevel } from '@dool2/core'
import { createPageBridge } from '@dool2/page-bridge'
import { type HostBridges, makeFakeBridges } from '@dool2/sandbox'

export interface SessionOptions {
  brain: Brain
  /** Drive Dool2's own hidden Chromium instead of the fake page. Off by default (and in smoke). */
  builtinBrowser?: boolean
  /** Dool2 data folder: the downloaded Chromium build + profile. Required when builtinBrowser is on. */
  dataDir?: string
  /** The autonomy level to start at. Default 'ask' (ADR 0047). */
  level?: AutonomyLevel
}

export interface Session {
  agentd: Agentd
  /**
   * A single frame of the hidden browser as a data: URL, or null when there is nothing to show (offline/fake page, or
   * no tab open yet). The pane polls this only while the user has it open.
   */
  captureFrame(): Promise<string | null>
  /** Shut down anything opened (the hidden browser). Safe when nothing was launched. */
  close(): Promise<void>
}

/** Build the session: the host bridges, an Agentd over them, and the browser-mirror capture. */
export function createSession(opts: SessionOptions): Session {
  let caller: CdpBrowserCaller | undefined
  let bridges: HostBridges

  if (opts.builtinBrowser) {
    if (!opts.dataDir) throw new Error('builtinBrowser requires a dataDir for the downloaded Chromium')
    caller = new CdpBrowserCaller({ dataDir: opts.dataDir })
    const page = createPageBridge(caller)
    const fake = makeFakeBridges()
    const vault = new InMemoryVault()
    bridges = {
      page,
      vault: makeVaultBridge(vault, { page, level: () => agentd.level }),
      pc: fake.pc,
      fs: fake.fs,
    }
  } else {
    bridges = makeFakeBridges()
  }

  const agentd = new Agentd({ brain: opts.brain, bridges, level: opts.level ?? 'ask' })

  const capture = caller
  return {
    agentd,
    async captureFrame() {
      if (!capture) return null
      try {
        const { tabs } = (await capture.call('tabs')) as { tabs: { tabId: number; active: boolean }[] }
        const tab = tabs.find((t) => t.active) ?? tabs[0]
        if (!tab) return null
        const shot = (await capture.call('screenshot', { tabId: tab.tabId })) as {
          data: string
          mime: string
        }
        if (!shot.data) return null
        return `data:${shot.mime};base64,${shot.data}`
      } catch {
        return null
      }
    },
    async close() {
      if (caller) await caller.closeBrowser()
    },
  }
}
