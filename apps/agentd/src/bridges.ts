// Assemble the four host bridges the engine's code hand drives (ADR 0045/0046): page, vault, pc, fs.
//
// - page: the REAL hidden-browser adapter when the built-in browser is enabled — a @dool2/browser CdpBrowserCaller
//   (Dool2's own downloaded Chromium over a DevTools pipe) wrapped by @dool2/page-bridge createPageBridge. We leave
//   createPageBridge's own onAction UNSET: the sandbox already reports every acting call to the engine's gate via its
//   BRIDGE_METHODS table, so wiring onAction here too would gate the same action twice. When the flag is off (unit
//   tests, offline smoke) the page bridge falls back to @dool2/sandbox's fake, so nothing downloads Chromium.
// - vault: a simple in-memory vault (vault.ts) that only ever exposes masked summaries.
// - pc/fs: minimal stubs from @dool2/sandbox's fakes for now; the real mac/windows hands and the confined-root fs
//   land later.

import { CdpBrowserCaller } from '@dool2/browser'
import type { AutonomyLevel } from '@dool2/core'
import { createPageBridge } from '@dool2/page-bridge'
import { type HostBridges, makeFakeBridges } from '@dool2/sandbox'
import type { SkillMeta } from '@dool2/skill-sdk'
import type { AgentAccessPolicy } from '@dool2/vault'
import { InMemoryVault, makeVaultBridge } from './vault.js'

export interface BuildBridgesOptions {
  /**
   * Launch and drive Dool2's own hidden Chromium for the `page` bridge. Off by default so unit tests and the offline
   * smoke never download Chromium. Set it (the daemon reads DOOL2_BUILTIN_BROWSER) only when a real browser is wanted.
   */
  builtinBrowser?: boolean
  /** Dool2 data folder: the downloaded Chromium build and its profile live here. Required when builtinBrowser is on. */
  dataDir?: string
  /** The in-memory vault to back the `vault` bridge. Defaults to a fresh seeded one. */
  vault?: InMemoryVault
  /**
   * The current autonomy level, read when the vault fills a payment PIN (ADR 0047 gates that to full-auto). Defaults to
   * () => 'ask'. The daemon passes a getter that reflects the live session level.
   */
  level?: () => AutonomyLevel
  /**
   * Site skills with optional `login` field hints (e.g. the built-in pack from @dool2/skills). The vault consults them
   * to locate login fields by Korean label/role on the matched site. Omitted -> the vault uses only its English
   * heuristic.
   */
  skills?: () => readonly SkillMeta[]
  /**
   * The account default agent-access policy for vault fills (ADR 0023/0047), read live. Omitted -> the bridge reads
   * the policy held on the InMemoryVault ({@link InMemoryVault.accountPolicy}, default 'while-unlocked').
   */
  accessPolicy?: () => AgentAccessPolicy
  /**
   * Whether the vault is unlocked for the agent right now, read live. Omitted -> the bridge reads the vault's live
   * agent-access window ({@link InMemoryVault.unlockedForAgent}), which is LOCKED until unlock() is called.
   */
  unlocked?: () => boolean
}

export interface BuiltBridges {
  bridges: HostBridges
  /** The in-memory vault behind the `vault` bridge, so the daemon/tests can inspect fills. */
  vault: InMemoryVault
  /** Shut down anything the bridges opened (the hidden browser). Safe to call when nothing was launched. */
  close(): Promise<void>
}

/** Build the host bridge set. See the module header for what each bridge is and the double-gating note on `page`. */
export function buildHostBridges(opts: BuildBridgesOptions = {}): BuiltBridges {
  // The fakes supply the pc/fs stubs, and the page fallback when the built-in browser is off.
  const fake = makeFakeBridges()
  const vault = opts.vault ?? new InMemoryVault()

  let caller: CdpBrowserCaller | undefined
  let page = fake.page
  if (opts.builtinBrowser) {
    if (!opts.dataDir)
      throw new Error('builtinBrowser requires a dataDir for the downloaded Chromium and profile')
    caller = new CdpBrowserCaller({ dataDir: opts.dataDir })
    // onAction intentionally unset here — the sandbox/engine gate already weighs every acting page call.
    page = createPageBridge(caller)
  }

  const level = opts.level ?? ((): AutonomyLevel => 'ask')
  const vaultDeps = {
    page,
    level,
    ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
    ...(opts.accessPolicy !== undefined ? { accessPolicy: opts.accessPolicy } : {}),
    ...(opts.unlocked !== undefined ? { unlocked: opts.unlocked } : {}),
  }
  return {
    bridges: { page, vault: makeVaultBridge(vault, vaultDeps), pc: fake.pc, fs: fake.fs },
    vault,
    async close() {
      if (caller) await caller.closeBrowser()
    },
  }
}
