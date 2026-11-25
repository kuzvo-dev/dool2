// Connector packs (ADR 0039): the service cards and connectors (skills/<id>/connect.json, tools.json) arrive as one
// signed bundle, without a new app version. A pack is a full snapshot of skills/ at one commit. The steps in tools.json
// drive the user's signed-in browser, so a pack counts as code: it is taken only when the signature (ed25519, a key
// apart from the app update key) and the bundle checksum match, and never one older than what this PC already has.
// The approval gate does not come from packs (threat model T12): a pack cannot let a payment or send skip approval.
import { createHash, verify } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { versionAtLeast } from '@dool2/protocol'
import { ConnectCardSchema } from '@dool2/protocol/connect'
import { ConnectorSchema } from '@dool2/protocol/connector'

/** What the signed feed (pack.json) says, in its payload */
export interface PackManifest {
  /** Pack number: Unix seconds of the last skills/ commit. Higher is newer */
  pack: number
  /** Oldest app version that can read it */
  minApp: string
  date: string
  /** The bundle file (gzip of PackBundle JSON) */
  url: string
  sha256: string
  size: number
}
/** pack.json: payload (PackManifest JSON in base64) and its signature, the same shape as the app's version.json */
export interface SignedPack {
  payload: string
  signature: string
}
/** The bundle: "<id>/connect.json" or "<id>/tools.json" → file text */
export interface PackBundle {
  pack: number
  files: Record<string, string>
}

export interface PackState {
  /** Pack in use; 0 = the one that came with the app */
  active: number
  /** Number of the cards that came with the app */
  bundled: number
  /** Highest pack ever taken (an older one is never taken again) */
  highest: number
  /** Packs put back by the user (not taken again) */
  skipped: number[]
  checkedAt?: string
  /** Last check that did not install, in plain words for the settings screen and the log */
  note?: string
}

export interface PackOptions {
  /** Data folder: packs live in <dataDir>/packs */
  dataDir: string
  /** skills/ that came with the app */
  bundledDir: string | undefined
  /** Pack number of the bundled skills/ (written when the app was packaged); 0 if unknown */
  bundledPack: number
  appVersion: string
  /** Signed feed (pack.json), or a function giving it at each check; undefined = automatic packs are off */
  feed: string | (() => string | undefined)
  /** Public keys that may sign packs (more than one so the key can be changed) */
  publicKeys: string[]
  fetch?: typeof fetch
  now?: () => Date
  log?: (kind: string, data: Record<string, unknown>) => void
  /**
   * Checks the instruction files of a pack (prompts/, ADR 0040): their problems, empty when usable. Without it a
   * pack's instruction files are left out
   */
  checkPrompts?: (files: Record<string, string>) => string[]
  /** Called after the pack in use changed (taken or put back), so the instruction files can be switched too */
  onChange?: () => void | Promise<void>
}

const FILE = /^([a-z0-9][a-z0-9-]{0,40})\/(connect|tools)\.json$/
/** Instruction files (ADR 0040): prompts/persona.md, prompts/voice/ko.md, … */
const PROMPT = /^prompts\/((?:[a-z0-9-]+\/)*[a-z0-9-]+\.md)$/
/** A pack bigger than this is refused (the whole skills/ is about 3 MB as text) */
const MAX_BYTES = 30 * 1024 * 1024

/** Checks the signature with any of the keys; the manifest, or undefined if it is not ours or malformed */
export function openPack(signed: unknown, publicKeys: string[]): PackManifest | undefined {
  if (!signed || typeof signed !== 'object') return undefined
  const { payload, signature } = signed as Partial<SignedPack>
  if (typeof payload !== 'string' || typeof signature !== 'string') return undefined
  const data = Buffer.from(payload, 'base64')
  const sig = Buffer.from(signature, 'base64')
  const ok = publicKeys.some((k) => {
    try {
      return verify(null, data, k, sig)
    } catch {
      return false
    }
  })
  if (!ok) return undefined
  try {
    const m = JSON.parse(data.toString('utf8')) as PackManifest
    if (!Number.isInteger(m.pack) || m.pack <= 0) return undefined
    if (typeof m.minApp !== 'string' || typeof m.url !== 'string' || !/^https:\/\//.test(m.url))
      return undefined
    if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) return undefined
    if (!Number.isInteger(m.size) || m.size <= 0 || m.size > MAX_BYTES) return undefined
    return m
  } catch {
    return undefined
  }
}

/**
 * Files of a bundle this app can read. A card or connector this app cannot read (a step kind it does not know yet, a
 * malformed file) falls back to the one that came with the app, so an old app keeps its working version of that
 * service instead of losing it
 */
export async function usableFiles(
  bundle: PackBundle,
  bundledDir: string | undefined,
  checkPrompts?: (files: Record<string, string>) => string[],
): Promise<{ files: Map<string, string>; fallback: string[] }> {
  const files = new Map<string, string>()
  const fallback: string[] = []
  // Instruction files go in as one set or not at all: a set this app cannot use leaves the ones it carries
  const prompts: Record<string, string> = {}
  for (const [path, text] of Object.entries(bundle.files)) {
    const m = PROMPT.exec(path)
    if (m) prompts[m[1] as string] = text
  }
  if (Object.keys(prompts).length) {
    const problems = checkPrompts ? checkPrompts(prompts) : ['no instruction check']
    if (problems.length) fallback.push('prompts/')
    else for (const [rel, text] of Object.entries(prompts)) files.set(`prompts/${rel}`, text)
  }
  const bundled = async (path: string) =>
    bundledDir ? await readFile(join(bundledDir, path), 'utf8').catch(() => undefined) : undefined
  const ids = new Set<string>()
  for (const path of Object.keys(bundle.files)) {
    const m = FILE.exec(path)
    if (m) ids.add(m[1] as string)
  }
  for (const id of [...ids].sort()) {
    const card = bundle.files[`${id}/connect.json`]
    const tools = bundle.files[`${id}/tools.json`]
    let cardText = card && readable(card, 'card', id) ? card : undefined
    if (!cardText) {
      cardText = await bundled(`${id}/connect.json`)
      if (!cardText) continue
      fallback.push(`${id}/connect.json`)
    }
    files.set(`${id}/connect.json`, cardText)
    if (tools === undefined) continue
    if (readable(tools, 'tools', id)) files.set(`${id}/tools.json`, tools)
    else {
      fallback.push(`${id}/tools.json`)
      const old = await bundled(`${id}/tools.json`)
      if (old) files.set(`${id}/tools.json`, old)
    }
  }
  return { files, fallback }
}

function readable(text: string, kind: 'card' | 'tools', id: string): boolean {
  try {
    const json = JSON.parse(text)
    const r = kind === 'card' ? ConnectCardSchema.safeParse(json) : ConnectorSchema.safeParse(json)
    return r.success && r.data.id === id
  } catch {
    return false
  }
}

export class ConnectorPacks {
  private st: PackState
  private timer?: NodeJS.Timeout
  private running?: Promise<PackState>

  private constructor(
    private readonly opts: PackOptions,
    state: PackState,
  ) {
    this.st = state
  }

  /** Reads the saved state; a pack is used only if it is still on disk and newer than the bundled cards */
  static async open(opts: PackOptions): Promise<ConnectorPacks> {
    const saved = await readFile(join(opts.dataDir, 'packs', 'state.json'), 'utf8')
      .then((t) => JSON.parse(t) as Partial<PackState>)
      .catch(() => ({}) as Partial<PackState>)
    const st: PackState = {
      active: 0,
      bundled: opts.bundledPack,
      highest: Math.max(saved.highest ?? 0, opts.bundledPack),
      skipped: Array.isArray(saved.skipped) ? saved.skipped.filter(Number.isInteger) : [],
      ...(saved.checkedAt ? { checkedAt: saved.checkedAt } : {}),
    }
    const a = saved.active ?? 0
    if (a > opts.bundledPack && !st.skipped.includes(a)) {
      const ok = await readdir(join(opts.dataDir, 'packs', String(a), 'skills')).then(
        () => true,
        () => false,
      )
      if (ok) st.active = a
    }
    return new ConnectorPacks(opts, st)
  }

  /** Instruction files of the pack in use ("voice/ko.md" → text), or undefined to use the ones the app carries */
  async promptFiles(): Promise<Record<string, string> | undefined> {
    if (!this.st.active) return undefined
    const base = join(this.opts.dataDir, 'packs', String(this.st.active), 'prompts')
    const out: Record<string, string> = {}
    const walk = async (dir: string, rel: string) => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) await walk(join(dir, e.name), r)
        else if (PROMPT.test(`prompts/${r}`)) out[r] = await readFile(join(dir, e.name), 'utf8')
      }
    }
    await walk(base, '')
    return Object.keys(out).length ? out : undefined
  }

  /** skills/ folder to read cards and connectors from now */
  dir(): string | undefined {
    return this.st.active
      ? join(this.opts.dataDir, 'packs', String(this.st.active), 'skills')
      : this.opts.bundledDir
  }

  state(): PackState {
    return { ...this.st, skipped: [...this.st.skipped] }
  }

  /** Checks the feed now and after a minute, then every 6 hours */
  start(firstMs = 60_000, everyMs = 6 * 3600_000) {
    const run = () => {
      void this.check().catch(() => undefined)
      this.timer = setTimeout(run, everyMs)
      this.timer.unref?.()
    }
    this.timer = setTimeout(run, firstMs)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
  }

  /** Checks the feed and installs a newer pack. One check at a time */
  check(): Promise<PackState> {
    this.running ??= this.checkOnce().finally(() => {
      this.running = undefined
    })
    return this.running
  }

  /** Puts back the cards that came with the app and does not take this pack again */
  async rollback(): Promise<PackState> {
    if (!this.st.active) return this.state()
    this.st.skipped = [...new Set([...this.st.skipped, this.st.active])].slice(-20)
    this.log('pack-rollback', { pack: this.st.active })
    this.st.active = 0
    delete this.st.note
    await this.save()
    await this.opts.onChange?.()
    return this.state()
  }

  private async checkOnce(): Promise<PackState> {
    const f = this.opts.fetch ?? fetch
    this.st.checkedAt = (this.opts.now?.() ?? new Date()).toISOString()
    const done = async (note?: string) => {
      if (note) this.st.note = note
      else delete this.st.note
      await this.save()
      return this.state()
    }
    const feed = typeof this.opts.feed === 'function' ? this.opts.feed() : this.opts.feed
    if (!feed) return done('automatic packs are off')
    let manifest: PackManifest | undefined
    try {
      const r = await f(feed, { redirect: 'follow', signal: AbortSignal.timeout(20_000) })
      if (!r.ok) return done(`feed ${r.status}`)
      manifest = openPack(await r.json(), this.opts.publicKeys)
    } catch (e) {
      return done(`feed: ${(e as Error).message}`)
    }
    if (!manifest) {
      this.log('pack-refused', { why: 'signature' })
      return done('signature did not match')
    }
    const m = manifest
    if (
      m.pack <= Math.max(this.st.highest, this.st.active, this.st.bundled) ||
      this.st.skipped.includes(m.pack)
    )
      return done()
    if (!versionAtLeast(this.opts.appVersion, m.minApp)) return done(`needs app ${m.minApp}`)
    let bundle: PackBundle
    try {
      const r = await f(m.url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) })
      if (!r.ok) return done(`bundle ${r.status}`)
      const raw = Buffer.from(await r.arrayBuffer())
      if (raw.length !== m.size || createHash('sha256').update(raw).digest('hex') !== m.sha256) {
        this.log('pack-refused', { pack: m.pack, why: 'checksum' })
        return done('checksum did not match')
      }
      bundle = JSON.parse(gunzipSync(raw, { maxOutputLength: MAX_BYTES * 4 }).toString('utf8')) as PackBundle
      if (bundle.pack !== m.pack || !bundle.files || typeof bundle.files !== 'object')
        return done('bundle does not match its manifest')
    } catch (e) {
      return done(`bundle: ${(e as Error).message}`)
    }
    const { files, fallback } = await usableFiles(bundle, this.opts.bundledDir, this.opts.checkPrompts)
    if (![...files.keys()].some((p) => FILE.test(p))) return done('no readable cards in the pack')
    await this.install(m.pack, files)
    this.st.highest = m.pack
    this.st.active = m.pack
    this.log('pack-installed', { pack: m.pack, files: files.size, fallback })
    const st = await done()
    await this.opts.onChange?.()
    return st
  }

  /** Writes the pack next to the others and switches to it (a half-written pack is never used) */
  private async install(pack: number, files: Map<string, string>) {
    const root = join(this.opts.dataDir, 'packs')
    const tmp = join(root, `${pack}.tmp`)
    await rm(tmp, { recursive: true, force: true })
    for (const [path, text] of files) {
      const p = path.startsWith('prompts/') ? join(tmp, path) : join(tmp, 'skills', path)
      await mkdir(join(p, '..'), { recursive: true })
      await writeFile(p, text)
    }
    await rm(join(root, String(pack)), { recursive: true, force: true })
    await rename(tmp, join(root, String(pack)))
    // Keep only this pack and the one before it (for a quick look back); the bundled cards are always there
    const keep = new Set([String(pack), String(this.st.active), 'state.json'])
    for (const n of await readdir(root).catch(() => [] as string[]))
      if (!keep.has(n)) await rm(join(root, n), { recursive: true, force: true })
  }

  private async save() {
    const root = join(this.opts.dataDir, 'packs')
    await mkdir(root, { recursive: true })
    const { bundled: _b, ...keep } = this.st
    await writeFile(join(root, 'state.json'), JSON.stringify(keep, null, 2))
  }

  private log(kind: string, data: Record<string, unknown>) {
    this.opts.log?.(kind, data)
  }
}
