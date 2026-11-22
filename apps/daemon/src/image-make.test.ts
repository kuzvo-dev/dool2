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
    const { maker } = await setup(['[e1 링크 "로그인"] [e2 버튼 "무료로 회원가입"]\nGemini'])
    const r = await maker.make({ prompt: '공룡' })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.content)).toContain('로그인')
    // 조용히 직접 그리지 않고 연결 카드를 띄우게 한다
    expect(JSON.stringify(r.content)).toContain('connect_ask')
  })

  it('제미나이에 로그인이 안 돼 있으면 ChatGPT로 만든다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dool2-img-'))
    const downloads = join(dir, 'dl')
    await (await import('node:fs/promises')).mkdir(downloads)
    const seen: Record<number, number> = {}
    const screens: Record<number, string[]> = {
      7: ['[e1 링크 "로그인"]\nGemini'],
      8: [
        '[e14 입력칸 "ChatGPT와 채팅"]',
        '[e14 입력칸 "ChatGPT와 채팅"]\n이미지 생성 중',
        '[e14 입력칸 "ChatGPT와 채팅"]\n[e40 버튼 "이 이미지 다운로드"]',
      ],
    }
    let next = 7
    const worked: string[] = []
    const calls: { command: string; args: Record<string, unknown> }[] = []
    const maker = new ImageMaker({
      browser: {
        async call(command: string, args: Record<string, unknown>) {
          calls.push({ command, args })
          if (command === 'open') return { tabId: next++ }
          if (command === 'snapshot') {
            const t = Number(args.tabId)
            const list = screens[t] ?? ['']
            const i = seen[t] ?? 0
            seen[t] = i + 1
            return {
              text: list[Math.min(i, list.length - 1)],
              url: t === 7 ? 'https://gemini.google.com/app' : 'https://chatgpt.com/',
            }
          }
          if (command === 'click' && args.ref === 'e40')
            await writeFile(join(downloads, 'ChatGPT Image.png'), 'png')
          return {}
        },
      },
      downloadsDir: () => downloads,
      saveDir: () => join(dir as string, 'docs'),
      show: (p) => p,
      sleep: async () => {},
      onWorked: (id) => worked.push(id),
    })
    const r = await maker.make({ prompt: '공룡', name: '공룡' })
    expect(r.isError).toBeUndefined()
    expect(JSON.stringify(r.content)).toContain('ChatGPT')
    expect(worked).toEqual(['chatgpt'])
    expect(calls.find((c) => c.command === 'type')?.args.ref).toBe('e14')
  })

  it('연결된 그림 AI부터 연다', async () => {
    const opened: string[] = []
    const maker = new ImageMaker({
      browser: {
        async call(command: string, args: Record<string, unknown>) {
          if (command === 'open') {
            opened.push(String(args.url))
            return { tabId: 1 }
          }
          if (command === 'snapshot')
            return { text: '[e1 버튼 "무료로 회원가입"] [e2 링크 "로그인"]', url: String(opened.at(-1)) }
          return {}
        },
      },
      downloadsDir: () => tmpdir(),
      saveDir: () => tmpdir(),
      show: (p) => p,
      sleep: async () => {},
      connected: async () => new Set(['chatgpt']),
    })
    await maker.make({ prompt: '공룡' })
    expect(opened[0]).toContain('chatgpt.com')
    expect(opened[1]).toContain('gemini.google.com')
  })

  it('파일 이름은 이름을 쓰고, 없으면 부탁 앞부분', () => {
    expect(imageName('김공룡 초대장.png', 'x')).toBe('김공룡 초대장')
    const long = '귀여운 공룡이 풍선을 든 생일 초대장 그림을 파스텔 수채화로 만들어 줘'
    expect(imageName(undefined, long)).toBe(long.slice(0, 30).trim())
  })
})
