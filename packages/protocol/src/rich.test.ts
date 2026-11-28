import { describe, expect, it } from 'vitest'
import { previewText } from './index.js'
import {
  appNote,
  codeHandLabel,
  inline,
  josa,
  narrationLine,
  readAppNote,
  richBlocks,
  stripLinks,
  stripMonologue,
  toolAct,
  toolPlace,
  withoutPhotoMark,
  workStatus,
} from './rich.js'

describe('richBlocks', () => {
  it('빈 줄로 문단을 나누고 **굵게**를 살린다', () => {
    expect(richBlocks('안녕하세요.\n\n**토요일**은 비가 와요.')).toEqual([
      { type: 'p', lines: [[{ text: '안녕하세요.' }]] },
      {
        type: 'p',
        lines: [[{ text: '토요일', bold: true }, { text: '은 비가 와요.' }]],
      },
    ])
  })

  it('문단 바로 아래 "- " 줄은 목록으로 묶는다', () => {
    expect(richBlocks('알려 주세요.\n- 몇 분\n- 몇 시')).toEqual([
      { type: 'p', lines: [[{ text: '알려 주세요.' }]] },
      { type: 'ul', items: [[{ text: '몇 분' }], [{ text: '몇 시' }]] },
    ])
  })

  it('번호 목록은 시작 번호를 지킨다', () => {
    expect(richBlocks('3. 셋\n4. 넷')).toEqual([
      { type: 'ol', start: 3, items: [[{ text: '셋' }], [{ text: '넷' }]] },
    ])
  })

  it('HTML은 글자 그대로 둔다', () => {
    expect(richBlocks('<b>x</b>')).toEqual([{ type: 'p', lines: [[{ text: '<b>x</b>' }]] }])
  })

  it('쓰는 중인 답(끝이 잘린 **)도 깨지지 않는다', () => {
    expect(richBlocks('**토요')).toEqual([{ type: 'p', lines: [[{ text: '**토요' }]] }])
  })
})

describe('previewText', () => {
  it('마크다운 기호를 빼고 한 줄로 줄인다', () => {
    expect(previewText('**토요일**은 비가 와요.\n\n- 우산\n1. 우비')).toBe('토요일은 비가 와요. 우산 우비')
    expect(previewText('가'.repeat(200), 10)).toBe(`${'가'.repeat(9)}…`)
  })
})

describe('앱 알림', () => {
  it('화면에는 AI에게만 필요한 꼬리말을 빼고 보여 준다', () => {
    const t = appNote('폰에서 승인했어요. "바로 구매"를 눌렀어요. 결과를 확인하고 이어서 해 주세요.')
    expect(readAppNote(t)).toBe('폰에서 승인했어요. "바로 구매"를 눌렀어요.')
    expect(readAppNote('다 했어요. 이어서 해 주세요.')).toBeUndefined()
    expect(
      readAppNote(
        appNote(
          '폰에서 시험 가게 로그인 정보를 두리 금고에 저장했어요. browser_login으로 채우고 로그인한 뒤 하던 일을 이어서 해 주세요.',
        ),
      ),
    ).toBe('폰에서 시험 가게 로그인 정보를 두리 금고에 저장했어요.')
  })
})

describe('narrationLine', () => {
  it('영어 속생각은 버리고 한국어 마지막 문장만', () => {
    expect(
      narrationLine('Focus is on the pin. Three more Tabs to reach the date.날짜를 내일로 맞췄어요.'),
    ).toBe('날짜를 내일로 맞췄어요.')
    expect(narrationLine('SRT 사이트를 열게요. 출발역을 동탄으로 고르는 중이에요.')).toBe(
      '출발역을 동탄으로 고르는 중이에요.',
    )
  })
  it('한국어가 없으면 없음', () => {
    expect(narrationLine('No skill; go to SRT site directly.')).toBeUndefined()
    expect(narrationLine('')).toBeUndefined()
  })
  it('길면 자른다', () => {
    const line = narrationLine('가'.repeat(80))
    expect(line?.length).toBe(60)
    expect(line?.endsWith('…')).toBe(true)
  })
})

describe('josa', () => {
  it('받침에 맞춰 붙인다', () => {
    expect(josa('카카오톡', '을/를')).toBe('카카오톡을')
    expect(josa('메모', '을/를')).toBe('메모를')
    expect(josa('한글', '은/는')).toBe('한글은')
    expect(josa('Notes', '을/를')).toBe('Notes를')
  })
})

describe('readAppNote', () => {
  it('지금 화면 정보와 AI 지시는 화면에서 뺀다', () => {
    expect(
      readAppNote(
        appNote(
          '폰에서 승인했어요. "바로 구매" 버튼을 눌렀어요. 지금 화면: 주문 완료 (http://x/) 결과를 확인하고 이어서 해 주세요.',
        ),
      ),
    ).toBe('폰에서 승인했어요. "바로 구매" 버튼을 눌렀어요.')
  })
  it('AI 지시가 시작되면 뒤는 모두 뺀다 (괄호 속 문장도)', () => {
    expect(
      readAppNote(
        appNote(
          '아시아나항공 자동 로그인이 중간에 멈췄어요. 두리가 화면을 보며 이어서 해 볼게요. browser_read로 탭 1을 읽고(자동 로그인의 판단: 네이버 로그인을 마쳤는지 확인하지 못했어요 — 규칙 판단이라 틀릴 수 있어요. 화면을 직접 보고 정해요) 로그인을 이어서 해 주세요. 이미 있는 계정에 간편 로그인을 연결하라는 화면이면 연결 버튼을 눌러요.',
        ),
      ),
    ).toBe('아시아나항공 자동 로그인이 중간에 멈췄어요. 두리가 화면을 보며 이어서 해 볼게요.')
  })
})

describe('stripMonologue', () => {
  it('한글 없는 속생각 문단은 뺀다', () => {
    expect(stripMonologue('Let me check the SRT site first.\n\n05:47 열차에 자리가 있어요.')).toBe(
      '05:47 열차에 자리가 있어요.',
    )
  })
  it('영어라도 속생각이 아니면 남긴다', () => {
    expect(stripMonologue('Apple Watch Series 11\n\n이 제품이 제일 싸요.')).toBe(
      'Apple Watch Series 11\n\n이 제품이 제일 싸요.',
    )
  })
  it('다 걷어 내면 원래 글', () => {
    expect(stripMonologue('Let me think.')).toBe('Let me think.')
  })
})

describe('withoutPhotoMark', () => {
  it('사진 표시를 (사진)으로, 잘린 것도', () => {
    expect(withoutPhotoMark('합계 알려 줘 [사진: 2026-11-15T17-03-24-937Z.jpg]')).toBe('합계 알려 줘 (사진)')
    expect(withoutPhotoMark('정리해 줘 [사진: 2026-11-15T16-54-57-062Z.j')).toBe('정리해 줘 (사진)')
  })
})

describe('표·제목', () => {
  it('마크다운 표를 머리와 줄로 나눈다 (구분 줄은 뺀다)', () => {
    const b = richBlocks(
      '비교했어요.\n\n|  | 아이닉 | 샤오미 |\n|---|---|---|\n| 가격 | **282,110원** | 132,240원 |\n| 무게 | 2.7kg | 1.5kg |',
    )
    expect(b[0]?.type).toBe('p')
    const t = b[1]
    expect(t?.type).toBe('table')
    if (t?.type !== 'table') return
    expect(t.head?.map((c) => c.map((x) => x.text).join(''))).toEqual(['', '아이닉', '샤오미'])
    expect(t.rows).toHaveLength(2)
    expect(t.rows[0]?.[1]).toEqual([{ text: '282,110원', bold: true }])
  })

  it('문단 바로 아래 붙은 표, 머리 없는 표, 제목', () => {
    const b = richBlocks('## 후보\n세 곳이에요\n| a | b |\n| c | d |')
    expect(b.map((x) => x.type)).toEqual(['h', 'p', 'table'])
    const t = b[2]
    if (t?.type === 'table') expect(t.head).toBeUndefined()
  })
})

describe('toolPlace (일하는 카드를 서비스별로 묶는 기준)', () => {
  it('웹 도구는 연 주소, 주소가 없으면 지금 보는 곳', () => {
    expect(toolPlace('mcp__dool2__browser_open', { url: 'https://search.naver.com/x?q=1' })).toBe(
      'search.naver.com',
    )
    expect(toolPlace('mcp__dool2__browser_click', { ref: 3 }, 'www.sparkplus.co.kr')).toBe(
      'www.sparkplus.co.kr',
    )
    expect(toolPlace('mcp__dool2__browser_read', {})).toBeUndefined()
  })
  it('서비스 도구·PC 앱·파일', () => {
    expect(toolPlace('mcp__dool2__catchtable_search', { keyword: '성수' })).toBe('tool:catchtable_search')
    expect(toolPlace('mcp__dool2__service_call', { tool: 'cj_logistics_track', input: {} })).toBe(
      'tool:cj_logistics_track',
    )
    expect(toolPlace('mcp__dool2__screen_click', {})).toBe('app')
    expect(toolPlace('mcp__dool2__file_write', {})).toBe('file')
  })
  it('두리 안에서 하는 일은 곳이 없다', () => {
    // Task tools are Dool2's own work: no "task" service line on the card (measured: "task에서 일했어요")
    for (const n of ['task_start', 'task_steer', 'task_stop', 'task_list']) {
      expect(toolPlace(`mcp__dool2__${n}`, { title: 'x' })).toBeUndefined()
      expect(toolAct(n)).not.toBe('일하는 중')
      expect(toolAct(n, 'en')).not.toBe('Working')
    }
    expect(toolAct('task_start')).toBe('일 맡기는 중')
    expect(toolPlace('mcp__dool2__memory_save', {})).toBeUndefined()
    expect(toolPlace('mcp__dool2__service_find', { query: '택배' })).toBeUndefined()
    expect(toolPlace('mcp__dool2__show_cards', {})).toBeUndefined()
  })
})

describe('답 속 링크 (출처는 링크로)', () => {
  it('문장 끝 출처 묶음은 괄호·쉼표 없이 칩으로', () => {
    expect(
      inline('늘었어요. ([연합뉴스](https://www.yna.co.kr/a?x=1), [한국경제](https://www.hankyung.com/b))'),
    ).toEqual([
      { text: '늘었어요.' },
      { text: '연합뉴스', href: 'https://www.yna.co.kr/a?x=1', src: true },
      { text: '한국경제', href: 'https://www.hankyung.com/b', src: true },
    ])
  })
  it('글 속 링크·맨 주소·굵게가 섞여도 나눈다 (맨 주소는 사이트 이름만)', () => {
    expect(inline('[공고](https://x.go.kr/a) 보세요 **꼭** https://www.gov.kr/portal/main.')).toEqual([
      { text: '공고', href: 'https://x.go.kr/a' },
      { text: ' 보세요 ' },
      { text: '꼭', bold: true },
      { text: ' ' },
      { text: 'gov.kr', href: 'https://www.gov.kr/portal/main' },
      { text: '.' },
    ])
  })
  it('그냥 괄호와 http 아닌 것은 그대로', () => {
    expect(inline('괄호 (그냥 말) [a](javascript:alert(1))')).toEqual([
      { text: '괄호 (그냥 말) [a](javascript:alert(1))' },
    ])
  })
  it('한 줄 미리 보기는 출처를 빼고 링크는 글만', () => {
    expect(stripLinks('올랐어요. ([MBC](https://imbc.com/a)) 자세한 건 [공고](https://x.go.kr)')).toBe(
      '올랐어요. 자세한 건 공고',
    )
  })
})

describe('영어 속생각 줄 빼기', () => {
  it('한글 답 사이 영어 문장 줄만 빼고, 주소·표·짧은 상품 이름은 남긴다', async () => {
    const { dropEnglishLines } = await import('./rich.js')
    const t =
      'Menu may still be loading now.\n부타동 솥밥을 담았어요.\nGalaxy Buds3 FE\n| 가격 | 9,000원 |\nhttps://example.com/a b c d'
    expect(dropEnglishLines(t)).toBe(
      '부타동 솥밥을 담았어요.\nGalaxy Buds3 FE\n| 가격 | 9,000원 |\nhttps://example.com/a b c d',
    )
  })
})

describe('English meant for the person', () => {
  it('keeps a translation in bold or quotes, drops a thought (11-26: the asked translation went missing)', async () => {
    const { dropEnglishLines } = await import('./rich.js')
    const t =
      '**Could we move the meeting to next week?**\nLet me check the page again now.\n- 격식 있게: "Would you mind if we postponed it?"\n> Can we push the meeting to next week?'
    expect(dropEnglishLines(t)).toBe(
      '**Could we move the meeting to next week?**\n- 격식 있게: "Would you mind if we postponed it?"\n> Can we push the meeting to next week?',
    )
  })
})

describe('답 속 PC 파일 경로', () => {
  it('`경로`는 파일 이름만 보이는 파일 조각으로', () => {
    expect(inline('- **파일:** `~/Documents/두리/하늘이 생일 영상.mp4` (14초, 세로)')).toEqual([
      { text: '- ' },
      { text: '파일:', bold: true },
      { text: ' ' },
      { text: '하늘이 생일 영상.mp4', file: '~/Documents/두리/하늘이 생일 영상.mp4' },
      { text: ' (14초, 세로)' },
    ])
  })
  it('[이름](file:///…)과 [이름](~/…)도 파일로 (주소 글자는 풀어서)', () => {
    expect(inline('[초대장](file:///Users/me/Documents/%EB%91%90%EB%A6%AC/a%20b.png) 보세요')).toEqual([
      { text: '초대장', file: '/Users/me/Documents/두리/a b.png' },
      { text: ' 보세요' },
    ])
    expect(inline('[정산](~/Desktop/11월 정산.xlsx)')).toEqual([
      { text: '정산', file: '~/Desktop/11월 정산.xlsx' },
    ])
    expect(inline('`C:\\Users\\me\\Desktop\\a.pdf`')).toEqual([
      { text: 'a.pdf', file: 'C:\\Users\\me\\Desktop\\a.pdf' },
    ])
  })
  it('확장자 없는 경로·평범한 코드·웹 링크는 그대로', () => {
    expect(inline('`~/Documents/두리`')).toEqual([{ text: '`~/Documents/두리`' }])
    expect(inline('`npm run`')).toEqual([{ text: '`npm run`' }])
    expect(inline('[뉴스](https://a.com/x.html)')).toEqual([{ text: '뉴스', href: 'https://a.com/x.html' }])
  })
  it('한 줄 미리 보기에는 파일 이름만', () => {
    expect(stripLinks('만들었어요: `~/Documents/두리/초대장.png`')).toBe('만들었어요: 초대장.png')
  })
})

describe('codeHandLabel', () => {
  it('names a page open and masks the URL to its host (no path/query/token)', () => {
    const r = codeHandLabel('await page.goto("https://www.catchtable.co.kr/book?token=SECRET123")')
    expect(r.label).toBe('웹페이지 여는')
    expect(r.host).toBe('www.catchtable.co.kr')
    // toolAct-style rendering the app does: "<stem> 중"
    expect(`${r.label} 중`).toBe('웹페이지 여는 중')
  })
  it('shows the headline action: a snapshot-then-click reads as a click', () => {
    expect(codeHandLabel('await page.snapshot(); await page.click("e2")').label).toBe('버튼 누르는')
  })
  it('a bare snapshot reads the screen; a fetch gets data with its host', () => {
    expect(codeHandLabel('JSON.stringify(await page.snapshot())').label).toBe('화면 읽는')
    const f = codeHandLabel('await page.fetch("https://api.example.com/v1/orders?key=X")')
    expect(f.label).toBe('정보 가져오는')
    expect(f.host).toBe('api.example.com')
  })
  it('never carries a typed value for a type/fill, only the stem', () => {
    const r = codeHandLabel('await page.type("e3", "my-password")')
    expect(r.label).toBe('입력하는')
    expect(r.host).toBeUndefined()
  })
  it('falls back to a neutral stem for an unknown snippet', () => {
    expect(codeHandLabel('await pc.snapshot()').label).toBe('PC 화면 다루는')
    expect(codeHandLabel('const x = 1 + 1').label).toBe('일하는')
  })
  it('has English wording too', () => {
    expect(codeHandLabel('await page.goto("https://x.com")', 'en').label).toBe('Opening a web page')
  })
})

describe('workStatus', () => {
  it('gives a bare stem for each non-tool phase', () => {
    expect(workStatus('thinking')).toBe('생각하는')
    expect(workStatus('awaitingApproval')).toBe('승인 기다리는')
    expect(workStatus('blocked')).toBe('막혀서 못 한 일 알리는')
    expect(workStatus('thinking', 'en')).toBe('Thinking')
  })
})
