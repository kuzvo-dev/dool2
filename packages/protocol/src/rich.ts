// 두리 답을 화면에 그릴 때 쓰는 아주 작은 마크다운: 문단, "- " 목록, "1. " 목록, **굵게**.
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
