// AI video clip (video_clip): makes a short video (5-8 s) with Google Flow (flow.google.com, free daily credits)
// in the user's signed-in Chrome and downloads it. A clip is raw material: video_motion adds the title, date,
// real photos and transitions to finish it
// (11-23 user: "use the video model if possible, otherwise the motion kit". Measured: Omni 1.2 Flash 720p portrait 8 s = 24 credits, 50 free per day).
// Never upload photos of people: Flow stores uploads and results and humans may review them (notice) -> only scenes asked for in text.

import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { type ImageBrowser, imageName } from './image-make.js'
import {
  AGENT_ON,
  ANY_LINK,
  CHANGELOG_NEXT,
  CONSENT,
  CONTINUE,
  COOKIE_LATER,
  CREDITS,
  DOWNLOAD,
  GO,
  INPUT,
  LIMIT,
  NEW_PROJECT,
  NEXT,
  NEXT_SHORT,
  OPEN_PROJECT,
  ORIGINAL,
  PROGRESS,
  RADIO_VIDEO,
  REFUSED,
  radio,
  SETTINGS,
  SIGNED_OUT,
  START_ENABLED,
  THUMB,
  THUMB_ALT_SELECTOR,
} from './region/kr/flow-ui.js'
import { DEFAULT_CLIP_NAME } from './region/kr/image-ui.js'

export interface VideoClipDeps {
  browser: ImageBrowser
  downloadsDir: () => string | undefined
  saveDir: () => string | undefined
  show: (p: string) => string
  onMade?: (f: { name: string; kind: 'mp4'; path: string; image?: string }) => void
  /** One frame per second as a contact sheet (JPEG base64) plus a poster of the first frame, via the video part (ffmpeg) */
  frames?: (mp4: string) => Promise<{ sheet?: string; poster?: string; seconds?: number; size?: string }>
  onWorked?: (id: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** How long to wait until the clip is done */
  waitMs?: number
}

type Result = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}
const fail = (text: string): Result => ({ isError: true, content: [{ type: 'text', text }] })

export const FLOW_URL = 'https://flow.google.com/'
const ref = (re: RegExp, text: string) => text.match(re)?.[1]

const SHAPES = { portrait: '9:16', landscape: '16:9', square: '1:1' } as const

const count = (text: string, re: RegExp) => [...text.matchAll(re)].length

export class VideoClipMaker {
  private busy = false
  constructor(private readonly d: VideoClipDeps) {}

  private sleep(ms: number) {
    return (this.d.sleep ?? ((t) => new Promise<void>((r) => setTimeout(r, t))))(ms)
  }
  private now() {
    return (this.d.now ?? Date.now)()
  }
  private async snap(tabId: number): Promise<string> {
    return ((await this.d.browser.call('snapshot', { tabId, maxChars: 30_000 })) as { text: string }).text
  }
  private click(tabId: number, r: string) {
    return this.d.browser.call('click', { tabId, ref: r }, 20_000)
  }

  async make(args: Record<string, unknown>): Promise<Result> {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    const resume = args.resume === true
    if (!prompt && !resume)
      return fail(
        'Describe the scene in prompt (subject, motion, background, mood, camera; no text in the picture).',
      )
    if (prompt.length > 2000) return fail('prompt can be up to 2,000 characters.')
    if (this.busy) return fail('Another clip is being made. Call again after it finishes.')
    const downloads = this.d.downloadsDir()
    const dir = this.d.saveDir()
    if (!downloads || !dir)
      return fail('Could not find the Downloads or Documents folder, so the clip cannot be saved.')
    this.busy = true
    let tabId: number | undefined
    try {
      tabId = ((await this.d.browser.call('open', { url: FLOW_URL }, 40_000)) as { tabId: number }).tabId
      await this.sleep(3000)
      return resume
        ? await this.pickUp(tabId, prompt, args, downloads, dir)
        : await this.run(tabId, prompt, args, downloads, dir)
    } catch (e) {
      return fail(
        `Could not make the AI video clip: ${(e as Error).message}. Make this one with video_motion only.`,
      )
    } finally {
      this.busy = false
      if (tabId !== undefined) await this.d.browser.call('close', { tabId }, 10_000).catch(() => undefined)
    }
  }

  private async run(
    tabId: number,
    prompt: string,
    args: Record<string, unknown>,
    downloads: string,
    dir: string,
  ): Promise<Result> {
    let page = await this.snap(tabId)
    // First use of the account: Google's notice (uploads and results are stored, humans may review) needs consent -> only after the user approves
    if (CONSENT.test(page)) {
      if (args.agree !== true)
        return fail(
          'This account is using Google Flow for the first time and must accept Google\'s notice once: "Prompts you enter in Flow and the videos you make are saved to your Google account, and people may review some of them to improve quality (you can turn this off in settings)". ' +
            'Show this to the user with browser_request_approval; once approved, call video_clip again with agree: true. If declined, make it with video_motion only.',
        )
      for (let i = 0; i < 8 && CONSENT.test(page); i++) {
        const cont = ref(CONTINUE, page)
        const next = ref(NEXT, page)
        if (cont) await this.click(tabId, cont)
        else if (next) await this.click(tabId, next)
        else {
          // The notice must be scrolled to the end before Continue turns on: scroll at the last link inside it
          const links = [...page.matchAll(ANY_LINK)]
          const inside = links.at(-1)?.[1]
          await this.d.browser
            .call('scroll', { tabId, direction: 'down', ...(inside ? { ref: inside } : {}) }, 10_000)
            .catch(() => undefined)
        }
        await this.sleep(1500)
        page = await this.snap(tabId)
      }
    }
    if (SIGNED_OUT.test(page) && !NEW_PROJECT.test(page))
      return fail(
        'Not signed in to Google Flow. Show the connect card with connect_ask("flow") (one button for a Google account), and make this one with video_motion only.',
      )
    const later = ref(COOKIE_LATER, page)
    if (later) await this.click(tabId, later).catch(() => undefined)
    const np = ref(NEW_PROJECT, page)
    if (!np)
      return fail('Could not find the New project button on the Flow start page (the page may have changed).')
    await this.click(tabId, np)
    await this.sleep(3500)
    // Dismiss the "what changed" dialog, then turn the agent off (the direct create box)
    for (let i = 0; i < 6; i++) {
      page = await this.snap(tabId)
      const start = page.match(START_ENABLED)
      if (start && !start[2]) await this.click(tabId, start[1] as string)
      else if (start) {
        const nx = ref(CHANGELOG_NEXT, page)
        if (nx) await this.click(tabId, nx)
      } else {
        const agent = ref(AGENT_ON, page)
        if (agent) await this.click(tabId, agent)
        else if (INPUT.test(page)) break
      }
      await this.sleep(1500)
    }
    page = await this.snap(tabId)
    const settings = ref(SETTINGS, page)
    if (!INPUT.test(page) || !settings)
      return fail('Could not find the Flow create box (the page may have changed).')
    await this.click(tabId, settings)
    await this.sleep(1000)
    const shape = args.shape === 'landscape' || args.shape === 'square' ? args.shape : 'portrait'
    const want = [
      radio(RADIO_VIDEO),
      radio(`crop_[a-z0-9_]+ ${SHAPES[shape]}`),
      radio('x1'),
      radio(args.draft === true ? '360p(?: info)?' : '720p'),
    ]
    for (const re of want) {
      page = await this.snap(tabId)
      const m = page.match(re)
      if (m && !m[2]) {
        await this.click(tabId, m[1] as string)
        await this.sleep(700)
      }
    }
    page = await this.snap(tabId)
    const credits = Number(page.match(CREDITS)?.[1] ?? 0)
    const input = ref(INPUT, page)
    if (!input) return fail('Could not find the Flow prompt box.')
    await this.d.browser.call('type', { tabId, ref: input, text: prompt }, 30_000)
    await this.sleep(800)
    page = await this.snap(tabId)
    const go = ref(GO, page)
    if (!go) return fail('The Flow generate button is disabled (credits may be short or the prompt empty).')
    const before = count(page, THUMB)
    await this.click(tabId, go)

    // Wait until done (usually 1-3 min): finished once the thumbnail count grows and stays the same twice in a row
    const until = this.now() + (this.d.waitMs ?? 6 * 60_000)
    let seen = 0
    while (this.now() < until) {
      await this.sleep(8000)
      page = await this.snap(tabId)
      if (count(page, THUMB) > before) {
        if (++seen >= 2) break
        continue
      }
      if (PROGRESS.test(page)) continue
      // Ignore the prompt text (shown again on the page) and the next-generation warning
      const rest = page.replace(NEXT_SHORT, '').split(prompt).join('')
      if (LIMIT.test(rest))
        return fail(
          `Google Flow free credits seem to be used up (50 per day, this clip ${credits || '?'}). It works again tomorrow; make this one with video_motion only.`,
        )
      const said = rest.split('\n').find((l) => REFUSED.test(l) && l.length < 300)
      if (said)
        return fail(
          `Google Flow did not make a video for this prompt: "${said.trim()}". Remove people and trademarks, change the scene and call again.`,
        )
    }
    if (seen === 0)
      return fail(
        'The clip was not finished after waiting over 6 minutes. Flow may still be making it, so a little later fetch it without spending credits again using video_clip(resume: true, same name).',
      )
    return this.download(tabId, prompt, args, downloads, dir, credits)
  }

  /** Fetches the last clip of the last project (when waiting timed out; does not spend credits again) */
  private async pickUp(
    tabId: number,
    prompt: string,
    args: Record<string, unknown>,
    downloads: string,
    dir: string,
  ): Promise<Result> {
    const open = ref(OPEN_PROJECT, await this.snap(tabId))
    if (!open) return fail('Flow has no project to fetch from.')
    await this.click(tabId, open)
    for (let i = 0; i < 20; i++) {
      await this.sleep(3000)
      const page = await this.snap(tabId)
      if (count(page, THUMB) > 0 && !PROGRESS.test(page))
        return this.download(tabId, prompt, args, downloads, dir, 0)
      if (!PROGRESS.test(page) && i > 4) break
    }
    return fail(
      'The last Flow project has no finished clip yet. Fetch again a little later, or make it with video_motion only.',
    )
  }

  private async download(
    tabId: number,
    prompt: string,
    args: Record<string, unknown>,
    downloads: string,
    dir: string,
    credits: number,
  ): Promise<Result> {
    // Open the clip and download the original (720p). List tiles have no ref to press, so tap by position
    const tiles = (await this.d.browser.call(
      'extract',
      {
        tabId,
        spec: { items: THUMB_ALT_SELECTOR, fields: { at: { attr: '@center' } }, limit: 5 },
      },
      20_000,
    )) as { ok: boolean; rows?: { at?: string | null }[] }
    const at = tiles.rows?.[0]?.at?.split(',').map(Number)
    if (!at || at.length !== 2) return fail('Could not open the clip (tile position not found).')
    await this.d.browser.call('input', { tabId, action: 'tap', x: at[0], y: at[1] }, 20_000)
    let dl: string | undefined
    for (let i = 0; i < 10 && !dl; i++) {
      await this.sleep(1500)
      dl = ref(DOWNLOAD, await this.snap(tabId))
    }
    if (!dl) return fail('Could not find the download button on the clip page.')
    await this.click(tabId, dl)
    await this.sleep(1200)
    const orig = ref(ORIGINAL, await this.snap(tabId))
    if (!orig) return fail('Could not find the original size in the download menu.')
    const clickedAt = this.now()
    const old = new Set(await readdir(downloads).catch(() => [] as string[]))
    await this.click(tabId, orig)
    let got: string | undefined
    for (let i = 0; i < 60 && !got; i++) {
      await this.sleep(1000)
      for (const f of await readdir(downloads).catch(() => [] as string[])) {
        if (old.has(f) || !/\.mp4$/i.test(f)) continue
        const s = await stat(join(downloads, f)).catch(() => undefined)
        if (s && s.size > 0 && s.mtimeMs >= clickedAt - 2000) got = f
      }
    }
    if (!got)
      return fail(
        'The clip was made but could not be downloaded. Chrome download settings (ask where to save) may need checking.',
      )
    const stem = imageName(args.name, prompt || DEFAULT_CLIP_NAME)
    await mkdir(dir, { recursive: true })
    let target = join(dir, `${stem}.mp4`)
    for (let i = 2; existsSync(target) && i < 100; i++) target = join(dir, `${stem} (${i}).mp4`)
    await rename(join(downloads, got), target)
    const f = (await this.d.frames?.(target).catch(() => undefined)) ?? {}
    const shown = this.d.show(target)
    this.d.onMade?.({
      name: basename(target),
      kind: 'mp4',
      path: shown,
      ...(f.poster ? { image: f.poster } : {}),
    })
    this.d.onWorked?.('flow')
    const url = `file://${target
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/')}`
    return {
      content: [
        {
          type: 'text',
          text:
            `Made an AI video clip (Google Flow${f.seconds ? `, ${Math.round(f.seconds)} s` : ''}${f.size ? `, ${f.size}` : ''}) and saved it to ${shown}` +
            `${credits ? ` (${credits} credits used, 50 free per day)` : ''}. Below is one frame per second. Check that it matches the request; if it looks wrong, fix the prompt and make it once more. ` +
            `For a finished video, lay this clip under a video_motion scene as <video class="bg" src="${url}"> and add the title, date, photos and transitions (the clip's sound is dropped). If only the clip was wanted, tell the user as is.`,
        },
        ...(f.sheet ? [{ type: 'image' as const, data: f.sheet, mimeType: 'image/jpeg' }] : []),
      ],
    }
  }
}
