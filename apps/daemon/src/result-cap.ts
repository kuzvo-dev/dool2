// Result cap: no tool result reaches the AI with more than RESULT_CAP characters of text, unless the AI asked for more
// (maxChars). Every result stays in the AI's context for the rest of the segment, and a few long ones (a whole mail
// thread, an app screen, a long service list) used to fill it.
//
// It runs last on the tool address (index.ts guard), after everything that reads the whole result: the loop guard,
// the injection note and the auto-approve check have seen it uncut, and the daemon's own state (page refs, approval
// requests, remembered routes) never comes from this text. The longest text part is cut at a line end, and one line
// says how much was left out and how to ask for less.

interface Part {
  type: string
  text?: string
}
interface ToolLikeResult {
  content?: Part[]
}

/** Text characters a tool result may give the AI (when it did not ask for more) */
export const RESULT_CAP = 6_000
/** Most a result may give even when the AI asks for more (maxChars of reading tools is up to 40,000) */
const ASKED_MAX = 40_000

/** How to get the rest, per tool group (the cut line ends with it) */
function moreHint(tool: string): string {
  const group = tool.split('/')[0]
  if (group === 'browser')
    return 'To read on, call browser_read with from (the text of the last line shown) or skip, or with a larger maxChars.'
  if (group === 'screen') return 'To read more, call screen_read with a larger maxChars.'
  if (group === 'file') return 'Read a part (a page range or a search word) or ask for fewer items.'
  if (group === 'service')
    return 'Ask for less: a narrower input, or the next rows with offset if the result says there are more.'
  return 'Ask for less: a narrower search, a shorter period or fewer items.'
}

/** Text length of a result (images do not count) */
export function textLength(r: ToolLikeResult): number {
  return (r.content ?? []).reduce((n, c) => n + (c.type === 'text' ? (c.text?.length ?? 0) : 0), 0)
}

/**
 * The result with its text cut to the cap. input: the tool's input (maxChars above the cap raises it). Results that
 * fit, or are not tool results, are returned as they are
 */
export function capResult(
  tool: string,
  input: unknown,
  result: unknown,
): { result: unknown; cut?: { chars: number; cap: number } } {
  const r = result as ToolLikeResult
  if (!r || typeof r !== 'object' || !Array.isArray(r.content)) return { result }
  const asked = Number((input as { maxChars?: unknown } | undefined)?.maxChars)
  const cap = Number.isFinite(asked) && asked > RESULT_CAP ? Math.min(asked + 2_000, ASKED_MAX) : RESULT_CAP
  const total = textLength(r)
  if (total <= cap) return { result }
  const hint = moreHint(tool)
  const content = r.content.map((c) => ({ ...c }))
  let over = total - cap
  // Cut the longest text parts first (the page, the mail, the list); short notes around them stay whole
  while (over > 0) {
    const i = longestText(content)
    if (i < 0) break
    const part = content[i] as Part
    const text = part.text ?? ''
    const line = `\n\n(Cut here to keep the result short: ${(total - cap).toLocaleString('en-US')} more characters were not shown. ${hint})`
    const keep = Math.max(0, text.length - over - line.length)
    // At a line end when there is one in the last fifth, so a line (and its ref) is not cut in the middle
    const end = text.lastIndexOf('\n', keep)
    const at = end > keep * 0.8 ? end : keep
    const cutText = text.slice(0, at) + line
    content[i] = { ...part, text: cutText }
    over -= text.length - cutText.length
    if (at === 0) break
  }
  return { result: { ...r, content }, cut: { chars: total, cap } }
}

function longestText(content: Part[]): number {
  let best = -1
  for (const [i, c] of content.entries())
    if (c.type === 'text' && (c.text?.length ?? 0) > ((best >= 0 ? content[best]?.text?.length : 0) ?? 0))
      best = i
  return best
}
