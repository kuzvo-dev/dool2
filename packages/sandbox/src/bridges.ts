// The host bridges the sandbox injects as read-only globals (ADR 0045, ADR 0046): the broad hand that drives the
// page, the vault (masked), PC apps, and files. The daemon supplies the real implementations; this file is only the
// typed contract and the action classification the autonomy gate reads. The bridge objects are the ONLY host surface
// reachable from inside QuickJS; everything else (network, fs, process, the host globals) stays out.

import type { ActionTier, GatedAction } from '@dool2/core'

// --- page ---------------------------------------------------------------------------------------------------------

/** One actionable node of a page snapshot. `ref` is the opaque handle later calls (click/type) refer to. */
export interface PageNode {
  ref: string
  role: string
  name?: string
}

export interface PageSnapshot {
  url: string
  title: string
  nodes: PageNode[]
}

export interface FetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface FetchResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * A Playwright-ish read/act surface over Dool2's own hidden Chromium (ADR 0046). The real implementation drives the
 * browser over a DevTools pipe; here it is an async interface. Prefer the data path (`fetch` with the user session)
 * before clicking.
 */
export interface PageBridge {
  snapshot(): Promise<PageSnapshot>
  fetch(url: string, opts?: FetchOptions): Promise<FetchResponse>
  goto(url: string): Promise<void>
  click(ref: string): Promise<void>
  type(ref: string, text: string): Promise<void>
  press(key: string): Promise<void>
}

// --- vault --------------------------------------------------------------------------------------------------------

/**
 * A masked vault item. This is everything the AI may see about a credential: never a password, TOTP seed, or card
 * number. Filling happens by opaque `id`, so the secret value is placed into the page by the daemon and never passes
 * through the sandbox (Aside's design, REPORT §8.1).
 */
export interface VaultItemSummary {
  id: string
  site: string
  username: string
  hasTotp: boolean
}

/**
 * The vault surface. By construction it has no method that returns a secret value: `listItems` returns masked
 * summaries, and `fillLogin`/`fillTotp` act by `id` and resolve to nothing. Secrets reach the page through the
 * daemon, not the AI.
 */
export interface VaultBridge {
  listItems(): Promise<VaultItemSummary[]>
  fillLogin(id: string): Promise<void>
  fillTotp(id: string): Promise<void>
}

// --- pc -----------------------------------------------------------------------------------------------------------

export interface PcNode {
  nodeId: string
  role: string
  name?: string
}

export interface PcSnapshot {
  app: string
  nodes: PcNode[]
}

/** PC-app control (the mac/windows hands helper). Stub interface for v2; the real one drives the accessibility tree. */
export interface PcBridge {
  snapshot(): Promise<PcSnapshot>
  launch(app: string): Promise<void>
  click(nodeId: string): Promise<void>
  type(nodeId: string, text: string): Promise<void>
}

// --- fs -----------------------------------------------------------------------------------------------------------

/** File access within a single allowed root. The real implementation confines every path to that root. */
export interface FsBridge {
  read(path: string): Promise<string>
  list(path: string): Promise<string[]>
  write(path: string, content: string): Promise<void>
}

// --- the set the sandbox injects --------------------------------------------------------------------------------

export interface HostBridges {
  page: PageBridge
  vault: VaultBridge
  pc: PcBridge
  fs: FsBridge
}

export type BridgeName = keyof HostBridges

/**
 * Metadata for one bridge method. A read method is never gated. An acting method (it moves through a screen, fills a
 * login, launches an app, writes a file) is reported to the daemon's gate before it runs: `classify` turns the call
 * into a {@link GatedAction} the gate can weigh (ADR 0047). The gate itself is NOT implemented in the sandbox; this
 * is only the seam.
 */
export interface BridgeMethodMeta {
  acting: boolean
  classify?: (args: readonly unknown[]) => GatedAction
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))

const act = (label: string, tier: ActionTier = 'act'): GatedAction => ({ tier, label })

/**
 * Every method each bridge exposes, and how an acting call is classified for the gate. The sandbox injects exactly
 * these methods and nothing else, so this table is also the allow-list of the host surface.
 *
 * The default tier here is conservative (`act`); the daemon's gate refines it with page/skill context — for example a
 * click whose target the snapshot shows is a pay button becomes `pay`. The seam carries tier, label, and (later)
 * amount, so the gate has what it needs.
 */
export const BRIDGE_METHODS: Record<BridgeName, Record<string, BridgeMethodMeta>> = {
  page: {
    snapshot: { acting: false },
    fetch: { acting: false },
    goto: { acting: true, classify: (a) => act(`goto ${asString(a[0])}`) },
    click: { acting: true, classify: (a) => act(`click ${asString(a[0])}`) },
    type: { acting: true, classify: (a) => act(`type into ${asString(a[0])}`) },
    press: { acting: true, classify: (a) => act(`press ${asString(a[0])}`) },
  },
  vault: {
    listItems: { acting: false },
    fillLogin: { acting: true, classify: (a) => act(`fill login ${asString(a[0])}`) },
    fillTotp: { acting: true, classify: (a) => act(`fill TOTP ${asString(a[0])}`) },
  },
  pc: {
    snapshot: { acting: false },
    launch: { acting: true, classify: (a) => act(`launch app ${asString(a[0])}`) },
    click: { acting: true, classify: (a) => act(`pc click ${asString(a[0])}`) },
    type: { acting: true, classify: (a) => act(`pc type into ${asString(a[0])}`) },
  },
  fs: {
    read: { acting: false },
    list: { acting: false },
    write: { acting: true, classify: (a) => act(`write file ${asString(a[0])}`) },
  },
}
