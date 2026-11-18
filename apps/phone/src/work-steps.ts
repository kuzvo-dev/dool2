// 일하는 카드의 단계를 서비스별 줄로 묶는다 (화면 없이 테스트할 수 있게 따로 둔다).
// 같은 곳(사이트·서비스 도구·PC 앱·파일)에서 연달아 한 일은 한 줄: 제목은 서비스 이름, 아래 작은 글씨는 하는 일.
// "웹페이지 여는 중"·"누르는 중" 같은 도구 이름만 있는 단계는 따로 줄을 만들지 않는다.

/** 연결 카드에서 필요한 것만 */
export interface PlaceCard {
  id: string
  name: string
  site?: string
}

export interface WorkStepIn {
  /** 혼잣말 한 줄이나 도구 이름 */
  text: string
  /** 도구가 한 일 ("웹페이지 여는 중"). 예전 기록에는 없다 */
  act?: string
  /** toolPlace: 사이트 주소·"tool:…"·"app"·"file" */
  place?: string
  ms?: number
}

export interface WorkGroup {
  /** 묶는 기준: 카드 id, 사이트 도메인, "app", "file", 없으면 두리 안에서 한 일 */
  key: string
  kind: 'web' | 'service' | 'app' | 'file' | 'doori'
  /** 서비스 이름 ("네이버", "sparkplus.co.kr", "PC 앱") */
  title: string
  /** 로고를 얹을 연결 카드 */
  cardId?: string
  /** 아이콘 칸 글자 (로고가 없을 때) */
  letter: string
  /** 이 곳에서 한 일들 (순서대로, 같은 건 한 번) */
  acts: string[]
  /** 마지막으로 한 일 */
  act: string
  /** 걸린 시간 합 (모르면 undefined) */
  ms?: number
  /** 묶인 단계 수 */
  count: number
}

/** 시작 시각 없이 "더 짧은" 이름: 앞의 www.·m.·app.을 뗀다 */
export function bareHost(host: string): string {
  return host.replace(/:\d+$/, '').replace(/^(www|m|app|mobile)\./, '')
}

/** 같은 사이트로 묶을 도메인: search.naver.com·m.naver.com → naver.com, shop.co.kr 계열은 셋째까지 */
export function baseDomain(host: string): string {
  const parts = bareHost(host).split('.')
  const n = /^(co|or|go|ne|ac|re|pe|com|net|org)$/.test(parts.at(-2) ?? '') && parts.length > 2 ? 3 : 2
  return parts.slice(-n).join('.')
}

/**
 * 사이트 주소 → 연결 카드. 카드 도메인과 같거나 그 아래 주소만 (가장 길게 맞는 것).
 * google.com을 calendar.google.com 카드로 보지 않는다
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

/** 연결 카드가 없어도 자주 들르는 곳은 한글 이름으로 */
const KNOWN_SITES: Record<string, string> = {
  'naver.com': '네이버',
  'google.com': '구글',
  'daum.net': '다음',
  'kakao.com': '카카오',
  'youtube.com': '유튜브',
  'wikipedia.org': '위키백과',
  'namu.wiki': '나무위키',
}

/** 서비스 도구 이름(cj_logistics_track) → 연결 카드 (가장 길게 맞는 id) */
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

/** 한 단계가 어느 줄에 들어가는지 */
function where(
  place: string | undefined,
  cards: PlaceCard[],
): Omit<WorkGroup, 'acts' | 'act' | 'ms' | 'count'> {
  if (!place) return { key: '', kind: 'doori', title: '', letter: '' }
  if (place === 'app') return { key: 'app', kind: 'app', title: 'PC 앱', letter: '' }
  if (place === 'file') return { key: 'file', kind: 'file', title: '파일', letter: '' }
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
  const title = KNOWN_SITES[base] ?? base
  return { key: base, kind: 'web', title, letter: firstLetter(title) }
}

/**
 * 단계들을 줄로 묶는다: 곳마다 한 줄. 두리가 탭 여러 개를 오가도 같은 사이트는 한 줄이고,
 * 다시 그 곳에서 일하면 그 줄이 맨 아래(지금 하는 줄)로 내려온다
 */
export function groupSteps(steps: WorkStepIn[], cards: PlaceCard[] = []): WorkGroup[] {
  const out: WorkGroup[] = []
  for (const s of steps) {
    const w = where(s.place, cards)
    // 두리 안에서 한 일(기억·서비스 찾기 등)은 혼잣말이 제목. 도구 이름뿐이면 그 이름
    const act = s.act ?? s.text
    // 예전 기록(act 없음)은 단계마다 한 줄 그대로
    const at = s.act === undefined ? -1 : out.findIndex((g) => g.key === w.key && g.kind === w.kind)
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

/** "웹페이지 여는 중" → "웹페이지 열기" (끝난 줄의 작은 글씨) */
export function actDone(act: string): string {
  const stem = act.replace(/\s*중$/, '').trim()
  const m = /^(.*?)(\S+)는$/.exec(stem)
  if (!m) return stem
  const [, head = '', verb = ''] = m
  const irregular: Record<string, string> = { 여: '열', 만드: '만들', 거: '걸', 아: '알', 사: '살', 노: '놀' }
  const v = irregular[verb] ?? verb
  return `${head}${v}기`
}

/** 끝난 줄의 작은 글씨: 한 일을 이름꼴로 셋까지 ("웹페이지 열기 · 페이지 읽기 · 누르기") */
export function doneLine(g: WorkGroup): string {
  // 탭 닫기 같은 뒷정리는 한 일로 치지 않는다
  const names = [...new Set(g.acts.filter((a) => !/^탭 닫는/.test(a)).map(actDone))]
  return names.length > 3 ? `${names.slice(0, 3).join(' · ')} 외 ${names.length - 3}개` : names.join(' · ')
}
