// Making images (image_make): makes a picture with the image AI on Gemini web, signed in on the user's Chrome, and downloads it.
// Invitations, posters and cards Dool used to draw by hand with SVG shapes looked like clip art (user feedback 11-22),
// so we use the image AI on the user's free account through the browser. Korean text can go inside the picture too.
// Follow-up fixes in the same conversation ("bigger text") go to the same Gemini chat (edit).

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import {
  CHATGPT_ANSWERED,
  CHATGPT_DOWNLOAD,
  CHATGPT_INPUT,
  CHATGPT_SIGNED_OUT,
  CHATGPT_SPLIT,
  DEFAULT_IMAGE_NAME,
  DRAWING,
  GEMINI_ANSWERED,
  GEMINI_DOWNLOAD,
  GEMINI_INPUT,
  GEMINI_NAME,
  GEMINI_SPLIT,
  LIMIT,
  ONBOARD,
  SIGNED_OUT,
} from './region/kr/image-ui.js'

export interface ImageBrowser {
  call(command: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

export interface ImageMakeDeps {
  browser: ImageBrowser
  /** Folder the browser downloads into (~/Downloads) */
  downloadsDir: () => string | undefined
  /** Folder to keep made images in (the Dool folder in Documents) */
  saveDir: () => string | undefined
  /** Path shape to show the user */
  show: (p: string) => string
  /** Upload to the library and phone (image: JPEG base64 preview) */
  onMade?: (f: { name: string; kind: 'png'; path: string; image?: string }) => void
  /** Keeps a picture to show in the chat (preview JPEG base64 -> file name in photos/) */
  keepPhoto?: (jpeg: string, title: string, path: string) => Promise<void>
  /** PNG to a small JPEG (base64): the library preview and the picture Dool looks at to check */
  preview?: (png: Buffer, mime: string) => Promise<string | undefined>
  /** Connected service ids (connected image AIs are tried first) */
  connected?: () => Promise<Set<string>>
  /** An image was made with that site (marks it connected) */
  onWorked?: (id: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** How long to wait until the image is drawn */
  waitMs?: number
}

type Result = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}
const ok = (text: string, image?: string): Result => ({
  content: [
    { type: 'text', text },
    ...(image ? [{ type: 'image' as const, data: image, mimeType: 'image/jpeg' }] : []),
  ],
})
const fail = (text: string): Result => ({ isError: true, content: [{ type: 'text', text }] })

const GEMINI = 'https://gemini.google.com/app'
/** Image AI sites: Gemini first, ChatGPT if blocked by the limit or sign-in (both are free web on the user's account) */
export interface ImageSite {
  /** Connect card id (skills/<id>) */
  id: string
  name: string
  url: string
  host: string
  input: RegExp
  download: RegExp
  signedOut: RegExp
  answered: RegExp
  /** Heading to cut the answer text at */
  split: string
  /** Needs sign-in to make pictures even when an input box shows (chat works signed out on this site) */
  mustLogin?: boolean
}
export const IMAGE_SITES: ImageSite[] = [
  {
    id: 'gemini',
    name: GEMINI_NAME,
    url: GEMINI,
    host: 'gemini.google.com',
    input: GEMINI_INPUT,
    download: GEMINI_DOWNLOAD,
    signedOut: SIGNED_OUT,
    answered: GEMINI_ANSWERED,
    split: GEMINI_SPLIT,
  },
  {
    // Not measured yet (the test PC has no ChatGPT login)
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com/',
    host: 'chatgpt.com',
    input: CHATGPT_INPUT,
    download: CHATGPT_DOWNLOAD,
    signedOut: CHATGPT_SIGNED_OUT,
    answered: CHATGPT_ANSWERED,
    split: CHATGPT_SPLIT,
    mustLogin: true,
  },
]

/** Not possible on this site, go to the next one (sign-in, limit) */
class NextSite extends Error {}

interface Snap {
  text: string
  url?: string
}

/** Counts the same marker in the page text */
function count(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length
}

/** Ref of the last marker */
function last(text: string, re: RegExp): string | undefined {
  return [...text.matchAll(re)].at(-1)?.[1]
}

export function imageName(raw: unknown, prompt: string): string {
  const s = (typeof raw === 'string' && raw.trim() ? raw : prompt.slice(0, 30))
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return s || DEFAULT_IMAGE_NAME
}

export class ImageMaker {
  /** Tab and site to continue edits in (where the last one was made) */
  private lastTab?: number
  private lastSite?: ImageSite
  private busy = false

  constructor(private readonly d: ImageMakeDeps) {}

  private sleep(ms: number) {
    return (this.d.sleep ?? ((t) => new Promise<void>((r) => setTimeout(r, t))))(ms)
  }

  private now() {
    return (this.d.now ?? Date.now)()
  }

  private async snap(tabId: number): Promise<Snap> {
    return (await this.d.browser.call('snapshot', { tabId, maxChars: 30_000 })) as Snap
  }

  async make(args: Record<string, unknown>): Promise<Result> {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (!prompt)
      return fail(
        'Describe the picture in detail in prompt (scene, mood, style, aspect ratio, text to include).',
      )
    if (prompt.length > 3000) return fail('prompt can be up to 3,000 characters.')
    if (this.busy) return fail('Another picture is being made. Call again after it finishes.')
    const downloads = this.d.downloadsDir()
    const dir = this.d.saveDir()
    if (!downloads || !dir)
      return fail('Could not find the Downloads or Documents folder, so the picture cannot be saved.')
    this.busy = true
    try {
      // Edits go to the site that just made the picture, new pictures start with Gemini
      const on = (await this.d.connected?.().catch(() => undefined)) ?? new Set<string>()
      const sites =
        args.edit === true && this.lastSite
          ? [this.lastSite]
          : [...IMAGE_SITES.filter((x) => on.has(x.id)), ...IMAGE_SITES.filter((x) => !on.has(x.id))]
      const why: string[] = []
      for (const site of sites) {
        try {
          return await this.run(site, prompt, args, downloads, dir)
        } catch (e) {
          if (!(e instanceof NextSite)) throw e
          why.push(e.message)
        }
      }
      // Never silently draw it ourselves: show a card to connect an image AI, and draw this one by hand (decided 11-23)
      return fail(
        `${why.join(' ')} Show the image AI connect card with connect_ask("gemini") so the user connects once (one button for a Google account), ` +
          'and for this picture draw it in HTML and make a PNG with file_render. Tell the user that once connected, the image AI can remake it much prettier.',
      )
    } finally {
      this.busy = false
    }
  }

  private async run(
    site: ImageSite,
    prompt: string,
    args: Record<string, unknown>,
    downloads: string,
    dir: string,
  ): Promise<Result> {
    const edit = args.edit === true && this.lastTab !== undefined && this.lastSite === site
    let tabId = edit ? this.lastTab : undefined
    if (tabId !== undefined) {
      const alive = await this.snap(tabId).catch(() => undefined)
      if (!alive || !alive.url?.includes(site.host)) tabId = undefined
    }
    if (tabId === undefined) {
      const opened = (await this.d.browser.call('open', { url: site.url }, 40_000)) as { tabId: number }
      tabId = opened.tabId
      await this.sleep(2500)
    }
    // Dismiss the first-run notice and find the input box
    let page = await this.snap(tabId)
    for (let i = 0; i < 5 && !site.input.test(page.text); i++) {
      if (site.signedOut.test(page.text) && !ONBOARD.test(page.text)) break
      const btn = page.text.match(ONBOARD)?.[1]
      if (btn) await this.d.browser.call('click', { tabId, ref: btn }, 20_000).catch(() => undefined)
      await this.sleep(btn ? 1500 : 2000)
      page = await this.snap(tabId)
    }
    if (site.signedOut.test(page.text) && (site.mustLogin || !site.input.test(page.text))) {
      await this.d.browser.call('close', { tabId }, 10_000).catch(() => undefined)
      throw new NextSite(`Not signed in to ${site.name}.`)
    }
    const input = page.text.match(site.input)?.[1]
    if (!input)
      return fail(
        `Could not find the ${site.name} input box. The page may have changed. Draw this one in HTML and make a PNG with file_render.`,
      )
    const before = count(page.text, site.download)
    const answersBefore = count(page.text, site.answered)
    // Prefix so it must make a picture (not just answer in words)
    const ask = edit ? prompt : `Generate an image. ${prompt}`
    await this.d.browser.call('type', { tabId, ref: input, text: ask, submit: true }, 30_000)
    this.lastTab = tabId
    this.lastSite = site

    // Wait for the picture: done once the download button count grows by one and stays the same twice in a row
    const until = this.now() + (this.d.waitMs ?? 150_000)
    let seen = 0
    let textOnly = 0
    let ref: string | undefined
    while (this.now() < until) {
      await this.sleep(4000)
      page = await this.snap(tabId)
      if (LIMIT.test(page.text) && count(page.text, site.download) <= before)
        throw new NextSite(
          `${site.name} free picture quota seems used up (the page shows a limit notice; it works again tomorrow).`,
        )
      const n = count(page.text, site.download)
      if (n > before) {
        seen++
        ref = last(page.text, site.download)
        if (seen >= 2) break
        continue
      }
      // It answered in words only, with no picture (refusal or a question). Words can appear before the picture,
      // so we only count it as a words-only answer after six checks (about 24 s) with no drawing marker and no picture (measured 11-22: judging at once missed pictures)
      if (count(page.text, site.answered) > answersBefore && !DRAWING.test(page.text)) textOnly++
      else textOnly = 0
      if (textOnly >= 6) {
        const said = page.text.split(site.split).at(-1)?.slice(0, 600).trim() ?? ''
        return fail(
          `${site.name} answered in words instead of making a picture: "${said}". Make the request more specific and call again (it may refuse real people or trademarks).`,
        )
      }
    }
    if (!ref)
      return fail(
        'No picture appeared after waiting over 2 minutes. Call once more; if it still fails, draw it in HTML and make a PNG with file_render.',
      )

    // Download the original and move it into the Dool folder
    const clickedAt = this.now()
    const old = new Set(await readdir(downloads).catch(() => [] as string[]))
    await this.d.browser.call('click', { tabId, ref }, 30_000)
    let got: string | undefined
    for (let i = 0; i < 30 && !got; i++) {
      await this.sleep(1000)
      for (const f of await readdir(downloads).catch(() => [] as string[])) {
        if (old.has(f) || !/\.(png|jpe?g|webp)$/i.test(f)) continue
        const s = await stat(join(downloads, f)).catch(() => undefined)
        if (s && s.size > 0 && s.mtimeMs >= clickedAt - 2000) got = f
      }
    }
    if (!got)
      return fail(
        'The picture was made but could not be downloaded. Chrome download settings (ask where to save) may need checking.',
      )
    const ext = extname(got).toLowerCase() || '.png'
    const stem = imageName(args.name, prompt)
    await mkdir(dir, { recursive: true })
    let target = join(dir, `${stem}${ext}`)
    for (let i = 2; existsSync(target) && i < 100; i++) target = join(dir, `${stem} (${i})${ext}`)
    await rename(join(downloads, got), target)
    const data = await readFile(target)
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    const small = await this.d.preview?.(data, mime).catch(() => undefined)
    const shown = this.d.show(target)
    this.d.onMade?.({ name: basename(target), kind: 'png', path: shown, ...(small ? { image: small } : {}) })
    this.d.onWorked?.(site.id)
    if (small) await this.d.keepPhoto?.(small, stem, shown).catch(() => undefined)
    return ok(
      `Made with the image AI (${site.name}), saved to ${shown} and uploaded to the library too. Look at the picture below yourself and check that it matches the request (the text is exact, nothing is missing or odd). ` +
        'If something needs fixing, fix the same picture with image_make(edit: true, prompt: "only what to change"). If it is right, tell the user while showing the picture.',
      small,
    )
  }
}
