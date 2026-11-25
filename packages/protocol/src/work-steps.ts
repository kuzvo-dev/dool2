// Groups the steps of the working card into one line per service (shared by the phone app and PC app. No runtime dependencies: the PC app copies this file as-is next to its window).
// Things done in a row in the same place (site, service tool, PC app, file) are one line: the title is the service name, the small text below is what was done.
// Steps that only have a tool name like "웹페이지 여는 중" or "누르는 중" do not get a line of their own.
import type { Lang } from '@dool2/i18n'

/** Only what is needed from a connect card */
export interface PlaceCard {
  id: string
  name: string
  site?: string
}

export interface WorkStepIn {
  /** One line of self-talk or a tool name */
  text: string
  /** What the tool did ("웹페이지 여는 중"). Older records do not have it */
  act?: string
  /** toolPlace: site address, "tool:…", "app" or "file" */
  place?: string
  ms?: number
}

export interface WorkGroup {
  /** What it is grouped by: card id, site domain, "app", "file", or none for work done inside Dool2 */
  key: string
  kind: 'web' | 'service' | 'app' | 'file' | 'doori'
  /** Service name ("네이버", "sparkplus.co.kr", "PC 앱") */
  title: string
  /** The connect card to put the logo on */
  cardId?: string
  /** Letter for the icon box (when there is no logo) */
  letter: string
  /** What was done in this place (in order, the same thing once) */
  acts: string[]
  /** What was done last */
  act: string
  /** Total time taken (undefined if unknown) */
  ms?: number
  /** Number of steps grouped */
  count: number
}

/** The shorter name: drops the leading www., m. and app. */
export function bareHost(host: string): string {
  return host.replace(/:\d+$/, '').replace(/^(www|m|app|mobile)\./, '')
}

/** The domain to group a site under: search.naver.com and m.naver.com -> naver.com, and shop.co.kr style names keep three parts */
export function baseDomain(host: string): string {
  const parts = bareHost(host).split('.')
  const n = /^(co|or|go|ne|ac|re|pe|com|net|org)$/.test(parts.at(-2) ?? '') && parts.length > 2 ? 3 : 2
  return parts.slice(-n).join('.')
}

/**
 * Site address -> connect card. Only the card's domain or addresses under it (the longest match).
 * google.com is not treated as the calendar.google.com card
 */
export function cardForHost(host: string, cards: PlaceCard[]): PlaceCard | undefined {
  const bare = bareHost(host)
  let best: PlaceCard | undefined
  for (const c of cards) {
    const site = c.site && bareHost(c.site)
    if (!site || !(bare === site || bare.endsWith(`.${site}`))) continue
    if (!best || site.length > bareHost(best.site ?? '').length) best = c
  }
  return best
}

/** Frequent places get a readable name even without a connect card (Korean names are the reference copy) */
const KNOWN_SITES: Record<Lang, Record<string, string>> = {
  ko: {
    'naver.com': '네이버',
    'google.com': '구글',
    'daum.net': '다음',
    'kakao.com': '카카오',
    'youtube.com': '유튜브',
    'wikipedia.org': '위키백과',
    'namu.wiki': '나무위키',
  },
  en: {
    'naver.com': 'Naver',
    'google.com': 'Google',
    'daum.net': 'Daum',
    'kakao.com': 'Kakao',
    'youtube.com': 'YouTube',
    'wikipedia.org': 'Wikipedia',
    'namu.wiki': 'Namuwiki',
  },
}

/** Service tool name (cj_logistics_track) -> connect card (the longest matching id) */
export function cardForTool(tool: string, cards: PlaceCard[]): PlaceCard | undefined {
  let best: PlaceCard | undefined
  for (const c of cards) {
    const prefix = `${c.id.replace(/-/g, '_')}_`
    if (tool.startsWith(prefix) && (!best || c.id.length > best.id.length)) best = c
  }
  return best
}

function firstLetter(name: string): string {
  return (/^\d+/.exec(name)?.[0] ?? [...name][0] ?? '').toUpperCase()
}

/** Which line a step goes into */
function where(
  place: string | undefined,
  cards: PlaceCard[],
  lang: Lang,
): Omit<WorkGroup, 'acts' | 'act' | 'ms' | 'count'> {
  if (!place) return { key: '', kind: 'doori', title: '', letter: '' }
  if (place === 'app')
    return { key: 'app', kind: 'app', title: lang === 'en' ? 'PC app' : 'PC 앱', letter: '' }
  if (place === 'file')
    return { key: 'file', kind: 'file', title: lang === 'en' ? 'Files' : '파일', letter: '' }
  if (place.startsWith('tool:')) {
    const tool = place.slice(5)
    const card = cardForTool(tool, cards)
    if (card)
      return {
        key: card.id,
        kind: 'service',
        title: card.name,
        cardId: card.id,
        letter: firstLetter(card.name),
      }
    const id = tool.split('_')[0] ?? tool
    return { key: id, kind: 'service', title: id, letter: firstLetter(id) }
  }
  const card = cardForHost(place, cards)
  if (card)
    return { key: card.id, kind: 'web', title: card.name, cardId: card.id, letter: firstLetter(card.name) }
  const base = baseDomain(place)
  const title = KNOWN_SITES[lang][base] ?? base
  return { key: base, kind: 'web', title, letter: firstLetter(title) }
}

/**
 * Groups the steps into lines: one line per place. Even when Dool2 moves between several tabs, the same site is one line,
 * and working there again moves that line to the bottom (the line being worked on now)
 */
export function groupSteps(steps: WorkStepIn[], cards: PlaceCard[] = [], lang: Lang = 'ko'): WorkGroup[] {
  const out: WorkGroup[] = []
  for (const s of steps) {
    const w = where(s.place, cards, lang)
    // Work done inside Dool2 (memory, finding a service, etc.) is titled by the self-talk; if it is only a tool name, that name
    const act = s.act ?? s.text
    // Older records (no act) stay one line per step.
    // For the same service, what was done on the site (web) and with service tools (service) is one line: both group by card id.
    // Counting the kind too split "롯데시네마" into two lines that stacked alternately, and the screen redraws lines by key so the old line was never removed (measured)
    const at = s.act === undefined ? -1 : out.findIndex((g) => g.key === w.key)
    const same = out[at]
    if (same) {
      same.acts = [...same.acts.filter((x) => x !== act), act]
      same.act = act
      if (w.kind === 'doori') same.title = s.text
      same.ms = same.ms !== undefined && s.ms !== undefined ? same.ms + s.ms : undefined
      same.count++
      out.splice(at, 1)
      out.push(same)
      continue
    }
    out.push({
      ...w,
      ...(w.kind === 'doori' ? { title: s.text } : {}),
      acts: [act],
      act,
      ...(s.ms !== undefined ? { ms: s.ms } : {}),
      count: 1,
    })
  }
  return out
}

/** "웹페이지 여는 중" -> "웹페이지 열기" (the small text of a finished line). English acts are already full phrases and stay as they are */
export function actDone(act: string, lang: Lang = 'ko'): string {
  if (lang === 'en') return act.trim()
  const stem = act.replace(/\s*중$/, '').trim()
  const m = /^(.*?)(\S+)는$/.exec(stem)
  if (!m) return stem
  const [, head = '', verb = ''] = m
  const irregular: Record<string, string> = { 여: '열', 만드: '만들', 거: '걸', 아: '알', 사: '살', 노: '놀' }
  const v = irregular[verb] ?? verb
  return `${head}${v}기`
}

/** The small text of a finished line: up to three things done, in noun form ("웹페이지 열기 · 페이지 읽기 · 누르기") */
export function doneLine(g: WorkGroup, lang: Lang = 'ko'): string {
  // Cleanup like closing a tab does not count as something done
  const names = [
    ...new Set(g.acts.filter((a) => !/^(?:탭 닫는|Closing a tab)/.test(a)).map((a) => actDone(a, lang))),
  ]
  if (names.length <= 3) return names.join(' · ')
  const rest = names.length - 3
  return `${names.slice(0, 3).join(' · ')}${lang === 'en' ? ` + ${rest} more` : ` 외 ${rest}개`}`
}

/**
 * The return summary (response UX): when the person comes back to the app after a while, what happened meanwhile,
 * from stored records only (no AI call). Real work only: tasks and routines that finished since they were last here
 * (the feed's "done" and "routine" entries; a question answered in the conversation is not one), approvals decided
 * meanwhile, approvals and sign-ins waiting for them, and when a waiting one runs out if they do not answer.
 * undefined when there is nothing to say
 */
export interface AwayIn {
  /** When the person was last looking (ms) */
  since: number
  now: number
  feed: readonly { kind: string; title: string; at: string; ref?: string }[]
  approvals: readonly {
    id: string
    status: string
    what?: string
    label: string
    amount?: string
    expiresAt: string
    decidedAt?: string
  }[]
  logins: readonly { id: string; status: string; site: string; expiresAt: string }[]
}

export interface AwaySummary {
  /** Tasks finished meanwhile (newest first, up to 3) and how many in all */
  done: { title: string; at: string; ref?: string }[]
  doneCount: number
  /** Approvals answered meanwhile, by the person on another screen or by auto-approve (newest first, up to 3) */
  decided: { id: string; title: string; approved: boolean; at: string }[]
  decidedCount: number
  /** Waiting for the person: what, and when it runs out if they do not answer (soonest first) */
  waiting: { kind: 'approval' | 'login'; id: string; title: string; expiresAt: string }[]
}

export function awaySummary(i: AwayIn): AwaySummary | undefined {
  const done = i.feed
    .filter((f) => (f.kind === 'done' || f.kind === 'routine') && Date.parse(f.at) > i.since)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  const live = (x: { status: string; expiresAt: string }) =>
    x.status === 'pending' && Date.parse(x.expiresAt) > i.now
  const titleOf = (a: AwayIn['approvals'][number]) =>
    [a.what || a.label, a.amount].filter(Boolean).join(' · ')
  const decided = i.approvals
    .filter((a) => a.decidedAt && a.status !== 'pending' && Date.parse(a.decidedAt) > i.since)
    .sort((a, b) => Date.parse(b.decidedAt ?? '') - Date.parse(a.decidedAt ?? ''))
  const waiting = [
    ...i.approvals.filter(live).map((a) => ({
      kind: 'approval' as const,
      id: a.id,
      title: titleOf(a),
      expiresAt: a.expiresAt,
    })),
    ...i.logins
      .filter(live)
      .map((l) => ({ kind: 'login' as const, id: l.id, title: l.site, expiresAt: l.expiresAt })),
  ].sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))
  if (!done.length && !decided.length && !waiting.length) return undefined
  return {
    done: done.slice(0, 3).map((f) => ({ title: f.title, at: f.at, ...(f.ref ? { ref: f.ref } : {}) })),
    doneCount: done.length,
    decided: decided.slice(0, 3).map((a) => ({
      id: a.id,
      title: titleOf(a),
      approved: a.status !== 'rejected',
      at: a.decidedAt ?? '',
    })),
    decidedCount: decided.length,
    waiting,
  }
}

/** How long the person must be away before the return summary shows */
export const AWAY_MIN_MS = 20 * 60_000
