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

/** 빈 줄로 문단을 나누고, 이어진 "- "·"1. " 줄은 목록으로 묶는다 */
export function richBlocks(text: string): RichBlock[] {
  const blocks: RichBlock[] = []
  for (const chunk of text.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    let cur: RichBlock | undefined
    const open = <B extends RichBlock>(b: B): B => {
      blocks.push(b)
      cur = b
      return b
    }
    for (const line of chunk.split('\n')) {
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
  skill_find: '사용법 찾는',
  skill_read: '사용법 읽는',
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
}
export function toolLabel(name: string): string {
  return TOOL_LABEL[name.replace(/^(mcp__dool2__|dool2_)/, '')] ?? '일하는'
}

/**
 * 두리 앱이 사용자 대신 AI에게 보내는 알림 (승인 결과 등). 대화 기록에는 user로 남지만,
 * 화면에서는 내 말풍선이 아니라 가운데 회색 알림 줄로 보여 준다.
 */
export const APP_NOTE = '[두리 앱 알림] '
const NOTE_TAIL = / ?(결과를 확인하고 이어서 해 주세요|누르지 말아 주세요)\.$/

export function appNote(text: string): string {
  return APP_NOTE + text
}

/** 알림이면 화면에 보여 줄 글 (AI에게만 필요한 꼬리말은 뺀다), 아니면 undefined */
export function readAppNote(text: string): string | undefined {
  if (!text.startsWith(APP_NOTE)) return undefined
  return text.slice(APP_NOTE.length).replace(NOTE_TAIL, '').trim()
}
