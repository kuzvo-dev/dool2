import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VideoClipMaker } from './video-clip.js'

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

/** 구글 Flow 화면을 흉내 낸다 (11-23 실측 화면 글 그대로) */
function fakeFlow(downloads: string, opts: { consent?: boolean; limit?: boolean } = {}) {
  const calls: { command: string; args: Record<string, unknown> }[] = []
  let state = opts.consent ? 'consent1' : 'home'
  let polls = 0
  const radios = new Set(['image 이미지', 'crop_16_9 16:9', 'x2', '360p info'])
  const r = (label: string, ref: string) => `[${ref} 라디오 "${label}"${radios.has(label) ? ' 선택됨' : ''}]`
  const screen = (): string => {
    if (state === 'consent1')
      return '[e1 체크박스 "마케팅 이메일 수신 동의"] 마케팅 이메일 수신 동의 [e3 버튼 "로그아웃"] [e4 버튼 "다음"]'
    if (state === 'consent2')
      return '## 개인정보처리방침을 검토하세요\n[e9 링크 "Google Flow 고객센터"] [e10 버튼 "이전"] [e11 버튼 "계속"]'
    if (state === 'home')
      return '[e13 버튼 "동의함"] [e14 버튼 "나중에"]\n[e15 링크 "프로젝트 열기"]\n[e27 버튼 "add 새 프로젝트"]'
    if (state === 'changelog') return '[e34 버튼 "시작하기" 비활성]\n[e20003 버튼 "Next"]'
    if (state === 'changelog2') return '[e34 버튼 "시작하기"]'
    if (state === 'agent')
      return '[e65 입력칸 "목표 설명"] [e68 버튼 "Flow 에이전트" 선택됨] [e69 버튼 "생성 시작" 비활성]'
    const box = `[e70 입력칸 "무엇을 만들고 싶으신가요?"] [e72 버튼 "설정 트리거"] [e73 버튼 "Flow 에이전트"] [e74 버튼 "생성 시작"${state === 'typed' || state === 'settings' ? '' : ' 비활성'}]`
    const settings = `${r('image 이미지', 'e75')} ${r('videocam 동영상', 'e76')} ${r('crop_16_9 16:9', 'e77')} ${r('crop_9_16 9:16', 'e81')} ${r('360p info', 'e96')} ${r('720p', 'e97')} ${r('x1', 'e84')} ${r('x2', 'e85')} 생성 시 [e88 링크 "24 크레딧"] 이 사용됩니다`
    if (state === 'box' || state === 'settings' || state === 'typed')
      return `${box}\n${state === 'box' ? '' : settings}`
    if (state === 'generating') {
      polls++
      if (opts.limit) return `${box}\n크레딧이 부족합니다`
      return polls < 3
        ? `[e40 버튼 "play_circle 42%"]\n${box.replace('[e74 버튼 "생성 시작" 비활성]', '[e46 버튼 "크레딧 부족 경고"]')}`
        : `[그림 "생성된 동영상 썸네일"]\n${box}`
    }
    if (state === 'edit') return '[e107 버튼 "미디어 다운로드"] [e108 버튼 "휴지통으로 이동"]'
    if (state === 'menu')
      return '[e130 메뉴 "270p 애니메이션 GIF"] [e131 메뉴 "720p 원본 크기"] [e132 메뉴 "1080p 업스케일링됨" 비활성]'
    return ''
  }
  const browser = {
    async call(command: string, args: Record<string, unknown>) {
      calls.push({ command, args })
      if (command === 'open') return { tabId: 9 }
      if (command === 'snapshot') return { text: screen() }
      if (command === 'extract') return { ok: true, rows: [{ at: '318,200' }] }
      if (command === 'input') state = 'edit'
      if (command === 'type') state = 'typed'
      if (command === 'click') {
        const ref = String(args.ref)
        if (ref === 'e4') state = 'consent2'
        else if (ref === 'e11') state = 'home'
        else if (ref === 'e27') state = 'changelog'
        else if (ref === 'e15') {
          state = 'generating'
          polls = 5
        } else if (ref === 'e20003') state = 'changelog2'
        else if (ref === 'e34') state = 'agent'
        else if (ref === 'e68') state = 'box'
        else if (ref === 'e72') state = 'settings'
        else if (ref === 'e74') state = 'generating'
        else if (ref === 'e107') state = 'menu'
        else if (ref === 'e131') await writeFile(join(downloads, 'Baby_dinosaur_cdb0945b.mp4'), 'mp4')
        else if (ref.startsWith('e')) {
          const label = /"([^"]+)"/.exec(screen().split(`[${ref} `)[1] ?? '')?.[1]
          if (label === 'videocam 동영상') radios.delete('image 이미지')
          if (label === 'crop_9_16 9:16') radios.delete('crop_16_9 16:9')
          if (label === 'x1') radios.delete('x2')
          if (label === '720p') radios.delete('360p info')
          if (label) radios.add(label)
        }
      }
      return {}
    },
  }
  return { browser, calls }
}

async function setup(opts: { consent?: boolean; limit?: boolean } = {}) {
  dir = await mkdtemp(join(tmpdir(), 'dool2-clip-'))
  const downloads = join(dir, 'dl')
  const docs = join(dir, 'docs')
  await mkdir(downloads)
  const f = fakeFlow(downloads, opts)
  const made: { name: string; image?: string }[] = []
  const worked: string[] = []
  const maker = new VideoClipMaker({
    browser: f.browser,
    downloadsDir: () => downloads,
    saveDir: () => docs,
    show: (p) => p,
    onMade: (m) => made.push(m),
    onWorked: (id) => worked.push(id),
    frames: async () => ({ sheet: 'SHEET', poster: 'POSTER' }),
    sleep: async () => {},
  })
  return { maker, f, made, worked, docs }
}

describe('AI 영상 클립 (구글 Flow)', () => {
  it('새 프로젝트에서 세로·720p·한 개로 만들어 원본을 두리 폴더·보관함에 받고, 컷 모음을 돌려준다', async () => {
    const { maker, f, made, worked, docs } = await setup()
    const r = await maker.make({ prompt: 'A cute baby dinosaur dancing, no text', name: '춤추는 공룡' })
    expect(r.isError).toBeUndefined()
    const clicked = f.calls.filter((c) => c.command === 'click').map((c) => c.args.ref)
    // 쿠키는 나중에, 에이전트는 끄고, 동영상·9:16·x1·720p를 고른다
    expect(clicked).toEqual(
      expect.arrayContaining(['e14', 'e27', 'e68', 'e76', 'e81', 'e84', 'e97', 'e74', 'e107', 'e131']),
    )
    expect(f.calls.find((c) => c.command === 'type')?.args).toMatchObject({ ref: 'e70' })
    expect(f.calls.find((c) => c.command === 'input')?.args).toMatchObject({ action: 'tap', x: 318, y: 200 })
    expect(existsSync(join(docs, '춤추는 공룡.mp4'))).toBe(true)
    expect(made[0]).toMatchObject({ name: '춤추는 공룡.mp4', image: 'POSTER' })
    expect(worked).toEqual(['flow'])
    const text = JSON.stringify(r.content)
    expect(text).toContain('크레딧 24')
    expect(text).toContain('<video class=\\"bg\\"')
    expect(r.content.some((c) => c.type === 'image')).toBe(true)
    // 탭은 닫는다
    expect(f.calls.at(-1)?.command).toBe('close')
  })

  it('처음 쓰는 계정이면 승인 없이는 동의하지 않고 승인을 받으라고 알린다', async () => {
    const { maker, f } = await setup({ consent: true })
    const r = await maker.make({ prompt: 'balloons' })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.content)).toContain('browser_request_approval')
    expect(f.calls.some((c) => c.command === 'click')).toBe(false)
  })

  it('승인(agree)이 있으면 안내를 넘기고 만든다', async () => {
    const { maker, f } = await setup({ consent: true })
    const r = await maker.make({ prompt: 'balloons', agree: true })
    expect(r.isError).toBeUndefined()
    const clicked = f.calls.filter((c) => c.command === 'click').map((c) => c.args.ref)
    expect(clicked.slice(0, 2)).toEqual(['e4', 'e11'])
  })

  it('무료 크레딧을 다 쓰면 모션 영상만으로 만들라고 알린다', async () => {
    const { maker } = await setup({ limit: true })
    const r = await maker.make({ prompt: 'balloons' })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.content)).toContain('video_motion')
  })

  it('기다리다 시간이 다 된 클립은 크레딧을 다시 쓰지 않고 마지막 프로젝트에서 받아 온다 (resume)', async () => {
    const { maker, f, docs } = await setup()
    const r = await maker.make({ resume: true, name: '구름 위 유니콘' })
    expect(r.isError).toBeUndefined()
    const clicked = f.calls.filter((c) => c.command === 'click').map((c) => c.args.ref)
    expect(clicked).toContain('e15')
    expect(clicked).not.toContain('e74')
    expect(existsSync(join(docs, '구름 위 유니콘.mp4'))).toBe(true)
  })
})
