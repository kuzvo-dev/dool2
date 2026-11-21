// 화면 그리기 도우미 (PC 앱·폰 앱이 같이 쓴다)
// - 두리 답을 그릴 때 쓰는 아주 작은 마크다운: 문단, "- " 목록, "1. " 목록, **굵게**
// - 일하는 중에 보여 줄 도구 이름 ("웹페이지 여는 중")
// HTML은 해석하지 않는다. 결과는 글자 조각뿐이라 PC 앱·폰 앱이 각자 DOM으로 그린다.
// 의존성이 없어야 한다 (PC 앱 화면에 파일 그대로 복사해 쓴다).

export interface Inline {
  text: string
  bold?: true
  /** 누르면 열 주소 (https만) */
  href?: string
  /** 출처 칩: 문장 끝 "([MBC](주소), [연합뉴스](주소))" → 작은 칩으로 */
  src?: true
}

export type RichBlock =
  | { type: 'p'; lines: Inline[][] }
  | { type: 'ul'; items: Inline[][] }
  | { type: 'ol'; start: number; items: Inline[][] }
  /** "## 제목" (1~3) */
  | { type: 'h'; level: 1 | 2 | 3; text: Inline[] }
  /** 마크다운 표 "| a | b |" (둘째 줄 "|---|---|"이 있으면 첫 줄이 머리) */
  | { type: 'table'; head?: Inline[][]; rows: Inline[][][] }

// 링크: [글](https://…) 또는 맨 주소. 출처 묶음: "([A](u), [B](u))"
const MD_LINK = String.raw`\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)`
const SRC_GROUP = new RegExp(String.raw`\s?\(\s*(${MD_LINK}(?:\s*[,·]\s*${MD_LINK})*)\s*\)`, 'g')
const LINK_OR_URL = new RegExp(String.raw`${MD_LINK}|(https?:\/\/[^\s)<>\]]+[^\s)<>\].,!?])`, 'g')

/** 맨 주소를 보여 줄 글: 사이트 이름만 (www. 뺌) */
function hostLabel(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

function bolds(text: string): Inline[] {
  const out: Inline[] = []
  for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
    if (!part) continue
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      out.push({ text: part.slice(2, -2), bold: true })
    else out.push({ text: part })
  }
  return out
}

/** 링크·맨 주소를 조각으로 (나머지는 굵게만 본다) */
function links(text: string, src?: true): Inline[] {
  const out: Inline[] = []
  let at = 0
  for (const m of text.matchAll(LINK_OR_URL)) {
    const i = m.index ?? 0
    if (i > at) out.push(...bolds(text.slice(at, i)))
    const href = m[2] ?? m[3] ?? ''
    out.push({ text: m[1] ?? hostLabel(href), href, ...(src ? { src } : {}) })
    at = i + m[0].length
  }
  if (at < text.length) out.push(...bolds(text.slice(at)))
  return out
}

/** 한 줄 미리 보기용: 출처 묶음 "([A](주소))"는 빼고, 링크는 글만 남긴다 */
export function stripLinks(text: string): string {
  return text.replace(SRC_GROUP, '').replace(new RegExp(MD_LINK, 'g'), '$1')
}

export function inline(text: string): Inline[] {
  const out: Inline[] = []
  let at = 0
  // 출처 묶음은 괄호·쉼표를 빼고 칩만 남긴다
  for (const m of text.matchAll(SRC_GROUP)) {
    const i = m.index ?? 0
    if (i > at) out.push(...links(text.slice(at, i)))
    out.push(...links(m[1] ?? '', true).filter((x) => x.href))
    at = i + m[0].length
  }
  if (at < text.length) out.push(...links(text.slice(at)))
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
  // 답 끝 빠른 답 줄([[답: …]])은 버튼으로 따로 그린다. 흘러오는 중인 덜 온 꼬리도 감춘다
  for (const chunk of hideQuickTail(text)
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)) {
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
  browser_wait: '화면 바뀌기 기다리는',
  browser_tabs: '탭 목록 보는',
  browser_close: '탭 닫는',
  browser_handoff: '도움 부탁하는',
  browser_request_approval: '승인 요청하는',
  browser_checkout: '결제 카드 띄우는',
  browser_order_done: '주문 완료 확인하는',
  browser_wait_auth: '인증 앱 승인 기다리는',
  browser_request_code: '폰에서 값 받는',
  browser_request_login: '로그인 카드 띄우는',
  browser_fill_profile: '내 정보 채우는',
  browser_request_profile: '내 정보 카드 띄우는',
  browser_new_password: '새 비밀번호 만드는',
  browser_select: '옵션 고르는',
  browser_dialog: '사이트 확인 창 고르는',
  browser_steps: '여러 동작 하는',
  browser_hover: '마우스 올려 보는',
  browser_upload: '파일 올리는',
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
  library_find: '보관함 보는',
  memory_save: '기억하는',
  memory_forget: '잊는',
  idea_suggest: '할 일 찾는',
  photo_view: '사진 보는',
  pay_method_list: '결제 수단 보는',
  profile_view: '내 정보 보는',
  vault_find: '금고 보는',
  feed_post: '피드에 올리는',
  feed_tell: '먼저 챙긴 일 알리는',
  feed_find: '피드 보는',
  connect_ask: '연결 카드 띄우는',
  show_cards: '카드 만드는',
  show_list: '목록 만드는',
  show_result: '결과 정리하는',
  show_route: '길 정리하는',
  show_draft: '보낼 글 쓰는',
  conversation_search: '지난 대화 찾는',
  file_find: '파일 찾는',
  file_read: '파일 읽는',
  file_write: '파일 만드는',
  file_move: '파일 옮기는',
  file_convert: '사진 형식 바꾸는',
  file_print: '출력하는',
  file_pdf: 'PDF 만드는',
  file_render: 'PDF·그림으로 만드는',
  file_trash: '휴지통 보는',
  file_download: '파일 받는',
  pc_screen: 'PC 화면 다루는',
  service_find: '서비스 찾는',
  service_call: '서비스에서 일하는',
  orders_all: '내 주문 모아 보는',
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

/**
 * 단계가 일어난 곳 (일하는 카드에서 서비스 아이콘으로 묶는 기준).
 * - 웹: 사이트 주소 "search.naver.com" (주소가 없는 browser_ 도구는 지금 보고 있는 곳 here)
 * - 서비스 도구: "tool:catchtable_search" (어느 연결 카드인지는 화면이 카드 목록으로 찾는다)
 * - PC 앱 "app", 파일 "file". 그 밖(기억·목표처럼 두리 안에서 하는 일)은 undefined
 */
export function toolPlace(name: string, input?: unknown, here?: string): string | undefined {
  const n = name.replace(/^(mcp__dool2__|dool2_)/, '')
  const arg = (input ?? {}) as { url?: unknown; tool?: unknown }
  if (n.startsWith('browser_')) {
    if (typeof arg.url === 'string') {
      try {
        const host = new URL(arg.url).host
        if (host) return host
      } catch {}
    }
    return here
  }
  if (n.startsWith('screen_')) return 'app'
  if (n.startsWith('file_')) return 'file'
  if (n === 'service_call') return typeof arg.tool === 'string' ? `tool:${arg.tool}` : undefined
  if (!(n in TOOL_LABEL) && /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(n)) return `tool:${n}`
  return undefined
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
  const kept = dropEnglishLines(text)
    .split(/\n{2,}/)
    .filter((para) => /[가-힣]/.test(para) || !THINK.test(para))
    .join('\n\n')
    .trim()
  return kept || text
}

/**
 * 한글 답 사이에 섞인 영어 속생각 줄("Menu may still be loading.")을 뺀다: 한글이 없고 영어 단어가 4개 이상 이어진 줄.
 * 주소(http)·표 줄(|)·상품 이름처럼 짧은 영어는 남긴다 (사용자 11-20: 진행 중에 영어 생각이 보인다)
 */
export function dropEnglishLines(text: string): string {
  return text
    .split('\n')
    .filter(
      (line) =>
        /[가-힣]/.test(line) ||
        /https?:\/\/|\|/.test(line) ||
        !/[A-Za-z]{2,}[,.]?(?:\s+[A-Za-z'’]+[,.!?]?){3,}/.test(line),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
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

// ── 빠른 답: 답 글 끝 한 줄 [[답: a | b | c]] ─────────────

const QUICK_LINE = /\n?[ \t]*\[\[답\s*[:：]([^\]\n]*)\]\][ \t]*$/
/** 아직 흘러오는 중인 꼬리 ([[답: 화요… 처럼 덜 온 것) */
const QUICK_PARTIAL = /\n?[ \t]*\[(\[(답(\s*[:：][^\]\n]*\]?)?)?)?$/

/**
 * 답 끝의 빠른 답 줄을 떼어 낸다. 2~4개, 하나에 20자까지만 버튼으로.
 * 줄이 이상하면 버튼 없이 줄만 지운다
 */
export function splitQuick(text: string): { text: string; replies?: string[] } {
  const m = text.match(QUICK_LINE)
  if (!m) return { text }
  const body = text.slice(0, m.index).trimEnd()
  const seen = new Set<string>()
  const replies = (m[1] ?? '')
    .split(/[|｜]/)
    .map((s) => s.trim())
    .filter((s) => s && s.length <= 20 && !seen.has(s) && seen.add(s))
    .slice(0, 4)
  return replies.length >= 2 ? { text: body, replies } : { text: body }
}

/** 흘러오는 중인 답에서 빠른 답 줄(덜 온 것 포함)을 감춘다 */
export function hideQuickTail(text: string): string {
  const done = text.match(QUICK_LINE)
  if (done) return text.slice(0, done.index).trimEnd()
  const part = text.match(QUICK_PARTIAL)
  // "[" 하나만 왔을 때는 글 속 대괄호일 수도 있지만, 한 글자 잠깐 늦게 보이는 것뿐이라 감춘다
  return part && part.index !== undefined && part[0].trim() ? text.slice(0, part.index).trimEnd() : text
}

/**
 * 입력하는 동안 하이픈 넣기: 휴대폰 010-1234-5678, 생년월일 1990-01-31.
 * 숫자만 보고 다시 만들어서 지우거나 붙여 넣어도 맞는다. 그 밖의 글자가 섞이면 그대로 둔다
 */
export function hyphenate(kind: 'phone' | 'birth', value: string): string {
  if (/[^\d\s-]/.test(value)) return value
  const d = value.replace(/\D/g, '')
  if (kind === 'birth') {
    const n = d.slice(0, 8)
    return [n.slice(0, 4), n.slice(4, 6), n.slice(6)].filter(Boolean).join('-')
  }
  const n = d.slice(0, 11)
  // 02 지역번호는 2자리, 그 밖은 3자리 + 가운데 3~4자리
  const head = n.startsWith('02') ? 2 : 3
  if (n.length <= head) return n
  const mid = n.length - head > 7 ? 4 : n.length - head > 6 ? (n.startsWith('02') ? 4 : 3) : 4
  const a = n.slice(0, head)
  const b = n.slice(head, head + mid)
  const c = n.slice(head + mid)
  return [a, b, c].filter(Boolean).join('-')
}
