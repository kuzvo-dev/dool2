// 이어 쓰기 제안 (입력칸의 흐린 나머지): 지금 쓰는 말의 앞부분이 같은 후보 중 대화 맥락에 맞는 것 하나.
// 순서: 방금 두리 답에서 나온 이어 말 > 최근 대화와 겹치는 아이디어 > 나머지.
// 최근 대화가 있는데 하나도 겹치지 않는 아이디어는 보여 주지 않는다 (엉뚱한 추천보다 없는 게 낫다).
import { readAppNote } from '@dool2/protocol/rich'

/** 이 시간 안의 대화를 "최근 대화"로 본다 */
export const FRESH_MS = 30 * 60_000

export interface GhostTalk {
  /** 마지막 두리 답 */
  reply?: string
  /** 마지막 내 말 (앱 알림은 빼고) */
  ask?: string
  /** 둘 중 나중 말의 시각 (ms) */
  at?: number
}

export interface GhostInput {
  /** 지금 입력칸에 쓴 말 */
  draft: string
  talk?: GhostTalk
  /** 나에게 맞춰 찾은 아이디어 */
  mine?: readonly string[]
  /** 아이디어 카탈로그 */
  catalog?: readonly string[]
  now?: number
}

/** 대화에서 마지막 두리 답과 마지막 내 말을 고른다 (앱 알림은 내 말이 아니라서 뺀다) */
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

/** 쓰는 말에 이어 붙일 나머지. 없으면 '' */
export function ghostRest(input: GhostInput): string {
  const d = input.draft.trimStart()
  if (d.length < 2 || d.includes('\n')) return ''
  const hit = ghostCandidates(input).find((t) => t.startsWith(d) && t.length > d.length)
  return hit ? hit.slice(d.length) : ''
}

/** 이어 쓰기 후보를 점수 순서로 (앞부분이 쓰는 말과 같은 것만) */
export function ghostCandidates(input: GhostInput): string[] {
  const d = input.draft.trimStart()
  const now = input.now ?? Date.now()
  const talk = input.talk ?? {}
  const fresh = talk.at !== undefined && now - talk.at <= FRESH_MS && Boolean(talk.reply || talk.ask)
  const starts = (t: string) => t.startsWith(d) && t.length > d.length
  const ideas = unique([...(input.mine ?? []), ...(input.catalog ?? [])]).filter(starts)
  if (!fresh) return ideas
  const fromTalk = talkFollowUps(talk).filter(starts)
  const said = bigrams(`${talk.reply ?? ''} ${talk.ask ?? ''}`)
  const own = bigrams(d)
  const scored = ideas
    .map((text, i) => {
      let score = 0
      for (const b of bigrams(text)) if (!own.has(b) && said.has(b)) score++
      return { text, i, score }
    })
    // 최근 대화와 하나도 겹치지 않으면 뺀다
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.text)
  return unique([...fromTalk, ...scored])
}

// ── 두리 답에서 이어 말 만들기 ──

type Topic = 'food' | 'shop' | 'trip'

const TOPICS: { id: Topic; test: RegExp; asks: string[] }[] = [
  {
    id: 'food',
    test: /식당|맛집|레스토랑|카페|브런치|오마카세|코스 ?요리|메뉴|기념일|디너|런치/,
    asks: ['예약 가능한 시간 알아봐 줘', '예약까지 해 줘', '가는 길 알려 줘', '다른 곳도 더 찾아 줘'],
  },
  {
    id: 'shop',
    test: /최저가|가격|상품|장바구니|배송|할인|구매|주문|쇼핑/,
    asks: ['제일 싼 곳으로 담아 줘', '후기 좋은 걸로 골라 줘', '가격 내려가면 알려 줘'],
  },
  {
    id: 'trip',
    test: /호텔|숙소|펜션|리조트|숙박|항공권|비행기|기차|KTX|SRT|여행/,
    asks: ['예약 가능한 날짜 알아봐 줘', '더 싼 날짜도 찾아 줘', '예약까지 해 줘'],
  },
]

/** 답 주제: 두리 답을 먼저 보고, 없으면 내 말 */
export function talkTopic(talk: GhostTalk): Topic | undefined {
  for (const text of [talk.reply, talk.ask]) {
    if (!text) continue
    const hit = TOPICS.find((t) => t.test.test(text))
    if (hit) return hit.id
  }
  return undefined
}

/** 답에 굵게 쓴 이름 (가게·상품 이름 등). 제목·값·문장처럼 보이는 건 뺀다 */
export function boldNames(reply: string): string[] {
  const out: string[] = []
  for (const m of reply.matchAll(/\*\*([^*\n]{1,24})\*\*/g)) {
    const name = (m[1] ?? '').trim().replace(/[.,!?·:]+$/, '')
    if (name.length < 2 || name.length > 16) continue
    if (/^[\d\s.,~%원분시개명박일:/-]+$/.test(name)) continue // 값 (3만 원, 19:00)
    if (/^\d/.test(name) && /[원분시개명박일]$/.test(name)) continue
    if (name.split(/\s+/).length > 3) continue // 문장
    if (/(요|다|죠|니다)$/.test(name)) continue // 말끝
    if (/[:：]/.test((m[1] ?? '').trim().slice(-1))) continue // "주의:" 같은 머리말
    if (!out.includes(name)) out.push(name)
    if (out.length >= 4) break
  }
  return out
}

/** 대화에서 나온 이어 말: 굵은 이름으로 한 줄씩, 그다음 주제에 맞는 말 */
export function talkFollowUps(talk: GhostTalk): string[] {
  const topic = talkTopic(talk)
  const names = talk.reply ? boldNames(talk.reply) : []
  const out: string[] = []
  for (const n of names) {
    if (topic === 'food' || topic === 'trip') out.push(`${n} 예약해 줘`)
    if (topic === 'shop') out.push(`${n}${josa(n, '을', '를')} 장바구니에 담아 줘`)
    out.push(`${n} 더 자세히 알려 줘`)
    if (topic === 'food') out.push(`${n}${josa(n, '이', '가')} 몇 시까지 하는지 알려 줘`)
  }
  const asks = TOPICS.find((t) => t.id === topic)?.asks ?? []
  return unique([...out, ...asks, ...(talk.reply ? ['더 자세히 알려 줘'] : [])])
}

// ── 조사 ──

const DIGIT_BATCHIM = new Set(['0', '1', '3', '6', '7', '8']) // 영·일·삼·육·칠·팔

/** 받침이 있으면 withB, 없으면 withoutB (을/를, 이/가, 은/는, 과/와) */
export function josa(word: string, withB: string, withoutB: string): string {
  return hasBatchim(word) ? withB : withoutB
}

export function hasBatchim(word: string): boolean {
  const ch = word
    .trim()
    .replace(/[)\]'"”’]+$/, '')
    .slice(-1)
  if (!ch) return false
  const code = ch.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0
  if (/\d/.test(ch)) return DIGIT_BATCHIM.has(ch)
  // 영어 이름: l·m·n으로 끝나면 받침 소리 (Apple → 애플을은 못 맞추니 흔한 경우만)
  return /[lmn]/i.test(ch)
}

// ── 글자 두 개 묶음 ──

/** 낱말 안의 두 글자 묶음 (자주 쓰는 동사·어미 묶음은 뺀다) */
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

const STOP = new Set([
  '알려',
  '찾아',
  '정리',
  '리해',
  '만들',
  '들어',
  '해요',
  '어요',
  '에요',
  '이에',
  '세요',
  '주세',
  '있어',
  '있는',
  '하는',
  '해서',
  '에서',
  '으로',
  '드릴',
  '릴게',
  '게요',
  '봐요',
  '까요',
  '이번',
  '지금',
])

function unique(list: readonly string[]): string[] {
  return [...new Set(list.map((t) => t.trim()).filter(Boolean))]
}

// ── 화면: 흐린 글자를 입력칸 글자와 정확히 겹치게 ──

/** 축약형(font·padding)은 롱핸드가 하나라도 기본값이 아니면 빈 값이 돼서(Chrome) 하나씩 옮긴다 */
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

/** from(입력칸)의 글꼴·줄 높이·안쪽 여백·테두리 두께를 target에 그대로 (테두리는 투명) */
export function matchTextBox(target: HTMLElement, from: HTMLElement): void {
  const cs = getComputedStyle(from)
  for (const k of TEXT_BOX) target.style[k] = cs[k]
  target.style.boxSizing = cs.boxSizing
  target.style.borderStyle = 'solid'
  target.style.borderColor = 'transparent'
}
