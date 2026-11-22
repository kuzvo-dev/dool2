// 그림 만들기 (image_make): 사용자 크롬에 로그인된 제미나이 웹에서 그림 AI로 그림을 만들어 내려받는다.
// 두리가 SVG 도형을 손으로 그리던 초대장·포스터·카드가 클립아트 수준이라(11-22 사용자 지적),
// 무료로 쓸 수 있는 사용자 계정의 그림 AI를 브라우저로 쓴다. 한글 글자도 그림 안에 넣을 수 있다.
// 같은 대화에서 "글자 크게" 같은 고치기는 같은 제미나이 채팅에 이어 부탁한다(edit).

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

export interface ImageBrowser {
  call(command: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

export interface ImageMakeDeps {
  browser: ImageBrowser
  /** 브라우저가 내려받는 폴더 (~/Downloads) */
  downloadsDir: () => string | undefined
  /** 만든 그림을 둘 폴더 (~/Documents/두리) */
  saveDir: () => string | undefined
  /** 사용자에게 보여 줄 경로 모양 */
  show: (p: string) => string
  /** 보관함·폰에 올리기 (image: JPEG base64 미리보기) */
  onMade?: (f: { name: string; kind: 'png'; path: string; image?: string }) => void
  /** 대화에 보일 그림을 남긴다 (미리보기 JPEG base64 → photos/의 파일 이름) */
  keepPhoto?: (jpeg: string, title: string, path: string) => Promise<void>
  /** PNG를 작은 JPEG(base64)로: 보관함 미리보기와 두리가 직접 보고 확인할 그림 */
  preview?: (png: Buffer, mime: string) => Promise<string | undefined>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** 다 그려질 때까지 기다리는 시간 */
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
const DOWNLOAD = /\[(e\d+) 버튼 "원본 크기 이미지 다운로드"\]/g
const INPUT = /\[(e\d+) 입력칸 "[^"]*(?:프롬프트|prompt|Gemini에게)[^"]*"\]/i
/** 첫 사용 안내 창: 건너뛰기·닫기·시작하기 */
const ONBOARD = /\[(e\d+) 버튼 "(?:건너뛰기|나중에|닫기|시작하기|확인|Skip|Not now|Got it)"\]/
const SIGNED_OUT = /\[(e\d+) (?:링크|버튼) "(?:로그인|Sign in)"\]/
const LIMIT = /한도에 도달|한도를 초과|사용량 한도|내일 다시|다시 시도할 수 있|limit reached|quota/i
const DRAWING = /만들고 있습니다|생성하고 있|생성 중|그리는 중|Creating|Generating/i
const ANSWERED = /\[(e\d+) 버튼 "대답이 마음에 들어요"\]/g

interface Snap {
  text: string
  url?: string
}

/** 화면 글에서 같은 표시를 센다 */
function count(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length
}

/** 마지막 표시 번호 */
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
  return s || '두리 그림'
}

export class ImageMaker {
  /** 고치기를 이어 할 제미나이 탭 (마지막에 만든 곳) */
  private lastTab?: number
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
      return fail('어떤 그림을 만들지 prompt에 자세히 써 주세요 (장면·분위기·그림체·비율·넣을 글자).')
    if (prompt.length > 3000) return fail('prompt는 3,000자까지예요.')
    if (this.busy) return fail('다른 그림을 만드는 중이에요. 끝난 뒤에 다시 불러 주세요.')
    const downloads = this.d.downloadsDir()
    const dir = this.d.saveDir()
    if (!downloads || !dir) return fail('다운로드·문서 폴더를 찾지 못해서 그림을 받을 수 없어요.')
    this.busy = true
    try {
      return await this.run(prompt, args, downloads, dir)
    } finally {
      this.busy = false
    }
  }

  private async run(
    prompt: string,
    args: Record<string, unknown>,
    downloads: string,
    dir: string,
  ): Promise<Result> {
    const edit = args.edit === true && this.lastTab !== undefined
    let tabId = edit ? this.lastTab : undefined
    if (tabId !== undefined) {
      const alive = await this.snap(tabId).catch(() => undefined)
      if (!alive || !alive.url?.includes('gemini.google.com')) tabId = undefined
    }
    if (tabId === undefined) {
      const opened = (await this.d.browser.call('open', { url: GEMINI }, 40_000)) as { tabId: number }
      tabId = opened.tabId
      await this.sleep(2500)
    }
    // 첫 사용 안내를 넘기고 입력칸을 찾는다
    let page = await this.snap(tabId)
    for (let i = 0; i < 5 && !INPUT.test(page.text); i++) {
      if (SIGNED_OUT.test(page.text) && !ONBOARD.test(page.text))
        return fail(
          '제미나이에 구글 로그인이 안 돼 있어요. 사용자 크롬에서 gemini.google.com에 구글 계정으로 로그인돼 있어야 그림을 만들 수 있어요. 로그인 카드(구글)를 띄우거나, 이번에는 HTML로 그려 file_render로 PNG를 만들어요.',
        )
      const btn = page.text.match(ONBOARD)?.[1]
      if (btn) await this.d.browser.call('click', { tabId, ref: btn }, 20_000).catch(() => undefined)
      await this.sleep(btn ? 1500 : 2000)
      page = await this.snap(tabId)
    }
    const input = page.text.match(INPUT)?.[1]
    if (!input)
      return fail(
        '제미나이 입력칸을 찾지 못했어요. 화면이 바뀌었을 수 있어요. 이번에는 HTML로 그려 file_render로 PNG를 만들어요.',
      )
    const before = count(page.text, DOWNLOAD)
    const answersBefore = count(page.text, ANSWERED)
    // 그림을 꼭 만들게 앞에 붙인다 (그냥 말로 답하지 않게)
    const ask = edit ? prompt : `이미지를 생성해 줘. ${prompt}`
    await this.d.browser.call('type', { tabId, ref: input, text: ask, submit: true }, 30_000)
    this.lastTab = tabId

    // 그림이 나올 때까지 기다린다: 다운로드 버튼이 하나 늘고, 두 번 연속 그대로면 다 그린 것
    const until = this.now() + (this.d.waitMs ?? 150_000)
    let seen = 0
    let textOnly = 0
    let ref: string | undefined
    while (this.now() < until) {
      await this.sleep(4000)
      page = await this.snap(tabId)
      if (LIMIT.test(page.text) && count(page.text, DOWNLOAD) <= before)
        return fail(
          '제미나이 무료 그림 횟수를 다 쓴 것 같아요(화면에 한도 안내). 이번에는 HTML로 그려 file_render로 PNG를 만들고, 내일 다시 그림 AI로 만들 수 있다고 알려 줘요.',
        )
      const n = count(page.text, DOWNLOAD)
      if (n > before) {
        seen++
        ref = last(page.text, DOWNLOAD)
        if (seen >= 2) break
        continue
      }
      // 그림 없이 말로만 답하고 끝났다 (거절·되물음). 그림보다 말이 먼저 뜨기도 해서,
      // 그리는 중 표시가 없고 그림 없는 답이 여섯 번(약 24초) 이어질 때만 말로 답했다고 본다 (실측 11-22: 바로 판정해 놓쳤다)
      if (count(page.text, ANSWERED) > answersBefore && !DRAWING.test(page.text)) textOnly++
      else textOnly = 0
      if (textOnly >= 6) {
        const said = page.text.split('Gemini의 응답').at(-1)?.slice(0, 600).trim() ?? ''
        return fail(
          `제미나이가 그림 대신 말로 답했어요: "${said}". 부탁을 더 구체적으로 바꿔 다시 불러요(실제 사람·상표가 들어가면 거절될 수 있어요).`,
        )
      }
    }
    if (!ref)
      return fail(
        '2분 넘게 기다려도 그림이 나오지 않았어요. 한 번 더 불러 보고, 또 안 되면 HTML로 그려 file_render로 PNG를 만들어요.',
      )

    // 원본을 내려받아 두리 폴더로 옮긴다
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
        '그림은 만들었는데 내려받지 못했어요. 크롬의 다운로드 설정(저장 위치 묻기)을 확인해야 할 수 있어요.',
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
    if (small) await this.d.keepPhoto?.(small, stem, shown).catch(() => undefined)
    return ok(
      `그림 AI(제미나이)로 만들어 ${shown}에 두고 보관함에도 올렸어요. 아래 그림을 직접 보고 부탁과 맞는지(넣은 글자가 정확한지, 빠진 것·이상한 곳이 없는지) 확인해요. ` +
        '고칠 곳이 있으면 image_make(edit: true, prompt: "고칠 점만")로 같은 그림을 고쳐요. 맞으면 사용자에게 그림을 보여 주며 알려요.',
      small,
    )
  }
}
