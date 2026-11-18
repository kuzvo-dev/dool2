// 화면 그리기 도우미 (PC 앱·폰 앱이 같이 쓴다)
// - 두리 답을 그릴 때 쓰는 아주 작은 마크다운: 문단, "- " 목록, "1. " 목록, **굵게**
// - 일하는 중에 보여 줄 도구 이름 ("웹페이지 여는 중")
// HTML은 해석하지 않는다. 결과는 글자 조각뿐이라 PC 앱·폰 앱이 각자 DOM으로 그린다.
// 의존성이 없어야 한다 (PC 앱 화면에 파일 그대로 복사해 쓴다).

export interface Inline {
  text: string
  bold?: true
}

export type RichBlock =
  | { type: 'p'; lines: Inline[][] }
  | { type: 'ul'; items: Inline[][] }
  | { type: 'ol'; start: number; items: Inline[][] }
  /** "## 제목" (1~3) */
  | { type: 'h'; level: 1 | 2 | 3; text: Inline[] }
  /** 마크다운 표 "| a | b |" (둘째 줄 "|---|---|"이 있으면 첫 줄이 머리) */
  | { type: 'table'; head?: Inline[][]; rows: Inline[][][] }

export function inline(text: string): Inline[] {
  const out: Inline[] = []
  for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
    if (!part) continue
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      out.push({ text: part.slice(2, -2), bold: true })
    else out.push({ text: part })
  }
  return out
}

/** 표 한 줄 "| a | b |" → 칸들 */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}
const TABLE_LINE = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

/** 빈 줄로 문단을 나누고, 이어진 "- "·"1. " 줄은 목록으로, "| |" 줄은 표로, "## "는 제목으로 묶는다 */
export function richBlocks(text: string): RichBlock[] {
  const blocks: RichBlock[] = []
  for (const chunk of text.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    let cur: RichBlock | undefined
    const open = <B extends RichBlock>(b: B): B => {
      blocks.push(b)
      cur = b
      return b
    }
    const lines = chunk.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      // 표: 이어진 "| … |" 줄. 둘째 줄이 "|---|"면 첫 줄이 머리
      if (TABLE_LINE.test(line)) {
        const rows: string[] = []
        while (i < lines.length && TABLE_LINE.test(lines[i] ?? '')) rows.push(lines[i++] ?? '')
        i--
        const hasHead = rows.length > 1 && TABLE_RULE.test(rows[1] ?? '')
        const body = rows.filter((r, k) => !(hasHead && k === 1) && !TABLE_RULE.test(r))
        const cells = body.map((r) => tableCells(r).map(inline))
        open(
          hasHead ? { type: 'table', head: cells[0], rows: cells.slice(1) } : { type: 'table', rows: cells },
        )
        cur = undefined
        continue
      }
      const heading = /^\s*(#{1,3})\s+(.+)$/.exec(line)
      if (heading) {
        open({ type: 'h', level: (heading[1]?.length ?? 2) as 1 | 2 | 3, text: inline(heading[2] ?? '') })
        cur = undefined
        continue
      }
      const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
      const num = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line)
      if (bullet) {
        const ul = cur?.type === 'ul' ? cur : open({ type: 'ul', items: [] })
        ul.items.push(inline(bullet[1] ?? ''))
      } else if (num) {
        const ol = cur?.type === 'ol' ? cur : open({ type: 'ol', start: Number(num[1]), items: [] })
        ol.items.push(inline(num[2] ?? ''))
      } else if (line.trim() || cur?.type === 'p') {
        const p = cur?.type === 'p' ? cur : open({ type: 'p', lines: [] })
        p.lines.push(inline(line))
      }
    }
  }
  return blocks
}

/** 일하는 중 표시: "웹페이지 여는" (도구 이름 앞의 mcp__dool2__ / dool2_는 떼고 본다) */
const TOOL_LABEL: Record<string, string> = {
  status: '두리 상태 확인하는',
  browser_login: '금고로 로그인 칸 채우는',
  browser_open: '웹페이지 여는',
  browser_navigate: '웹페이지 여는',
  browser_read: '페이지 읽는',
  browser_click: '누르는',
  browser_type: '입력하는',
  browser_press: '키 누르는',
  browser_scroll: '스크롤하는',
  browser_screenshot: '화면 보는',
  browser_back: '뒤로 가는',
  browser_close: '탭 닫는',
  browser_handoff: '도움 부탁하는',
  browser_request_approval: '승인 요청하는',
  browser_request_login: '로그인 카드 띄우는',
  browser_dialog: '사이트 확인 창 고르는',
  browser_steps: '여러 동작 하는',
  screen_status: 'PC 상태 확인하는',
  screen_apps: '앱 찾는',
  screen_open: '앱 여는',
  screen_read: '앱 화면 읽는',
  screen_click: '앱에서 누르는',
  screen_type: '앱에 입력하는',
  screen_key: '앱에서 키 누르는',
  screen_screenshot: '앱 화면 보는',
  screen_request_app: '앱 허용 요청하는',
  screen_request_approval: '승인 요청하는',
  goal_create: '목표 만드는',
  goal_list: '목표 보는',
  goal_update: '목표 고치는',
  goal_delete: '목표 지우는',
  library_save: '보관함에 남기는',
  memory_save: '기억하는',
  memory_forget: '잊는',
  idea_suggest: '할 일 찾는',
  photo_view: '사진 보는',
  feed_post: '피드에 올리는',
  feed_tell: '먼저 챙긴 일 알리는',
  connect_ask: '연결 카드 띄우는',
  conversation_search: '지난 대화 찾는',
  service_find: '서비스 찾는',
  service_call: '서비스에서 일하는',
}
/** 서비스 도구(catchtable_search …)는 끝말로: 찾기·조회·보기·준비 */
const SERVICE_VERB: [RegExp, string][] = [
  [/_(?:search|find)$/, '찾는'],
  [/_(?:track|check|status)$/, '조회하는'],
  [/_(?:list|orders|history|view|detail|slots)$/, '보는'],
  [/_(?:prepare|book|reserve|order|cart)\w*$/, '준비하는'],
]
export function toolLabel(name: string): string {
  const n = name.replace(/^(mcp__dool2__|dool2_)/, '')
  return TOOL_LABEL[n] ?? SERVICE_VERB.find(([re]) => re.test(n))?.[1] ?? '일하는'
}

/** 폰에서 보낸 사진 표시: 말 끝의 "[사진: 파일이름]" */
export const PHOTO_MARK = '[사진: '
/** 말에서 사진 표시를 떼어 낸다: { text, photo } */
export function splitPhoto(text: string): { text: string; photo?: string } {
  const m = /\s*\[사진: ([\w-]+\.jpg)\]\s*$/.exec(text)
  return m ? { text: text.slice(0, m.index).trim(), photo: m[1] as string } : { text }
}

/** 화면 제목용: 사진 표시(잘린 것 포함)를 "(사진)"으로 */
export function withoutPhotoMark(text: string): string {
  return text.replace(/\s*\[사진:[^\]]*\]?/g, ' (사진)').trim()
}

/**
 * 두리 앱이 사용자 대신 AI에게 보내는 알림 (승인 결과 등). 대화 기록에는 user로 남지만,
 * 화면에서는 내 말풍선이 아니라 가운데 회색 알림 줄로 보여 준다.
 */
export const APP_NOTE = '[두리 앱 알림] '
/** AI에게만 필요한 문장 (화면 알림 줄에서는 뺀다): 도구 이름, "이어서 해 주세요" 같은 지시 */
const AI_ONLY =
  /browser_\w+|screen_\w+|connect_\w+|이어서 해 주세요|누르지 말아 주세요|^지금 화면:|^사용자에게/

export function appNote(text: string): string {
  return APP_NOTE + text
}

/** 알림이면 화면에 보여 줄 글 (AI에게만 필요한 꼬리말은 뺀다), 아니면 undefined */
export function readAppNote(text: string): string | undefined {
  if (!text.startsWith(APP_NOTE)) return undefined
  return text
    .slice(APP_NOTE.length)
    .split(/(?<=[.!?요])\s+/)
    .filter((sentence) => !AI_ONLY.test(sentence))
    .join(' ')
    .trim()
}

/**
 * 답에 섞여 나온 영어 속생각 문단을 걷어 낸다. 한글이 하나도 없고 속생각 말투인 문단만 뺀다
 * (URL·상품명·코드처럼 영어인 문단은 남긴다). 다 걷어 내면 원래 글을 그대로 둔다.
 */
/** 결과 한 줄: 앞의 인사("좋은 아침이에요." 등)를 빼고 결과부터 */
export function resultLine(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/^\s*(?:좋은\s*(?:아침|오후|저녁|하루)이?에요|안녕하세요|안녕)[.!~,]*\s*/u, '')
    .trim()
}

export function stripMonologue(text: string): string {
  const THINK =
    /\b(I'll|I will|I'm going to|Let me|Let's|Now I|Now let|First,|Next,|Then I|skill|tool|tab \d|ref|click|scroll|navigate|snapshot)\b/i
  const kept = text
    .split(/\n{2,}/)
    .filter((para) => /[가-힣]/.test(para) || !THINK.test(para))
    .join('\n\n')
    .trim()
  return kept || text
}

/**
 * 일하는 중간에 한 말(도구를 쓰기 전 혼잣말)에서 "지금 하는 일"로 보여 줄 한 줄.
 * 한글이 있는 마지막 문장만 쓰고(영어 속생각은 버린다), 60자를 넘으면 자른다.
 */
export function narrationLine(text: string): string | undefined {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…요다])\s+|(?<=[.!?])(?=\S)/)
    .map((x) => x.trim())
    .filter((x) => /[가-힣]/.test(x))
  const last = sentences.at(-1)
  if (!last) return undefined
  return last.length > 60 ? `${last.slice(0, 59)}…` : last
}

/** 받침에 맞는 조사: josa('주문', '을/를') → '주문을'. 한글이 아니면 받침 없는 쪽 */
export function josa(word: string, pair: '을/를' | '은/는' | '이/가' | '과/와'): string {
  const [withFinal, without] = pair.split('/') as [string, string]
  const last =
    word
      .trim()
      .replace(/["'”’)\]]+$/, '')
      .at(-1) ?? ''
  const code = last.charCodeAt(0) - 0xac00
  const hasFinal = code >= 0 && code <= 11171 && code % 28 !== 0
  return word + (hasFinal ? withFinal : without)
}
