// Continue-typing suggestion (the faint rest in the input box): among candidates that start with what is typed,
// the one that fits the chat. Order: follow-ups from the latest Dool2 reply > ideas overlapping the recent chat > the rest.
// With a recent chat, ideas that overlap nothing are not shown (better no suggestion than an odd one).
import type { Lang } from '@dool2/i18n'
import { readAppNote } from '@dool2/protocol/rich'
import { lang as appLang } from './lang.js'
import { ghostText } from './locales/ghost.js'
import { hasBatchim, josa, notAName, STOP, TOPIC_WORDS } from './region/kr/ghost.js'

/** A chat within this time counts as the "recent chat" */
export const FRESH_MS = 30 * 60_000

export interface GhostTalk {
  /** The last Dool2 reply */
  reply?: string
  /** My last message (app notes excluded) */
  ask?: string
  /** Time of the later of the two (ms) */
  at?: number
}

export interface GhostInput {
  /** What is typed in the input box now */
  draft: string
  talk?: GhostTalk
  /** Ideas picked for me */
  mine?: readonly string[]
  /** The idea catalog */
  catalog?: readonly string[]
  /** Language of the suggestions (defaults to the app language) */
  lang?: Lang
  now?: number
}

/** Picks the last Dool2 reply and my last message from the chat (app notes are not mine, so skipped) */
export function recentTalk(
  messages: readonly { role: string; text: string; createdAt: string }[],
): GhostTalk {
  const talk: GhostTalk = {}
  for (let i = messages.length - 1; i >= 0 && !(talk.reply && talk.ask); i--) {
    const m = messages[i]
    if (!m?.text.trim()) continue
    if (m.role === 'assistant' && !talk.reply) talk.reply = m.text
    else if (m.role === 'user' && !talk.ask && readAppNote(m.text) === undefined) talk.ask = m.text
    else continue
    const at = Date.parse(m.createdAt)
    if (Number.isFinite(at)) talk.at = Math.max(talk.at ?? 0, at)
  }
  return talk
}

/** The rest to append to what is typed, or '' */
export function ghostRest(input: GhostInput): string {
  const d = input.draft.trimStart()
  if (d.length < 2 || d.includes('\n')) return ''
  const hit = ghostCandidates(input).find((t) => t.startsWith(d) && t.length > d.length)
  return hit ? hit.slice(d.length) : ''
}

/** Candidates in score order (only those starting with what is typed) */
export function ghostCandidates(input: GhostInput): string[] {
  const d = input.draft.trimStart()
  const now = input.now ?? Date.now()
  const talk = input.talk ?? {}
  const fresh = talk.at !== undefined && now - talk.at <= FRESH_MS && Boolean(talk.reply || talk.ask)
  const starts = (t: string) => t.startsWith(d) && t.length > d.length
  const ideas = unique([...(input.mine ?? []), ...(input.catalog ?? [])]).filter(starts)
  if (!fresh) return ideas
  const fromTalk = talkFollowUps(talk, input.lang ?? appLang).filter(starts)
  const said = bigrams(`${talk.reply ?? ''} ${talk.ask ?? ''}`)
  const own = bigrams(d)
  const scored = ideas
    .map((text, i) => {
      let score = 0
      for (const b of bigrams(text)) if (!own.has(b) && said.has(b)) score++
      return { text, i, score }
    })
    // Drop ideas that overlap nothing in the recent chat
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.text)
  return unique([...fromTalk, ...scored])
}

// ── Building follow-ups from the reply ──

type Topic = 'food' | 'shop' | 'trip'

const TOPIC_WORDS_EN: Record<Topic, RegExp> = {
  food: /restaurant|cafe|brunch|dinner|lunch|menu|anniversary/i,
  shop: /price|cheapest|product|cart|shipping|discount|buy|order|shopping/i,
  trip: /hotel|stay|resort|flight|train|KTX|SRT|trip|travel/i,
}
const TOPIC_IDS: Topic[] = ['food', 'shop', 'trip']

/** What the reply is about: look at the reply first, then my own message */
export function talkTopic(talk: GhostTalk): Topic | undefined {
  for (const text of [talk.reply, talk.ask]) {
    if (!text) continue
    const hit = TOPIC_IDS.find((id) => TOPIC_WORDS[id].test(text) || TOPIC_WORDS_EN[id].test(text))
    if (hit) return hit
  }
  return undefined
}

/** Names written in bold in the reply (shops, products…). Values, headings and sentences are left out */
export function boldNames(reply: string): string[] {
  const out: string[] = []
  for (const m of reply.matchAll(/\*\*([^*\n]{1,24})\*\*/g)) {
    const name = (m[1] ?? '').trim().replace(/[.,!?·:]+$/, '')
    if (name.length < 2 || name.length > 16) continue
    if (notAName(name, m[1] ?? '')) continue
    if (!out.includes(name)) out.push(name)
    if (out.length >= 4) break
  }
  return out
}

/** Follow-ups from the chat: one line per bold name, then lines that fit the topic */
export function talkFollowUps(talk: GhostTalk, lang: Lang = 'ko'): string[] {
  const m = ghostText(lang)
  const topic = talkTopic(talk)
  const names = talk.reply ? boldNames(talk.reply) : []
  const out: string[] = []
  for (const n of names) {
    if (topic === 'food' || topic === 'trip') out.push(m.bookIt(n))
    if (topic === 'shop') out.push(m.addToCart(n))
    out.push(m.moreAbout(n))
    if (topic === 'food') out.push(m.closingTime(n))
  }
  const asks = topic ? m[topic].split('\n') : []
  return unique([...out, ...asks, ...(talk.reply ? [m.more] : [])])
}

export { hasBatchim, josa }

// ── Character pairs ──

/** Two-character pairs inside a word (common verb and ending pairs are skipped) */
export function bigrams(text: string): Set<string> {
  const out = new Set<string>()
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    for (let i = 0; i + 1 < word.length; i++) {
      const b = word.slice(i, i + 2)
      if (!STOP.has(b)) out.add(b)
    }
  }
  return out
}

function unique(list: readonly string[]): string[] {
  return [...new Set(list.map((t) => t.trim()).filter(Boolean))]
}

// ── Screen: lay the faint text exactly over the input text ──

/** Shorthands (font, padding) read back empty in Chrome when any longhand is non-default, so copy one by one */
const TEXT_BOX = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontStretch',
  'fontFeatureSettings',
  'fontVariationSettings',
  'fontVariantNumeric',
  'fontVariantLigatures',
  'fontKerning',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'textTransform',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
] as const

/** Copies font, line height, padding and border width from `from` (the input) to target (border is transparent) */
export function matchTextBox(target: HTMLElement, from: HTMLElement): void {
  const cs = getComputedStyle(from)
  for (const k of TEXT_BOX) target.style[k] = cs[k]
  target.style.boxSizing = cs.boxSizing
  target.style.borderStyle = 'solid'
  target.style.borderColor = 'transparent'
}
