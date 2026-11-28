// The real `page` host-bridge adapter (v2). Behind the sandbox's read-only `page` bridge contract
// (@dool2/sandbox PageBridge) it drives Dool2's own hidden Chromium — the merged CdpBrowserCaller in
// @dool2/browser, which speaks over a DevTools pipe (ADR 0046). The v2 engine injects host bridges into the
// code-execution hand; until now the `page` bridge was a fake (makeFakeBridges). This is the real one: each
// PageBridge method maps onto exactly one CdpBrowserCaller command, and each acting method (goto/click/type/press)
// is reported to the autonomy gate seam (a GatedAction) BEFORE it calls the caller, so a gate can weigh it.
//
// Dependency injection: the adapter talks only to a minimal `BrowserCallerLike` (just `call`). CdpBrowserCaller
// satisfies it; tests inject a fake caller and never launch real Chromium.
//
// Mapping (bridge method -> caller command):
//   snapshot()        -> call('snapshot', {tabId})           read, not gated; text marks parsed into nodes
//   fetch(url, opts)  -> call('fetch', {tabId, url, ...})    the data path (user-session fetch); read, not gated
//   goto(url)         -> call('open', {url}) | call('navigate', {tabId, url})   acting
//   click(ref)        -> call('click', {tabId, ref})         acting
//   type(ref, text)   -> call('type', {tabId, ref, text})    acting
//   press(key)        -> call('press', {tabId, key})         acting

import type { ActionTier, GatedAction } from '@dool2/core'
import type { FetchOptions, FetchResponse, PageBridge, PageNode, PageSnapshot } from '@dool2/sandbox'

/**
 * The slice of CdpBrowserCaller this adapter needs: one `call(cmd, args, timeoutMs)`. CdpBrowserCaller satisfies
 * it; tests inject a fake with the same shape so no real Chromium launches.
 */
export interface BrowserCallerLike {
  call(cmd: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

/** The acting page methods the gate weighs. `snapshot`/`fetch` only read and are never gated. */
export type PageActingMethod = 'goto' | 'click' | 'type' | 'press'

export interface CreatePageBridgeOptions {
  /**
   * Called with the {@link GatedAction} just before an acting method (goto/click/type/press) calls the caller, so a
   * gate can weigh it (ADR 0047). Throw/reject to stop the action: the bridge method then rejects, which is how a
   * blocked or unsigned action surfaces to the model. The caller command never runs in that case.
   *
   * Leave this unset when the adapter is injected into the Sandbox as `bridges.page`: the Sandbox already reports
   * acting calls to the engine's gate via its BRIDGE_METHODS table, so setting `onAction` here too would gate the
   * same action twice. Set it when driving the browser directly, outside the sandbox.
   */
  onAction?: (action: GatedAction) => void | Promise<void>
  /**
   * Override the default (conservative `act`) classification — e.g. a skill that knows the clicked node is a pay
   * button returns `{ tier: 'pay', ... }`. The default keeps every page action at `act`; the engine/skill refines
   * it from page context.
   */
  classify?: (method: PageActingMethod, args: readonly unknown[]) => GatedAction
  /** Per-call timeout forwarded to the caller (ms). Omitted -> the caller's own default. */
  timeoutMs?: number
  /** A tab id that is already open; otherwise the first `goto` opens one. */
  tabId?: number
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))

const act = (label: string, tier: ActionTier = 'act'): GatedAction => ({ tier, label })

/** Default classification. Labels mirror @dool2/sandbox's BRIDGE_METHODS.page so the adapter and sandbox read alike. */
function defaultClassify(method: PageActingMethod, args: readonly unknown[]): GatedAction {
  switch (method) {
    case 'goto':
      return act(`goto ${asString(args[0])}`)
    case 'click':
      return act(`click ${asString(args[0])}`)
    case 'type':
      return act(`type into ${asString(args[0])}`)
    case 'press':
      return act(`press ${asString(args[0])}`)
  }
}

/** The fields this adapter reads back from the caller's `snapshot` command. */
interface CallerSnapshot {
  url?: string
  title?: string
  text?: string
}

/**
 * Parse the inline ref marks a CdpBrowserCaller snapshot embeds — `[eN role "name"]`, where `role` is a single
 * (possibly Korean) word and the quoted name is optional — into the sandbox's PageNode[]. The caller's snapshot
 * walk (cdp-caller SNAPSHOT_FN) emits exactly this form.
 */
export function parseNodes(text: string): PageNode[] {
  const nodes: PageNode[] = []
  const re = /\[(e\d+)\s+(\S+?)(?:\s+"([^"]*)")?\]/g
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const ref = m[1]
    const role = m[2]
    const name = m[3]
    if (ref === undefined || role === undefined) continue
    nodes.push(name !== undefined ? { ref, role, name } : { ref, role })
  }
  return nodes
}

/**
 * Build a real `page` {@link PageBridge} backed by a {@link BrowserCallerLike} (the merged CdpBrowserCaller). The
 * result can be dropped in as the sandbox/engine `page` bridge. It manages the current tab id (opened on the first
 * `goto`) and reports a {@link GatedAction} before every acting call when `onAction` is supplied.
 */
export function createPageBridge(caller: BrowserCallerLike, opts: CreatePageBridgeOptions = {}): PageBridge {
  const classify = opts.classify ?? defaultClassify
  const timeoutMs = opts.timeoutMs
  let tabId = opts.tabId

  const call = (cmd: string, args: Record<string, unknown>): Promise<unknown> =>
    caller.call(cmd, args, timeoutMs)

  const requireTab = (method: string): number => {
    if (tabId === undefined)
      throw new Error(`No page is open yet; call page.goto(url) before page.${method}().`)
    return tabId
  }

  const report = async (method: PageActingMethod, args: readonly unknown[]): Promise<void> => {
    if (opts.onAction) await opts.onAction(classify(method, args))
  }

  return {
    async snapshot(): Promise<PageSnapshot> {
      const id = requireTab('snapshot')
      const r = (await call('snapshot', { tabId: id })) as CallerSnapshot
      return { url: r.url ?? '', title: r.title ?? '', nodes: parseNodes(r.text ?? '') }
    },

    async fetch(url: string, fetchOpts?: FetchOptions): Promise<FetchResponse> {
      // The data path: a fetch issued inside the page under the user's live session (cookies), preferred over
      // clicking through a UI. It maps to a `fetch` command on the caller. The merged CdpBrowserCaller does not
      // implement that command yet (its SUPPORTED list stops before `fetch`), so today this surfaces the caller's
      // own clear "cannot fetch yet" error — the seam is wired and ready for when the command lands. fetch reads,
      // so it is never gated.
      const id = requireTab('fetch')
      const r = (await call('fetch', {
        tabId: id,
        url,
        ...(fetchOpts?.method !== undefined ? { method: fetchOpts.method } : {}),
        ...(fetchOpts?.headers !== undefined ? { headers: fetchOpts.headers } : {}),
        ...(fetchOpts?.body !== undefined ? { body: fetchOpts.body } : {}),
      })) as Partial<FetchResponse>
      return {
        status: typeof r.status === 'number' ? r.status : 0,
        headers: r.headers ?? {},
        body: typeof r.body === 'string' ? r.body : '',
      }
    },

    async goto(url: string): Promise<void> {
      await report('goto', [url])
      if (tabId === undefined) {
        const r = (await call('open', { url })) as { tabId?: number }
        if (typeof r.tabId !== 'number') throw new Error('browser `open` did not return a tabId')
        tabId = r.tabId
      } else {
        await call('navigate', { tabId, url })
      }
    },

    async click(ref: string): Promise<void> {
      const id = requireTab('click')
      await report('click', [ref])
      await call('click', { tabId: id, ref })
    },

    async type(ref: string, text: string): Promise<void> {
      const id = requireTab('type')
      await report('type', [ref, text])
      await call('type', { tabId: id, ref, text })
    },

    async press(key: string): Promise<void> {
      const id = requireTab('press')
      await report('press', [key])
      await call('press', { tabId: id, key })
    },
  }
}
