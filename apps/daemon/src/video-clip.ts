// AI 영상 클립 (video_clip): 사용자 크롬에 로그인된 구글 Flow(flow.google.com, 하루 무료 크레딧)로
// 짧은 영상(5~8초)을 만들어 내려받는다. 클립은 재료다 — 제목·날짜·실제 사진·전환은 video_motion이 얹어 완성한다
// (11-23 사용자: "영상 모델 쓸 수 있으면 쓰고 안 되면 모션 키트". 실측: Omni 1.2 Flash 720p 세로 8초 = 24크레딧, 무료 하루 50).
// 사람 사진을 올리지 않는다: Flow는 올린 것·결과를 저장하고 사람이 검토할 수 있다(안내문) → 글로 부탁한 장면만.

import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { type ImageBrowser, imageName } from './image-make.js'

export interface VideoClipDeps {
  browser: ImageBrowser
  downloadsDir: () => string | undefined
  saveDir: () => string | undefined
  show: (p: string) => string
  onMade?: (f: { name: string; kind: 'mp4'; path: string; image?: string }) => void
  /** 클립에서 1초마다 한 컷 모음(JPEG base64)과 첫 컷 미리보기 — 영상 부품(ffmpeg)으로 */
  frames?: (mp4: string) => Promise<{ sheet?: string; poster?: string; seconds?: number; size?: string }>
  onWorked?: (id: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** 다 만들어질 때까지 기다리는 시간 */
  waitMs?: number
}

type Result = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}
const fail = (text: string): Result => ({ isError: true, content: [{ type: 'text', text }] })

export const FLOW_URL = 'https://flow.google.com/'
const ref = (re: RegExp, text: string) => text.match(re)?.[1]
const btn = (label: string) => new RegExp(`\\[(e\\d+) 버튼 "${label}"\\]`)
const radio = (label: string) => new RegExp(`\\[(e\\d+) 라디오 "${label}"( 선택됨)?\\]`)
const NEW_PROJECT = btn('(?:add )?새 프로젝트')
const INPUT = /\[(e\d+) 입력칸 "무엇을 만들고 싶으신가요\?"\]/
const AGENT_ON = /\[(e\d+) 버튼 "Flow 에이전트" 선택됨\]/
const SETTINGS = btn('설정 트리거')
const GO = /\[(e\d+) 버튼 "생성 시작"\]/
const CREDITS = /생성 시 \[e\d+ 링크 "(\d+) 크레딧"\]/
const THUMB = /\[그림 "생성된 동영상 썸네일"\]/g
const DOWNLOAD = btn('미디어 다운로드')
const ORIGINAL = /\[(e\d+) 메뉴 "(?:720p|1080p)? ?원본 크기"\]/
/** 처음 쓸 때: 연구 참여·개인정보 안내 동의 */
const CONSENT = /개인정보처리방침을 검토하세요|마케팅 이메일 수신 동의/
const NEXT = btn('다음')
const CONTINUE = btn('계속')
const COOKIE_LATER = btn('나중에')
/** 변경 안내 창 */
const START = btn('시작하기')
const CHANGELOG_NEXT = btn('Next')
const SIGNED_OUT = /\[(e\d+) (?:링크|버튼) "(?:로그인|Sign in)"\]/
/** 만드는 중 표시 (실측: [e40 버튼 "play_circle 30%"]) */
const PROGRESS = /\[e\d+ 버튼 "[a-z_]* ?\d{1,3}%"\]/
/** 다음 생성에 크레딧이 모자라다는 표시 — 지금 만드는 것과는 상관없다 (11-23: 이걸 한도로 읽어 23초 만에 그만뒀다) */
const NEXT_SHORT = /\[e\d+ 버튼 "크레딧 부족 경고"\]/g
const OPEN_PROJECT = /\[(e\d+) 링크 "프로젝트 열기"\]/
const LIMIT =
  /크레딧이 부족|크레딧을 모두|크레딧이 없|사용량 한도|한도에 도달|나중에 다시 시도|not enough credits|out of credits|quota/i
const REFUSED = /정책|가이드라인|생성할 수 없|생성하지 못|실패했|policy|couldn.t generate|failed/i
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
      return fail('어떤 장면을 만들지 prompt에 써 주세요 (주인공·움직임·배경·분위기·카메라, 글자 없이).')
    if (prompt.length > 2000) return fail('prompt는 2,000자까지예요.')
    if (this.busy) return fail('다른 클립을 만드는 중이에요. 끝난 뒤에 다시 불러 주세요.')
    const downloads = this.d.downloadsDir()
    const dir = this.d.saveDir()
    if (!downloads || !dir) return fail('다운로드·문서 폴더를 찾지 못해서 클립을 받을 수 없어요.')
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
        `AI 영상 클립을 만들지 못했어요: ${(e as Error).message}. 이번에는 video_motion만으로 만들어요.`,
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
    // 처음 쓰는 계정: 구글의 안내(올린 것·결과 저장, 사람 검토)에 동의해야 한다 → 사용자 승인 뒤에만
    if (CONSENT.test(page)) {
      if (args.agree !== true)
        return fail(
          '구글 Flow를 이 계정으로 처음 써요. 처음 한 번 구글의 안내에 동의해야 해요: "Flow에 넣은 부탁과 만든 영상은 구글 계정에 저장되고, 품질을 위해 사람이 일부를 볼 수 있어요(설정에서 끌 수 있어요)". ' +
            'browser_request_approval로 이 내용을 사용자에게 보여 주고 승인받으면 video_clip을 agree: true로 다시 불러요. 거절하면 video_motion만으로 만들어요.',
        )
      for (let i = 0; i < 8 && CONSENT.test(page); i++) {
        const cont = ref(CONTINUE, page)
        const next = ref(NEXT, page)
        if (cont) await this.click(tabId, cont)
        else if (next) await this.click(tabId, next)
        else {
          // 안내를 끝까지 내려야 '계속'이 켜진다: 안내 안 마지막 링크 자리에서 굴린다
          const links = [...page.matchAll(/\[(e\d+) 링크 "[^"]*"\]/g)]
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
        '구글 Flow에 로그인이 안 돼 있어요. connect_ask("flow")로 연결 카드를 띄우고(구글 계정이면 버튼 한 번), 이번에는 video_motion만으로 만들어요.',
      )
    const later = ref(COOKIE_LATER, page)
    if (later) await this.click(tabId, later).catch(() => undefined)
    const np = ref(NEW_PROJECT, page)
    if (!np) return fail('Flow 첫 화면에서 새 프로젝트 버튼을 찾지 못했어요(화면이 바뀌었을 수 있어요).')
    await this.click(tabId, np)
    await this.sleep(3500)
    // 변경 안내 창 넘기기 → 에이전트 끄기 (직접 만들기 칸)
    for (let i = 0; i < 6; i++) {
      page = await this.snap(tabId)
      const start = page.match(/\[(e\d+) 버튼 "시작하기"( 비활성)?\]/)
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
      return fail('Flow 만들기 칸을 찾지 못했어요(화면이 바뀌었을 수 있어요).')
    await this.click(tabId, settings)
    await this.sleep(1000)
    const shape = args.shape === 'landscape' || args.shape === 'square' ? args.shape : 'portrait'
    const want = [
      radio('videocam 동영상'),
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
    if (!input) return fail('Flow 부탁 칸을 찾지 못했어요.')
    await this.d.browser.call('type', { tabId, ref: input, text: prompt }, 30_000)
    await this.sleep(800)
    page = await this.snap(tabId)
    const go = ref(GO, page)
    if (!go) return fail('Flow 생성 버튼이 꺼져 있어요(크레딧이 모자라거나 부탁이 비었을 수 있어요).')
    const before = count(page, THUMB)
    await this.click(tabId, go)

    // 다 만들어질 때까지 (보통 1~3분): 썸네일이 늘고 두 번 연속 그대로면 끝
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
      // 부탁 글(화면에 다시 보인다)과 다음 생성 경고는 빼고 본다
      const rest = page.replace(NEXT_SHORT, '').split(prompt).join('')
      if (LIMIT.test(rest))
        return fail(
          `구글 Flow 무료 크레딧을 다 쓴 것 같아요(하루 50, 이번 클립 ${credits || '?'}). 내일 다시 되고, 이번에는 video_motion만으로 만들어요.`,
        )
      const said = rest.split('\n').find((l) => REFUSED.test(l) && l.length < 300)
      if (said)
        return fail(
          `구글 Flow가 이 부탁으로는 영상을 만들지 않았어요: "${said.trim()}". 사람·상표를 빼고 장면을 바꿔 다시 불러요.`,
        )
    }
    if (seen === 0)
      return fail(
        '6분 넘게 기다려도 클립이 다 만들어지지 않았어요. Flow에서는 계속 만들고 있을 수 있으니 조금 뒤 video_clip(resume: true, name 같게)으로 크레딧을 다시 쓰지 않고 받아 와요.',
      )
    return this.download(tabId, prompt, args, downloads, dir, credits)
  }

  /** 마지막 프로젝트의 마지막 클립을 받아 온다 (기다리다 시간이 다 됐을 때 — 크레딧을 다시 쓰지 않는다) */
  private async pickUp(
    tabId: number,
    prompt: string,
    args: Record<string, unknown>,
    downloads: string,
    dir: string,
  ): Promise<Result> {
    const open = ref(OPEN_PROJECT, await this.snap(tabId))
    if (!open) return fail('Flow에 받아 올 프로젝트가 없어요.')
    await this.click(tabId, open)
    for (let i = 0; i < 20; i++) {
      await this.sleep(3000)
      const page = await this.snap(tabId)
      if (count(page, THUMB) > 0 && !PROGRESS.test(page))
        return this.download(tabId, prompt, args, downloads, dir, 0)
      if (!PROGRESS.test(page) && i > 4) break
    }
    return fail(
      '마지막 Flow 프로젝트에 다 만들어진 클립이 아직 없어요. 조금 더 뒤에 다시 받아 오거나 video_motion만으로 만들어요.',
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
    // 클립을 열어 원본(720p)을 받는다. 목록 타일은 누를 표시가 없어 자리로 누른다
    const tiles = (await this.d.browser.call(
      'extract',
      {
        tabId,
        spec: { items: 'img[alt="생성된 동영상 썸네일"]', fields: { at: { attr: '@center' } }, limit: 5 },
      },
      20_000,
    )) as { ok: boolean; rows?: { at?: string | null }[] }
    const at = tiles.rows?.[0]?.at?.split(',').map(Number)
    if (!at || at.length !== 2) return fail('만든 클립을 열지 못했어요(목록 자리를 못 찾음).')
    await this.d.browser.call('input', { tabId, action: 'tap', x: at[0], y: at[1] }, 20_000)
    let dl: string | undefined
    for (let i = 0; i < 10 && !dl; i++) {
      await this.sleep(1500)
      dl = ref(DOWNLOAD, await this.snap(tabId))
    }
    if (!dl) return fail('클립 화면에서 다운로드 버튼을 찾지 못했어요.')
    await this.click(tabId, dl)
    await this.sleep(1200)
    const orig = ref(ORIGINAL, await this.snap(tabId))
    if (!orig) return fail('다운로드 메뉴에서 원본 크기를 찾지 못했어요.')
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
        '클립은 만들었는데 내려받지 못했어요. 크롬 다운로드 설정(저장 위치 묻기)을 확인해야 할 수 있어요.',
      )
    const stem = imageName(args.name, prompt || 'AI 영상 클립')
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
            `AI 영상 클립(구글 Flow${f.seconds ? `, ${Math.round(f.seconds)}초` : ''}${f.size ? `, ${f.size}` : ''})을 만들어 ${shown}에 뒀어요` +
            `${credits ? ` (크레딧 ${credits} 사용, 무료는 하루 50)` : ''}. 아래는 1초마다 한 컷이에요 — 부탁과 맞는지 보고, 이상하면 prompt를 고쳐 한 번 더 만들어요. ` +
            `완성 영상이면 이 클립을 video_motion 장면에 <video class="bg" src="${url}">로 깔고 제목·날짜·사진·전환을 얹어요(클립 소리는 빠져요). 클립만 원했으면 그대로 알려요.`,
        },
        ...(f.sheet ? [{ type: 'image' as const, data: f.sheet, mimeType: 'image/jpeg' }] : []),
      ],
    }
  }
}
