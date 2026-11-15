// 폰 앱: 피드 · 목표 · 보관함 탭과 그 상세 시트, 두리 판의 예정·기억 칸.
// 데이터는 PC 본체의 생활 기록(LifeState)이고, 바꾸는 일은 life-action으로 보낸다.
import {
  type FeedItem,
  GOAL_CATEGORIES,
  type GoalCategory,
  type LibraryItem,
  type LifeAction,
  type LifeState,
  type Routine,
} from '@dool2/protocol'
import { scheduleLabel } from '@dool2/protocol/schedule'
import { doori, h, type IconName, icon, rich, segBtn, shortTime } from './dom.js'

export interface LifeCtx {
  life?: LifeState
  online: boolean
  act(a: LifeAction): void
  /** 바로 대화로 보내기 */
  ask(text: string): void
  /** 대화 입력칸에 넣고 대화 탭으로 */
  fill(text: string): void
  openGoal(id: string): void
  openItem(id: string): void
  close(): void
  /** 피드 맨 위 "나를 기다려요·지금 하는 일" (승인·로그인·진행) */
  waiting: HTMLElement[]
  /** 보관함 칸: 만든 것 / 사진·파일 */
  librarySeg: 'made' | 'media'
  setLibrarySeg(seg: 'made' | 'media'): void
}

const FEED_KIND: Record<FeedItem['kind'], { label: string; icon: IconName; tone: string }> = {
  post: { label: '두리 소식', icon: 'feed', tone: 'blue' },
  done: { label: '끝낸 일', icon: 'check', tone: 'mint' },
  routine: { label: '알아서 한 일', icon: 'clock', tone: 'violet' },
  saved: { label: '보관함', icon: 'bookmark', tone: 'amber' },
  goal: { label: '목표', icon: 'goal', tone: 'rose' },
  connected: { label: '연결', icon: 'link', tone: 'blue' },
  suggest: { label: '제안', icon: 'idea', tone: 'amber' },
}

const CATEGORY: Record<GoalCategory, { icon: IconName; tone: string; hint: string }> = {
  건강: { icon: 'heart', tone: 'rose', hint: '운동·잠·식단' },
  관계: { icon: 'mail', tone: 'violet', hint: '가족·친구 챙기기' },
  돈: { icon: 'card', tone: 'mint', hint: '저축·지출 줄이기' },
  일: { icon: 'pc', tone: 'blue', hint: '업무·이직·공부' },
  관심사: { icon: 'star', tone: 'amber', hint: '취미·여행·배우기' },
  생산성: { icon: 'list', tone: 'blue', hint: '습관·정리·루틴' },
  기타: { icon: 'goal', tone: 'mint', hint: '무엇이든' },
}

/** 답·글에서 굵게 표시를 빼고 한 줄로 */
export function plain(text: string, max = 120) {
  const t = text
    .replace(/\*\*/g, '')
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function header(title: string, sub?: string) {
  return [h('h1', { class: 'ptitle', text: title }), sub ? h('p', { class: 'psub', text: sub }) : undefined]
}

function empty(mood: string, title: string, sub: string) {
  return h(
    'div',
    { class: 'empty' },
    doori(mood, 64),
    h('strong', { text: title }),
    h('span', { class: 'meta', text: sub }),
  )
}

// ── 피드 ──

export function feedView(ctx: LifeCtx): HTMLElement {
  const box = h('section', { class: 'tab-page feed' }, ...header('피드'))
  // 피드 지시: 무엇을 올릴지 말로 정한다
  const prompt = ctx.life?.feedPrompt
  const input = h('input', { class: 'field' })
  input.id = 'feed-prompt'
  input.placeholder = prompt ? '바꿀 내용을 적어 주세요' : '예: 매일 아침 날씨·일정·오는 택배'
  const save = h('button', { class: 'btn small', text: prompt ? '바꾸기' : '받기' })
  save.type = 'submit'
  const form = h('form', { class: 'feed-form' }, input, save)
  form.onsubmit = (e) => {
    e.preventDefault()
    const t = input.value.trim()
    if (!t) return
    ctx.act({ action: 'feed-prompt', text: t })
    input.value = ''
  }
  box.append(
    h(
      'div',
      { class: 'card feed-prompt' },
      h('div', { class: 'card-label' }, doori('', 22), '어떤 소식을 받을까요?'),
      prompt
        ? h(
            'p',
            { class: 'card-text' },
            h('strong', { text: prompt }),
            h('span', { class: 'meta', text: ' · 매일 오전 7:30에 올려요' }),
          )
        : h('p', { class: 'meta', text: '적어 두면 두리가 매일 아침 찾아서 짧게 정리해 올려요.' }),
      form,
      prompt
        ? h('button', {
            class: 'btn-text small',
            text: '그만 받기',
            onclick: () => ctx.act({ action: 'feed-prompt', text: '' }),
          })
        : undefined,
    ),
  )
  if (ctx.waiting.length) box.append(...ctx.waiting)
  const items = ctx.life?.feed ?? []
  if (!ctx.life) box.append(h('p', { class: 'wait' }, h('span', { class: 'spin' }), 'PC에서 받는 중…'))
  else if (!items.length)
    box.append(
      empty(
        'sleeping',
        '아직 올라온 소식이 없어요',
        '두리가 한 일과 알아서 한 일, 받기로 한 소식이 여기에 모여요.',
      ),
    )
  let day = ''
  for (const f of items) {
    const d = dayLabel(f.at)
    if (d !== day) {
      day = d
      box.append(h('h2', { class: 'over', text: d }))
    }
    box.append(feedCard(ctx, f))
  }
  return box
}

function feedCard(ctx: LifeCtx, f: FeedItem) {
  const k = FEED_KIND[f.kind] ?? FEED_KIND.post
  const long = f.kind === 'post' || f.kind === 'routine'
  const body = h('div', { class: long ? 'feed-body clamp' : 'feed-body' })
  if (f.body) body.append(long ? rich(f.body) : plain(f.body, 160))
  // 긴 글은 접어 두고 누르면 펼친다
  if (long) body.onclick = () => body.classList.toggle('open')
  const react = (r: 'up' | 'down') => () =>
    ctx.act({ action: 'feed-react', id: f.id, ...(f.reaction === r ? {} : { reaction: r }) })
  return h(
    'article',
    { class: 'card feed-card' },
    h(
      'div',
      { class: 'feed-head' },
      h('span', { class: `tile sm ${k.tone}` }, icon(k.icon, 'i')),
      h('span', { class: 'meta', text: k.label }),
      h('span', { class: 'meta feed-time', text: shortTime(f.at) }),
    ),
    h('strong', { class: 'feed-title', text: f.title }),
    f.body ? body : undefined,
    h(
      'div',
      { class: 'feed-actions' },
      h(
        'button',
        { class: f.reaction === 'up' ? 'chip on' : 'chip', label: '좋아요', onclick: react('up') },
        icon('up'),
      ),
      h(
        'button',
        { class: f.reaction === 'down' ? 'chip on' : 'chip', label: '별로예요', onclick: react('down') },
        icon('down'),
      ),
      h(
        'button',
        {
          class: 'chip',
          onclick: () => ctx.fill(`"${plain(f.title, 40)}" 이야기인데요, `),
        },
        icon('reply'),
        '이어서 말하기',
      ),
    ),
  )
}

function dayLabel(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const diff = Math.round(
    (new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000,
  )
  if (diff <= 0) return '오늘'
  if (diff === 1) return '어제'
  return d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })
}

// ── 목표 ──

export function whenText(r: Routine) {
  if (!r.enabled) return '꺼 둠'
  if (!r.schedule) return '정한 때 없음'
  const next = r.nextRunAt ? ` · 다음 ${nextText(r.nextRunAt)}` : ''
  return `${scheduleLabel(r.schedule)}${next}`
}

function nextText(iso: string) {
  const d = new Date(iso)
  const now = new Date()
  const days = Math.round(
    (new Date(d.toDateString()).getTime() - new Date(now.toDateString()).getTime()) / 86_400_000,
  )
  const t = d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })
  if (days === 0) return `오늘 ${t}`
  if (days === 1) return `내일 ${t}`
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${t}`
}

export function goalsView(ctx: LifeCtx): HTMLElement {
  const box = h(
    'section',
    { class: 'tab-page goals' },
    ...header('목표', '두리가 알아서 챙기고, 때가 되면 먼저 알려 줘요'),
  )
  const list = (ctx.life?.routines ?? []).filter((r) => !(r.target === 'feed' && r.title === '피드'))
  const goals = list.filter((r) => r.category)
  const routines = list.filter((r) => !r.category)
  if (!ctx.life) box.append(h('p', { class: 'wait' }, h('span', { class: 'spin' }), 'PC에서 받는 중…'))
  if (goals.length) {
    box.append(h('h2', { class: 'over', text: '진행 중인 목표' }))
    for (const g of goals) box.append(goalCard(ctx, g))
  }
  if (routines.length) {
    box.append(h('h2', { class: 'over', text: '알아서 하는 일' }))
    for (const r of routines) box.append(goalCard(ctx, r))
  }
  if (ctx.life && !list.length)
    box.append(
      h(
        'div',
        { class: 'card ask-card' },
        h('div', { class: 'card-label' }, doori('', 22), '대화로 말하면 돼요'),
        h('p', {
          class: 'card-text',
          text: '"매일 아침 7시 반에 날씨랑 일정 알려 줘", "주 3회 운동하고 싶어"처럼 말하면 두리가 목표와 일정을 만들어요.',
        }),
      ),
    )
  box.append(h('h2', { class: 'over', text: '목표 만들기' }))
  const grid = h('div', { class: 'goal-grid' })
  for (const c of GOAL_CATEGORIES) {
    const k = CATEGORY[c]
    grid.append(
      h(
        'button',
        { class: 'goal-tile', onclick: () => ctx.fill(`${c} 목표를 세우고 싶어요: `) },
        h('span', { class: `tile ${k.tone}` }, icon(k.icon, 'i md')),
        h(
          'span',
          { class: 'row-text' },
          h('span', { class: 'row-t', text: c }),
          h('span', { class: 'row-d', text: k.hint }),
        ),
        icon('plus', 'i plus'),
      ),
    )
  }
  box.append(grid)
  box.append(h('h2', { class: 'over', text: '이런 것도 맡겨 보세요' }))
  for (const [t, note] of [
    ['매일 아침 7시 반에 날씨·일정·오는 택배 알려 줘', '아침 브리핑'],
    ['매주 월요일 아침에 지난주 카드 쓴 돈 정리해 줘', '주간 가계부'],
    ['매달 25일에 이번 달 휴대폰 요금 확인해 줘', '요금 확인'],
    ['KTX 금요일 저녁 부산 가는 표, 취소표 나오면 알려 줘', '취소표 지켜보기'],
  ] as const)
    box.append(
      h(
        'button',
        { class: 'idea', onclick: () => ctx.ask(t) },
        h('span', { class: 'tile violet' }, icon('clock', 'i md')),
        h(
          'span',
          { class: 'row-text' },
          h('span', { class: 'row-t', text: t }),
          h('span', { class: 'row-d', text: note }),
        ),
      ),
    )
  return box
}

function bar(ratio: number) {
  const i = h('i')
  i.style.width = `${Math.round(ratio * 100)}%`
  return h('span', { class: 'bar' }, i)
}

function goalCard(ctx: LifeCtx, r: Routine) {
  const k = r.category ? CATEGORY[r.category] : undefined
  const done = r.plan?.filter((p) => p.done).length ?? 0
  const total = r.plan?.length ?? 0
  const sw = h('button', {
    class: r.enabled ? 'switch on' : 'switch',
    label: r.enabled ? '끄기' : '켜기',
    onclick: (e) => {
      e.stopPropagation()
      ctx.act({ action: 'routine-toggle', id: r.id, on: !r.enabled })
    },
  })
  sw.setAttribute('role', 'switch')
  sw.setAttribute('aria-checked', String(r.enabled))
  return h(
    'div',
    { class: r.enabled ? 'card goal-card' : 'card goal-card off', onclick: () => ctx.openGoal(r.id) },
    h(
      'div',
      { class: 'goal-head' },
      h('span', { class: `tile ${k?.tone ?? 'violet'}` }, icon(k?.icon ?? 'clock', 'i md')),
      h(
        'span',
        { class: 'row-text' },
        h('span', { class: 'row-t', text: r.title }),
        h('span', { class: 'row-d', text: [r.category, whenText(r)].filter(Boolean).join(' · ') }),
      ),
      sw,
    ),
    total
      ? h(
          'div',
          { class: 'goal-progress' },
          bar(total ? done / total : 0),
          h('span', { class: 'meta', text: `계획 ${done}/${total}` }),
        )
      : undefined,
    r.lastResult
      ? h('p', { class: 'meta goal-last', text: `지난번: ${plain(r.lastResult, 90)}` })
      : undefined,
  )
}

/** 목표 상세 (시트) */
export function goalSheet(ctx: LifeCtx, id: string): HTMLElement {
  const sheet = h('section', { class: 'sheet float app-sheet rise goal-sheet' })
  const r = ctx.life?.routines.find((x) => x.id === id)
  if (!r) return sheet
  const k = r.category ? CATEGORY[r.category] : undefined
  sheet.append(
    h('button', { class: 'fbtn small sheet-x', label: '닫기', onclick: ctx.close }, icon('close')),
    h(
      'div',
      { class: 'approve-head' },
      h('span', { class: `tile ${k?.tone ?? 'violet'}` }, icon(k?.icon ?? 'clock', 'i md')),
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: r.title }),
        h('span', { class: 'meta', text: [r.category ?? '알아서 하는 일', whenText(r)].join(' · ') }),
      ),
    ),
  )
  if (r.plan?.length) {
    const ul = h('ul', { class: 'plan' })
    r.plan.forEach((p, i) => {
      const b = h(
        'button',
        {
          class: p.done ? 'plan-step done' : 'plan-step',
          onclick: () => ctx.act({ action: 'goal-step', id: r.id, index: i, done: !p.done }),
        },
        h('span', { class: 'check' }, p.done ? icon('check') : undefined),
        h('span', { text: p.text }),
      )
      ul.append(h('li', {}, b))
    })
    sheet.append(h('h2', { class: 'over', text: '계획' }), ul)
  }
  sheet.append(
    h('h2', { class: 'over', text: '두리가 할 일' }),
    h('p', { class: 'card-text', text: r.prompt }),
  )
  if (r.log?.length) {
    sheet.append(h('h2', { class: 'over', text: '진행 기록' }))
    for (const l of r.log.slice(0, 8))
      sheet.append(
        h(
          'p',
          { class: 'log-line' },
          h('span', { class: 'meta', text: shortTime(l.at) }),
          plain(l.text, 200),
        ),
      )
  } else if (r.lastResult)
    sheet.append(
      h('h2', { class: 'over', text: '지난 결과' }),
      h('p', { class: 'card-text', text: plain(r.lastResult, 300) }),
    )
  sheet.append(
    h(
      'div',
      { class: 'sheet-actions' },
      h(
        'button',
        { class: 'btn', onclick: () => (ctx.act({ action: 'routine-run', id: r.id }), ctx.close()) },
        icon('play'),
        r.category ? '지금 체크인' : '지금 해 보기',
      ),
      h(
        'button',
        { class: 'btn-ghost', onclick: () => ctx.fill(`"${r.title}" 목표 말인데요, `) },
        icon('reply'),
        '대화에서 이어 하기',
      ),
    ),
    h(
      'div',
      { class: 'sheet-actions' },
      h('button', {
        class: 'btn-text',
        text: r.enabled ? '잠시 끄기' : '다시 켜기',
        onclick: () => ctx.act({ action: 'routine-toggle', id: r.id, on: !r.enabled }),
      }),
      h('button', {
        class: 'btn-text danger',
        text: '지우기',
        onclick: () => {
          if (confirm(`"${r.title}"을 지울까요?`)) {
            ctx.act({ action: 'routine-delete', id: r.id })
            ctx.close()
          }
        },
      }),
    ),
  )
  return sheet
}

// ── 보관함 ──

const ITEM: Record<LibraryItem['kind'], { icon: IconName; tone: string; label: string }> = {
  note: { icon: 'note', tone: 'blue', label: '정리' },
  link: { icon: 'link', tone: 'violet', label: '링크' },
  product: { icon: 'cart', tone: 'amber', label: '상품' },
  place: { icon: 'place', tone: 'rose', label: '장소' },
  file: { icon: 'image', tone: 'mint', label: '파일' },
}

export function libraryView(ctx: LifeCtx): HTMLElement {
  const box = h('section', { class: 'tab-page library' }, ...header('보관함'))
  const seg = h('div', { class: 'seg' })
  for (const [id, label] of [
    ['made', '만든 것'],
    ['media', '사진·파일'],
  ] as const)
    seg.append(
      segBtn(ctx.librarySeg === id, {
        text: label,
        onclick: () => ctx.setLibrarySeg(id),
      }),
    )
  box.append(seg)
  const all = ctx.life?.library ?? []
  const list = all.filter((x) => (ctx.librarySeg === 'media' ? x.kind === 'file' : x.kind !== 'file'))
  if (!ctx.life) box.append(h('p', { class: 'wait' }, h('span', { class: 'spin' }), 'PC에서 받는 중…'))
  else if (!list.length)
    box.append(
      empty(
        '',
        ctx.librarySeg === 'media' ? '아직 사진·파일이 없어요' : '아직 남긴 게 없어요',
        ctx.librarySeg === 'media'
          ? '두리가 만든 파일과 받은 사진이 여기에 모여요.'
          : '두리가 찾아 준 상품, 정리한 글, 링크를 남겨 두면 여기에 모여요. 답을 길게 누르면 남길 수 있어요.',
      ),
    )
  for (const it of list) {
    const k = ITEM[it.kind]
    box.append(
      h(
        'button',
        { class: 'card lib-card', onclick: () => ctx.openItem(it.id) },
        h('span', { class: `tile ${k.tone}` }, icon(k.icon, 'i md')),
        h(
          'span',
          { class: 'row-text' },
          h('span', { class: 'row-t', text: it.title }),
          h('span', { class: 'row-d', text: plain(it.body, 70) || hostOf(it.url) }),
          h('span', {
            class: 'meta',
            text: [k.label, it.price, shortTime(it.savedAt)].filter(Boolean).join(' · '),
          }),
        ),
      ),
    )
  }
  return box
}

export function itemSheet(ctx: LifeCtx, id: string): HTMLElement {
  const sheet = h('section', { class: 'sheet float app-sheet rise item-sheet' })
  const it = ctx.life?.library.find((x) => x.id === id)
  if (!it) return sheet
  const k = ITEM[it.kind]
  const body = h('div', { class: 'item-body bubble rich' })
  body.append(rich(it.body))
  sheet.append(
    h('button', { class: 'fbtn small sheet-x', label: '닫기', onclick: ctx.close }, icon('close')),
    h(
      'div',
      { class: 'approve-head' },
      h('span', { class: `tile ${k.tone}` }, icon(k.icon, 'i md')),
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: it.title }),
        h('span', {
          class: 'meta',
          text: [k.label, it.price, shortTime(it.savedAt)].filter(Boolean).join(' · '),
        }),
      ),
    ),
    ...(it.body ? [body] : []),
    h(
      'div',
      { class: 'sheet-actions' },
      it.url ? h('a', { class: 'btn' }, icon('link'), `${hostOf(it.url)} 열기`) : undefined,
      h(
        'button',
        { class: 'btn-ghost', onclick: () => ctx.fill(`보관함의 "${it.title}" 말인데요, `) },
        icon('reply'),
        '이어서 말하기',
      ),
    ),
    h('button', {
      class: 'btn-text danger',
      text: '보관함에서 지우기',
      onclick: () => {
        ctx.act({ action: 'library-delete', id: it.id })
        ctx.close()
      },
    }),
  )
  const a = sheet.querySelector('a.btn') as HTMLAnchorElement | null
  if (a && it.url) {
    a.href = it.url
    a.target = '_blank'
    a.rel = 'noopener'
  }
  return sheet
}

function hostOf(url?: string) {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

// ── 두리 판: 예정 · 기억 ──

export function upcomingSeg(ctx: LifeCtx): HTMLElement[] {
  const list = (ctx.life?.routines ?? [])
    .filter((r) => r.enabled && r.nextRunAt)
    .sort((a, b) => Date.parse(a.nextRunAt ?? '') - Date.parse(b.nextRunAt ?? ''))
  if (!list.length)
    return [
      h('p', {
        class: 'meta seg-empty',
        text: '예정된 일이 없어요. "내일 10시에 알려 줘"처럼 말하면 여기에 보여요.',
      }),
    ]
  return list.map((r) =>
    h(
      'button',
      { class: 'act-row', onclick: () => ctx.openGoal(r.id) },
      h('span', { class: 'tile sm violet' }, icon('clock', 'i')),
      h(
        'span',
        { class: 'row-text' },
        h('span', { class: 'row-t', text: r.title }),
        h('span', { class: 'row-d', text: r.schedule ? scheduleLabel(r.schedule) : '' }),
      ),
      h('span', { class: 'meta', text: r.nextRunAt ? nextText(r.nextRunAt) : '' }),
    ),
  )
}

export function memorySeg(ctx: LifeCtx): HTMLElement[] {
  const out: HTMLElement[] = []
  const input = h('input', { class: 'field' })
  input.id = 'memory-add'
  input.placeholder = '두리가 알아 두면 좋은 것 (예: 아이가 초3이에요)'
  const add = h('button', { class: 'btn small', text: '기억하기' })
  add.type = 'submit'
  const form = h('form', { class: 'feed-form' }, input, add)
  form.onsubmit = (e) => {
    e.preventDefault()
    const t = input.value.trim()
    if (!t) return
    ctx.act({ action: 'memory-add', text: t })
    input.value = ''
  }
  out.push(
    h('p', {
      class: 'meta seg-note',
      text: '두리가 대화하며 알게 된 것이에요. 틀린 건 지우면 다음 대화부터 잊어요. 이 PC에만 저장돼요.',
    }),
    form,
  )
  const list = ctx.life?.memory ?? []
  if (!list.length) out.push(h('p', { class: 'meta seg-empty', text: '아직 기억한 게 없어요.' }))
  for (const m of list)
    out.push(
      h(
        'div',
        { class: 'act-row' },
        h('span', { class: 'tile sm mint' }, icon('brain', 'i')),
        h(
          'span',
          { class: 'row-text' },
          h('span', { class: 'row-t', text: m.text }),
          h('span', {
            class: 'row-d',
            text: `${m.source === 'user' ? '직접 적음' : '대화에서'} · ${shortTime(m.at)}`,
          }),
        ),
        h(
          'button',
          {
            class: 'fbtn small',
            label: '잊기',
            onclick: () => ctx.act({ action: 'memory-delete', id: m.id }),
          },
          icon('trash'),
        ),
      ),
    )
  return out
}
