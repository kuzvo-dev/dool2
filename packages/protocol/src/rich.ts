// Screen drawing helpers (shared by the PC app and the phone app)
// - A very small markdown for drawing Dool2's answers: paragraphs, "- " lists, "1. " lists, **bold**
// - Tool names to show while working ("웹페이지 여는 중" / "Opening a web page")
// HTML is not interpreted. The result is only text pieces, so the PC app and the phone app each draw them into their own DOM.
// It must have no dependencies (the PC app copies this file as-is next to its window), so catalogs here are plain objects and only types are imported.
import type { Lang } from '@dool2/i18n'

export interface Inline {
  text: string
  bold?: true
  /** Address to open on press (https only) */
  href?: string
  /** Source chip: "([MBC](url), [연합뉴스](url))" at the end of a sentence becomes small chips */
  src?: true
  /**
   * A PC file path ("~/Documents/두리/초대장.png"). Written in an answer as `path`, [name](file:///path) or [name](~/path).
   * The PC app opens the file on press, and the phone fetches it from the PC and saves it (the core checks the path is inside the user's folder)
   */
  file?: string
}

export type RichBlock =
  | { type: 'p'; lines: Inline[][] }
  | { type: 'ul'; items: Inline[][] }
  | { type: 'ol'; start: number; items: Inline[][] }
  /** "## Heading" (1-3) */
  | { type: 'h'; level: 1 | 2 | 3; text: Inline[] }
  /** Markdown table "| a | b |" (if the second line is "|---|---|", the first line is the header) */
  | { type: 'table'; head?: Inline[][]; rows: Inline[][][] }

// Links: [text](https://…) or a bare URL. Source group: "([A](u), [B](u))"
const MD_LINK = String.raw`\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)`
const SRC_GROUP = new RegExp(String.raw`\s?\(\s*(${MD_LINK}(?:\s*[,·]\s*${MD_LINK})*)\s*\)`, 'g')
const LINK_OR_URL = new RegExp(String.raw`${MD_LINK}|(https?:\/\/[^\s)<>\]]+[^\s)<>\].,!?])`, 'g')

/** Text to show for a bare URL: just the site name (without www.) */
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

// PC files: `~/Documents/두리/초대장.png` (only paths with an extension), [name](file:///Users/…), [name](~/…)
// Mac "~/" and "/Users/", Linux "/home/", Windows "C:\" paths
const PATH = String.raw`(?:~[\/\\]|\/Users\/|\/home\/|[A-Za-z]:\\)[^\`\n]{0,300}?\.[A-Za-z0-9]{1,6}`
const CODE_PATH = String.raw`\`(${PATH})\``
const MD_FILE = String.raw`\[([^\]\n]{1,80})\]\(((?:file:\/\/|~[\/\\])[^)\n]{1,600})\)`
const FILE_RE = new RegExp(`${CODE_PATH}|${MD_FILE}`, 'g')

/** file:///Users/a/%EB%91%90.png -> /Users/a/두.png (Windows file:///C:/… -> C:/…) */
function filePath(target: string): string {
  if (!target.startsWith('file://')) return target
  let p = target.slice('file://'.length).replace(/^localhost\//, '/')
  try {
    p = decodeURIComponent(p)
  } catch {}
  return /^\/[A-Za-z]:[/\\]/.test(p) ? p.slice(1) : p
}

/** File name only: "~/Documents/두리/초대장.png" -> "초대장.png" */
export function fileName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path
}

/** Split a file path into pieces (the rest only looks at bold) */
function files(text: string): Inline[] {
  const out: Inline[] = []
  let at = 0
  for (const m of text.matchAll(FILE_RE)) {
    const i = m.index ?? 0
    if (i > at) out.push(...bolds(text.slice(at, i)))
    const path = m[1] ?? filePath((m[3] ?? '').trim())
    out.push({ text: m[2] ?? fileName(path), file: path })
    at = i + m[0].length
  }
  if (at < text.length) out.push(...bolds(text.slice(at)))
  return out
}

/** Split links, bare URLs and file paths into pieces (the rest only looks at bold) */
function links(text: string, src?: true): Inline[] {
  const out: Inline[] = []
  let at = 0
  for (const m of text.matchAll(LINK_OR_URL)) {
    const i = m.index ?? 0
    if (i > at) out.push(...files(text.slice(at, i)))
    const href = m[2] ?? m[3] ?? ''
    out.push({ text: m[1] ?? hostLabel(href), href, ...(src ? { src } : {}) })
    at = i + m[0].length
  }
  if (at < text.length) out.push(...files(text.slice(at)))
  return out
}

/** For a one-line preview: drops the source group "([A](url))", keeps only the text of links, and only the file name of file paths */
export function stripLinks(text: string): string {
  return text
    .replace(SRC_GROUP, '')
    .replace(new RegExp(MD_LINK, 'g'), '$1')
    .replace(FILE_RE, (_m, code?: string, label?: string) => label ?? fileName(code ?? ''))
}

export function inline(text: string): Inline[] {
  const out: Inline[] = []
  let at = 0
  // Source groups lose their parentheses and commas, leaving only the chips
  for (const m of text.matchAll(SRC_GROUP)) {
    const i = m.index ?? 0
    if (i > at) out.push(...links(text.slice(at, i)))
    out.push(...links(m[1] ?? '', true).filter((x) => x.href))
    at = i + m[0].length
  }
  if (at < text.length) out.push(...links(text.slice(at)))
  return out
}

/** One table row "| a | b |" -> cells */
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

/** Split paragraphs on blank lines, group consecutive "- " and "1. " lines into lists, "| |" lines into tables and "## " into headings */
export function richBlocks(text: string): RichBlock[] {
  const blocks: RichBlock[] = []
  // The quick-reply line at the end of an answer ([[답: …]]) is drawn separately as buttons. A half-arrived tail still streaming in is hidden too
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
      // Table: consecutive "| … |" lines. If the second line is "|---|", the first line is the header
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

/** Working indicator: "웹페이지 여는" (the mcp__dool2__ / dool2_ prefix of the tool name is dropped first) */
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
  phone_sms: '문자 보내는',
  conversation_search: '지난 대화 찾는',
  file_find: '파일 찾는',
  file_read: '파일 읽는',
  file_write: '파일 만드는',
  file_move: '파일 옮기는',
  file_convert: '사진 형식 바꾸는',
  file_print: '출력하는',
  file_pdf: 'PDF 만드는',
  file_render: 'PDF·그림으로 만드는',
  image_make: '그림 AI로 그리는',
  video_make: '영상 만드는',
  video_motion: '모션 영상 만드는',
  video_clip: 'AI 영상 클립 만드는',
  video_style: '영상 스타일 고르는',
  file_trash: '휴지통 보는',
  file_download: '파일 받는',
  pc_screen: 'PC 화면 다루는',
  service_find: '서비스 찾는',
  service_call: '서비스에서 일하는',
  orders_all: '내 주문 모아 보는',
}
/** Service tools (catchtable_search …) go by their ending: search, check, view, prepare */
const SERVICE_VERB: [RegExp, string][] = [
  [/_(?:search|find)$/, '찾는'],
  [/_(?:track|check|status)$/, '조회하는'],
  [/_(?:list|orders|history|view|detail|slots)$/, '보는'],
  [/_(?:prepare|book|reserve|order|cart)\w*$/, '준비하는'],
]
/** English working labels, as full phrases (the Korean ones are word stems that take " 중") */
const TOOL_LABEL_EN: Record<string, string> = {
  status: 'Checking Dool2 status',
  browser_login: 'Filling in the sign-in fields from the vault',
  browser_open: 'Opening a web page',
  browser_navigate: 'Opening a web page',
  browser_read: 'Reading the page',
  browser_click: 'Clicking',
  browser_type: 'Typing',
  browser_press: 'Pressing a key',
  browser_scroll: 'Scrolling',
  browser_screenshot: 'Looking at the screen',
  browser_back: 'Going back',
  browser_wait: 'Waiting for the screen to change',
  browser_tabs: 'Checking the open tabs',
  browser_close: 'Closing a tab',
  browser_handoff: 'Asking for your help',
  browser_request_approval: 'Asking for approval',
  browser_checkout: 'Showing the payment card',
  browser_order_done: 'Confirming the order',
  browser_wait_auth: 'Waiting for approval in the authenticator app',
  browser_request_code: 'Getting a value from your phone',
  browser_request_login: 'Showing the sign-in card',
  browser_fill_profile: 'Filling in your info',
  browser_request_profile: 'Showing the info card',
  browser_new_password: 'Creating a new password',
  browser_select: 'Choosing an option',
  browser_dialog: "Answering the site's prompt",
  browser_steps: 'Doing several actions',
  browser_hover: 'Hovering the mouse',
  browser_upload: 'Uploading a file',
  screen_status: 'Checking PC status',
  screen_apps: 'Looking for the app',
  screen_open: 'Opening the app',
  screen_read: 'Reading the app screen',
  screen_click: 'Clicking in the app',
  screen_type: 'Typing in the app',
  screen_key: 'Pressing a key in the app',
  screen_screenshot: 'Looking at the app screen',
  screen_request_app: 'Asking to use the app',
  screen_request_approval: 'Asking for approval',
  goal_create: 'Creating a goal',
  goal_list: 'Looking at goals',
  goal_update: 'Updating a goal',
  goal_delete: 'Deleting a goal',
  library_save: 'Saving to the library',
  library_find: 'Looking in the library',
  memory_save: 'Remembering',
  memory_forget: 'Forgetting',
  idea_suggest: 'Finding things to do',
  photo_view: 'Looking at the photo',
  pay_method_list: 'Checking payment methods',
  profile_view: 'Looking at your info',
  vault_find: 'Looking in the vault',
  feed_post: 'Posting to the feed',
  feed_tell: 'Telling you what was done ahead of time',
  feed_find: 'Looking at the feed',
  connect_ask: 'Showing the connect card',
  show_cards: 'Making cards',
  show_list: 'Making a list',
  show_result: 'Putting the results together',
  show_route: 'Working out the route',
  show_draft: 'Writing a draft to send',
  phone_sms: 'Sending a text',
  conversation_search: 'Searching past chats',
  file_find: 'Looking for files',
  file_read: 'Reading a file',
  file_write: 'Creating a file',
  file_move: 'Moving files',
  file_convert: 'Converting photo formats',
  file_print: 'Printing',
  file_pdf: 'Making a PDF',
  file_render: 'Making a PDF or image',
  image_make: 'Drawing with image AI',
  video_make: 'Making a video',
  video_motion: 'Making a motion video',
  video_clip: 'Making an AI video clip',
  video_style: 'Choosing a video style',
  file_trash: 'Looking in the trash',
  file_download: 'Downloading a file',
  pc_screen: 'Working with the PC screen',
  service_find: 'Looking for a service',
  service_call: 'Working in a service',
  orders_all: 'Gathering your orders',
}
const SERVICE_VERB_EN: [RegExp, string][] = [
  [/_(?:search|find)$/, 'Searching'],
  [/_(?:track|check|status)$/, 'Checking'],
  [/_(?:list|orders|history|view|detail|slots)$/, 'Looking things up'],
  [/_(?:prepare|book|reserve|order|cart)\w*$/, 'Getting it ready'],
]

/**
 * The working label for a tool. Korean is a word stem ("웹페이지 여는") that callers follow with " 중";
 * English is a full phrase ("Opening a web page"), so use toolAct() when you want the finished text
 */
export function toolLabel(name: string, lang: Lang = 'ko'): string {
  const n = name.replace(/^(mcp__dool2__|dool2_)/, '')
  if (lang === 'en') return TOOL_LABEL_EN[n] ?? SERVICE_VERB_EN.find(([re]) => re.test(n))?.[1] ?? 'Working'
  return TOOL_LABEL[n] ?? SERVICE_VERB.find(([re]) => re.test(n))?.[1] ?? '일하는'
}

/** The finished "what is being done" text: "웹페이지 여는 중" / "Opening a web page" */
export function toolAct(name: string, lang: Lang = 'ko'): string {
  return lang === 'en' ? toolLabel(name, 'en') : `${toolLabel(name)} 중`
}

/**
 * Where a step happened (the key for grouping the working card by service icon).
 * - Web: the site address "search.naver.com" (for browser_ tools without an address, the place being viewed now, here)
 * - Service tool: "tool:catchtable_search" (the screen finds which connect card it is from the card list)
 * - PC app "app", files "file". Everything else (work done inside Dool2, like memory and goals) is undefined
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
  if (
    n.startsWith('file_') ||
    n === 'image_make' ||
    n === 'video_make' ||
    n === 'video_motion' ||
    n === 'video_clip' ||
    n === 'video_style'
  )
    return 'file'
  if (n === 'service_call') return typeof arg.tool === 'string' ? `tool:${arg.tool}` : undefined
  if (!(n in TOOL_LABEL) && /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(n)) return `tool:${n}`
  return undefined
}

/** Mark for a photo sent from the phone: "[사진: file name]" at the end of the message (a protocol marker, kept in Korean) */
export const PHOTO_MARK = '[사진: '
/** Strip the photo mark from the message: { text, photo } */
export function splitPhoto(text: string): { text: string; photo?: string } {
  const m = /\s*\[사진: ([\w-]+\.jpg)\]\s*$/.exec(text)
  return m ? { text: text.slice(0, m.index).trim(), photo: m[1] as string } : { text }
}

/** For screen titles: the photo mark (even a cut-off one) becomes "(사진)" */
export function withoutPhotoMark(text: string): string {
  return text.replace(/\s*\[사진:[^\]]*\]?/g, ' (사진)').trim()
}

/**
 * A notice the Dool2 app sends to the AI on the user's behalf (approval results etc.). It stays in the history as user,
 * but the screen shows it as a grey notice line in the middle, not as my speech bubble.
 */
export const APP_NOTE = '[두리 앱 알림] '
/** Sentences only the AI needs (left out of the on-screen notice line): tool names and instructions like "continue" */
const AI_ONLY =
  /browser_\w+|screen_\w+|connect_\w+|이어서 해 주세요|누르지 말아 주세요|^지금 화면:|^사용자에게/

export function appNote(text: string): string {
  return APP_NOTE + text
}

/** The text to show on screen if it is a notice (the tail only the AI needs is dropped), otherwise undefined */
export function readAppNote(text: string): string | undefined {
  if (!text.startsWith(APP_NOTE)) return undefined
  // What is meant for people comes first and the AI's instructions are attached after: cut at the first sentence with an instruction
  // (filtering sentence by sentence let AI-only remarks like "this is a rule-based judgment and may be wrong" in parentheses leak out, measured 11-21)
  const shown: string[] = []
  for (const sentence of text.slice(APP_NOTE.length).split(/(?<=[.!?요])\s+/)) {
    if (AI_ONLY.test(sentence) || /[(（]/.test(sentence)) break
    shown.push(sentence)
  }
  return shown.join(' ').trim()
}

/** Marker in the finish check's "keep going" note (language independent, apps/daemon/src/finish-check.ts againNote) */
export const FINISH_CHECK_MARK = '(Check before finishing)'

/** The same marker in records saved before the move to English (11-23 and earlier), escaped to keep code free of Hangul */
const OLD_FINISH_CHECK_MARK = '(\uB05D\uB0B4\uAE30 \uC804 \uAC80\uC0AC)'

export function isFinishCheckNote(text: string): boolean {
  return (
    text.startsWith(APP_NOTE) && (text.includes(FINISH_CHECK_MARK) || text.includes(OLD_FINISH_CHECK_MARK))
  )
}

/**
 * One answer per request: when the finish check sent Dool2 back to keep going, the earlier answers of that request
 * are folded away once a newer answer came, or right away while Dool2 is still working on it (`running`), so it reads
 * as "still working" rather than "answered, then started over" (11-23). The check notes themselves are never shown.
 * Returns the ids to hide and, for each answer that replaced others, the ids it replaced (for "show earlier answers").
 * Notes from other sources (approvals, sign-in) do not fold anything: those answers are separate steps
 */
export function interimAnswers(
  messages: readonly { id: string; role: string; text: string }[],
  opts: { running?: boolean } = {},
): {
  hidden: Set<string>
  replaced: Map<string, string[]>
} {
  const hidden = new Set<string>()
  const replaced = new Map<string, string[]>()
  let answers: string[] = []
  let notes: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      if (isFinishCheckNote(m.text)) {
        notes.push(m.id)
        hidden.add(m.id)
      } else if (!m.text.startsWith(APP_NOTE)) {
        answers = []
        notes = []
      }
      continue
    }
    if (m.role !== 'assistant') continue
    if (notes.length && answers.length) {
      const earlier = [...answers, ...notes]
      for (const id of earlier) hidden.add(id)
      // an answer that replaced an answer that itself replaced others carries the whole chain
      replaced.set(m.id, [...answers.flatMap((a) => [...(replaced.get(a) ?? []), a]), ...notes])
      for (const a of answers) replaced.delete(a)
      answers = []
      notes = []
    }
    answers.push(m.id)
  }
  // Still working after a check note: the earlier answer is a draft, not the answer
  if (opts.running && notes.length && answers.length) for (const id of answers) hidden.add(id)
  return { hidden, replaced }
}

/**
 * What the next step after a send-back is, read from the check's note (its "A way to try:" line, or the reason when
 * there is none). The judge writes both in the user's language (ADR 0027)
 */
export function finishNext(note: string): string | undefined {
  const at = (label: string) => {
    const i = note.indexOf(label)
    if (i < 0) return undefined
    const rest = note.slice(i + label.length)
    const end = rest.search(/\n| A way to try: | Do not repeat /)
    return (end < 0 ? rest : rest.slice(0, end)).trim() || undefined
  }
  return at('A way to try: ') ?? at('Something is still left: ')
}

/**
 * The before-finishing check as the screen shows it (ADR 0027): the answer of the current request is a draft while it
 * is judged (checking) or while Dool2 continues after a send-back (running with a check note). The draft stays inside
 * the progress card instead of the conversation, with what Dool2 does next. undefined: nothing to show
 */
export function finishProgress(
  messages: readonly { id: string; role: string; text: string }[],
  opts: { running?: boolean; checking?: boolean },
): { draft?: string; next?: string; rounds: number } | undefined {
  let draft: string | undefined
  let next: string | undefined
  let rounds = 0
  let lastAnswer: string | undefined
  for (const m of messages) {
    if (m.role === 'user') {
      if (isFinishCheckNote(m.text)) {
        rounds++
        draft = lastAnswer
        next = finishNext(m.text)
        lastAnswer = undefined
      } else if (!m.text.startsWith(APP_NOTE)) {
        draft = undefined
        next = undefined
        rounds = 0
        lastAnswer = undefined
      }
      continue
    }
    if (m.role === 'assistant') lastAnswer = m.id
  }
  if (opts.checking && lastAnswer) return { draft: lastAnswer, ...(next ? { next } : {}), rounds }
  if (opts.running && rounds > 0 && !lastAnswer)
    return { ...(draft ? { draft } : {}), ...(next ? { next } : {}), rounds }
  return undefined
}

/**
 * Removes English inner-thought paragraphs mixed into an answer. Only paragraphs with no Hangul at all and in a thinking tone are dropped
 * (English paragraphs like URLs, product names and code stay). If everything would be dropped, the original text is kept.
 */
/** One result line: drops the leading greeting ("좋은 아침이에요." etc.) so the result comes first */
export function resultLine(text: string, lang: Lang = 'ko'): string {
  const greeting =
    lang === 'en'
      ? /^\s*(?:good\s+(?:morning|afternoon|evening|day)|hello|hi|hey)[.!~,]*\s*/iu
      : /^\s*(?:좋은\s*(?:아침|오후|저녁|하루)이?에요|안녕하세요|안녕)[.!~,]*\s*/u
  return text.replace(/\*\*/g, '').replace(greeting, '').trim()
}

export function stripMonologue(text: string, lang: Lang = 'ko'): string {
  // The Hangul test below is how Korean answers are told apart from English inner thoughts; an English answer has nothing to tell apart
  if (lang === 'en') return text
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
 * Drops English inner-thought lines ("Menu may still be loading.") mixed into a Korean answer: lines with no Hangul and four or more English words in a row.
 * Short English like addresses (http), table lines (|) and product names stays (user report 11-20: English thoughts show while in progress)
 */
export function dropEnglishLines(text: string, lang: Lang = 'ko'): string {
  if (lang === 'en') return text
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
 * One line to show as "what is being done now" from what was said mid-work (the monologue before using a tool).
 * Only the last sentence containing Hangul is used (English inner thoughts are dropped; with lang 'en' the last sentence is used as is), and it is cut when longer than 60 characters.
 */
export function narrationLine(text: string, lang: Lang = 'ko'): string | undefined {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…요다])\s+|(?<=[.!?])(?=\S)/)
    .map((x) => x.trim())
    .filter((x) => lang === 'en' || /[가-힣]/.test(x))
  const last = sentences.at(-1)
  if (!last) return undefined
  return last.length > 60 ? `${last.slice(0, 59)}…` : last
}

/** Particle that fits the final consonant: josa('주문', '을/를') -> '주문을'. For non-Hangul it picks the form without a final consonant */
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

// ── Quick replies: one line [[답: a | b | c]] at the end of an answer ─────────────

const QUICK_LINE = /\n?[ \t]*\[\[답\s*[:：]([^\]\n]*)\]\][ \t]*$/
/** A tail still streaming in (a partial one like [[답: 화요…) */
const QUICK_PARTIAL = /\n?[ \t]*\[(\[(답(\s*[:：][^\]\n]*\]?)?)?)?$/

/**
 * Strips the quick-reply line at the end of an answer. 2-4 items, and only up to 20 characters each become buttons.
 * If the line looks wrong, only the line is removed, with no buttons
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

/** Hides the quick-reply line (even a partial one) from an answer still streaming in */
export function hideQuickTail(text: string): string {
  const done = text.match(QUICK_LINE)
  if (done) return text.slice(0, done.index).trimEnd()
  const part = text.match(QUICK_PARTIAL)
  // A lone "[" may be a bracket in the text, but it is only one character shown a moment late, so hide it
  return part && part.index !== undefined && part[0].trim() ? text.slice(0, part.index).trimEnd() : text
}

/**
 * Hyphenating while typing: mobile 010-1234-5678, birth date 1990-01-31.
 * Rebuilt from the digits alone, so deleting or pasting still works. If other characters are mixed in, it is left as is
 */
export function hyphenate(kind: 'phone' | 'birth', value: string): string {
  if (/[^\d\s-]/.test(value)) return value
  const d = value.replace(/\D/g, '')
  if (kind === 'birth') {
    const n = d.slice(0, 8)
    return [n.slice(0, 4), n.slice(4, 6), n.slice(6)].filter(Boolean).join('-')
  }
  const n = d.slice(0, 11)
  // The 02 area code has 2 digits, others have 3 digits + 3-4 middle digits
  const head = n.startsWith('02') ? 2 : 3
  if (n.length <= head) return n
  const mid = n.length - head > 7 ? 4 : n.length - head > 6 ? (n.startsWith('02') ? 4 : 3) : 4
  const a = n.slice(0, head)
  const b = n.slice(head, head + mid)
  const c = n.slice(head + mid)
  return [a, b, c].filter(Boolean).join('-')
}
