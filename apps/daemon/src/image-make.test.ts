import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ImageMaker, imageName } from './image-make.js'

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

const DL = '[e58 버튼 "원본 크기 이미지 다운로드"]'

/** 화면 차례를 미리 정해 둔 가짜 브라우저. 다운로드 버튼을 누르면 다운로드 폴더에 파일이 생긴다 */
function fake(screens: string[], downloads: string) {
  const calls: { command: string; args: Record<string, unknown> }[] = []
  let i = 0
  return {
    calls,
    browser: {
      async call(command: string, args: Record<string, unknown>) {
        calls.push({ command, args })
        if (command === 'open') return { tabId: 7 }
        if (command === 'snapshot')
          return { text: screens[Math.min(i++, screens.length - 1)], url: 'https://gemini.google.com/app/1' }
        if (command === 'click' && args.ref === 'e58')
          await writeFile(join(downloads, 'Gemini_Generated_Image_x.png'), 'png')
        return {}
      },
    },
  }
}

async function setup(screens: string[]) {
  dir = await mkdtemp(join(tmpdir(), 'dool2-img-'))
  const downloads = join(dir, 'dl')
  const docs = join(dir, 'docs')
  await (await import('node:fs/promises')).mkdir(downloads)
  const f = fake(screens, downloads)
  const made: { name: string; path: string }[] = []
  const maker = new ImageMaker({
    browser: f.browser,
    downloadsDir: () => downloads,
    saveDir: () => docs,
    show: (p) => p,
    onMade: (m) => made.push(m),
    preview: async () => 'SMALL',
    sleep: async () => {},
  })
  return { maker, f, made, docs }
}

describe('그림 만들기 (제미나이 웹)', () => {
  it('첫 사용 안내를 넘기고 부탁을 넣은 뒤, 그림을 내려받아 두리 폴더·보관함에 넣는다', async () => {
    const input = '[e35 입력칸 "Gemini 프롬프트 입력"]'
    const { maker, f, made, docs } = await setup([
      '[e3 버튼 "시작하기"]',
      `# 무엇을 도와드릴까요?\n${input}`,
      `${input}\n이미지를 만들고 있습니다`,
      `${input}\n${DL}`,
      `${input}\n${DL}`,
    ])
    const r = await maker.make({ prompt: '공룡 초대장, 글자 "김공룡"', name: '김공룡 초대장' })
    expect(r.isError).toBeUndefined()
    expect(f.calls.find((c) => c.command === 'click')?.args.ref).toBe('e3')
    expect(f.calls.find((c) => c.command === 'type')?.args).toMatchObject({ ref: 'e35', submit: true })
    expect(existsSync(join(docs, '김공룡 초대장.png'))).toBe(true)
    expect(made[0]?.name).toBe('김공룡 초대장.png')
    // 두리가 직접 보고 확인하게 그림이 같이 간다
    expect(r.content.some((c) => c.type === 'image')).toBe(true)
  })

  it('무료 횟수를 다 썼으면 직접 그리기로 넘어가라고 알린다', async () => {
    const input = '[e35 입력칸 "Gemini 프롬프트 입력"]'
    const { maker } = await setup([input, `${input}\n오늘 이미지 생성 한도에 도달했습니다`])
    const r = await maker.make({ prompt: '공룡' })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.content)).toContain('file_render')
  })

  it('로그인이 안 돼 있으면 알린다', async () => {
    const { maker } = await setup(['[e1 링크 "로그인"]\nGemini'])
    const r = await maker.make({ prompt: '공룡' })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.content)).toContain('로그인')
  })

  it('파일 이름은 이름을 쓰고, 없으면 부탁 앞부분', () => {
    expect(imageName('김공룡 초대장.png', 'x')).toBe('김공룡 초대장')
    const long = '귀여운 공룡이 풍선을 든 생일 초대장 그림을 파스텔 수채화로 만들어 줘'
    expect(imageName(undefined, long)).toBe(long.slice(0, 30).trim())
  })
})
