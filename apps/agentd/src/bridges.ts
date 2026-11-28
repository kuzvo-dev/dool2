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
//
// Learn-by-watching (ADR 0046): when a `recorderSink` is supplied, the acting page methods (goto/click/type) also
// report the UI step to the sink (the field ref/label only — never the typed value), and the vault reports the login
// fields it located (page refs only — never a secret). When `learn` is on and a browser caller exists, a `newRecorder`
// factory is returned so the daemon can start a network recorder per turn; the sink routes to that recorder.

import {
  CdpBrowserCaller,
  type RecordingBrowserCaller,
  recordSession,
  type SessionRecorder,
} from '@dool2/browser'
import type { AutonomyLevel } from '@dool2/core'
import { createPageBridge } from '@dool2/page-bridge'
import { type HostBridges, makeFakeBridges, type PageBridge } from '@dool2/sandbox'
import type { SkillMeta } from '@dool2/skill-sdk'
import type { AgentAccessPolicy } from '@dool2/vault'
import type { RecorderSink } from './learn.js'
import { InMemoryVault, makeVaultBridge } from './vault.js'

export interface BuildBridgesOptions {
  /**
   * Launch and drive Dool2's own hidden Chromium for the `page` bridge. Off by default so unit tests and the offline
   * smoke never download Chromium. Set it (the daemon reads DOOL2_BUILTIN_BROWSER) only when a real browser is wanted.
   */
  builtinBrowser?: boolean
  /** Dool2 data folder: the downloaded Chromium build and its profile live here. Required when builtinBrowser is on. */
  dataDir?: string
  /**
   * Inject a browser caller instead of constructing a CdpBrowserCaller (tests pass a fake that emits CDP events). When
   * set, it is used for the `page` bridge and the recorder factory, and {@link builtinBrowser}/{@link dataDir} are
   * ignored. It is NOT closed by {@link BuiltBridges.close} — the injector owns its lifecycle.
   */
  caller?: RecordingBrowserCaller
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
  /**
   * Produce a per-turn network recorder factory ({@link BuiltBridges.newRecorder}) when a browser caller exists. Off
   * for the fake page, so unit tests never record. Default off.
   */
  learn?: boolean
  /**
   * The sink the acting page/vault wrappers report UI steps + login fields to (the daemon's LearnController). Omitted
   * -> no acting steps are observed. The sink carries no secret: only field refs/labels, never typed values.
   */
  recorderSink?: RecorderSink
}

export interface BuiltBridges {
  bridges: HostBridges
  /** The in-memory vault behind the `vault` bridge, so the daemon/tests can inspect fills. */
  vault: InMemoryVault
  /**
   * Make a network recorder for a turn, bound to the live browser caller. Present only when {@link BuildBridgesOptions.learn}
   * is on and a caller exists (the built-in browser); undefined for the fake page.
   */
  newRecorder?: (opts: { url?: string; keywords?: string[] }) => SessionRecorder
  /** Shut down anything the bridges opened (the hidden browser). Safe to call when nothing was launched. */
  close(): Promise<void>
}

/** Build the host bridge set. See the module header for what each bridge is and the double-gating note on `page`. */
export function buildHostBridges(opts: BuildBridgesOptions = {}): BuiltBridges {
  // The fakes supply the pc/fs stubs, and the page fallback when the built-in browser is off.
  const fake = makeFakeBridges()
  const vault = opts.vault ?? new InMemoryVault()

  // An injected caller wins; otherwise launch the real hidden Chromium when asked; otherwise the fake page.
  let cdp: CdpBrowserCaller | undefined
  let caller: RecordingBrowserCaller | undefined
  let page: PageBridge = fake.page
  if (opts.caller) {
    caller = opts.caller
    page = createPageBridge(caller)
  } else if (opts.builtinBrowser) {
    if (!opts.dataDir)
      throw new Error('builtinBrowser requires a dataDir for the downloaded Chromium and profile')
    cdp = new CdpBrowserCaller({ dataDir: opts.dataDir })
    caller = cdp
    // onAction intentionally unset here — the sandbox/engine gate already weighs every acting page call.
    page = createPageBridge(cdp)
  }

  // Report the UI steps that worked to the recorder sink (the field ref/label only, never a typed value).
  if (opts.recorderSink) page = wrapPageForRecording(page, opts.recorderSink)

  const level = opts.level ?? ((): AutonomyLevel => 'ask')
  const vaultDeps = {
    page,
    level,
    ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
    ...(opts.accessPolicy !== undefined ? { accessPolicy: opts.accessPolicy } : {}),
    ...(opts.unlocked !== undefined ? { unlocked: opts.unlocked } : {}),
    ...(opts.recorderSink !== undefined
      ? {
          onLoginFields: (fields: Parameters<RecorderSink['noteLoginFields']>[0]) =>
            opts.recorderSink?.noteLoginFields(fields),
        }
      : {}),
  }

  const newRecorder =
    opts.learn && caller
      ? (recorderOpts: { url?: string; keywords?: string[] }): SessionRecorder =>
          recordSession(caller as RecordingBrowserCaller, recorderOpts)
      : undefined

  return {
    bridges: { page, vault: makeVaultBridge(vault, vaultDeps), pc: fake.pc, fs: fake.fs },
    vault,
    ...(newRecorder ? { newRecorder } : {}),
    async close() {
      // Only a caller we constructed is ours to close; an injected one is the injector's to manage.
      if (cdp) await cdp.closeBrowser()
    },
  }
}

/**
 * Wrap a page bridge so each acting method (goto/click/type) also reports a UI step to the recorder sink AFTER it
 * succeeds (so only steps that worked are kept). `type` reports the field ref only — the typed value is never passed,
 * so a secret never reaches the recorder. `snapshot`/`fetch`/`press`/`fill` pass straight through.
 */
function wrapPageForRecording(page: PageBridge, sink: RecorderSink): PageBridge {
  return {
    ...page,
    async goto(url: string): Promise<void> {
      // Note the url first so the recorder's data-path filter is on the right host before any XHR fires.
      sink.noteUrl(url)
      await page.goto(url)
      sink.addUiStep({ action: 'goto', label: url })
    },
    async click(ref: string): Promise<void> {
      await page.click(ref)
      sink.addUiStep({ action: 'click', ref })
    },
    async type(ref: string, text: string): Promise<void> {
      await page.type(ref, text)
      sink.addUiStep({ action: 'type', ref })
    },
  }
}
