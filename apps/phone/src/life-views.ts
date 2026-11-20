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
import type { Pager } from '@dool2/protocol/paging'
import { resultLine, stripLinks, withoutPhotoMark } from '@dool2/protocol/rich'
import { ruleLabel, scheduleLabel } from '@dool2/protocol/schedule'
import { doori, emoTile, h, type IconName, icon, rich, segBtn, shortTime } from './dom.js'
import { burst, drawCheck, rememberFlip, springHeight } from './motion.js'
import { statCard } from './motion-cards.js'

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
  /** 긴 목록: 받아 둔 것과 다음 페이지 (피드, 지금 보이는 보관함 칸) */
  feedList: Pager<FeedItem>
  libraryList: Pager<LibraryItem>
  /** 보관함 하나: 앞부분만 받은 글이면 전체를 부탁하고 지금 가진 것을 준다 */
  fullItem(id: string): LibraryItem | undefined
  /** 피드 맨 위 "나를 기다려요·지금 하는 일" (승인·로그인·진행) */
  waiting: HTMLElement[]
  /** 보관함 칸: 만든 것 / 사진·파일 */
  librarySeg: 'made' | 'media'
  setLibrarySeg(seg: 'made' | 'media'): void
}

const FEED_KIND: Record<FeedItem['kind'], { label: string; icon: IconName; tone: string; emo: string }> = {
  post: { label: '소식', icon: 'feed', tone: 'blue', emo: 'news' },
  done: { label: '끝낸 일', icon: 'check', tone: 'mint', emo: 'check' },
  routine: { label: '예약한 일', icon: 'clock', tone: 'violet', emo: 'routine' },
  saved: { label: '보관함', icon: 'bookmark', tone: 'amber', emo: 'bookmark' },
  goal: { label: '목표', icon: 'goal', tone: 'rose', emo: 'other' },
  connected: { label: '연결', icon: 'link', tone: 'blue', emo: 'link' },
  suggest: { label: '먼저 챙겼어요', icon: 'idea', tone: 'amber', emo: 'bulb' },
}

const CATEGORY: Record<GoalCategory, { icon: IconName; tone: string; hint: string; emo: string }> = {
  건강: { icon: 'heart', tone: 'rose', hint: '운동·수면·식단', emo: 'health' },
  관계: { icon: 'mail', tone: 'violet', hint: '가족·친구', emo: 'relation' },
  돈: { icon: 'card', tone: 'mint', hint: '저축·지출', emo: 'money' },
  일: { icon: 'pc', tone: 'blue', hint: '업무·이직·공부', emo: 'work' },
  관심사: { icon: 'star', tone: 'amber', hint: '취미·배우기', emo: 'interest' },
  생산성: { icon: 'list', tone: 'blue', hint: '습관·정리', emo: 'productivity' },
  기타: { icon: 'goal', tone: 'mint', hint: '그 밖의 목표', emo: 'other' },
}

/** 답·글에서 굵게 표시를 빼고 한 줄로 */
export function plain(text: string, max = 120) {
  const t = stripLinks(text)
    .replace(/\*\*/g, '')
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/gm, '')
    .replace(/\[( |x|X)\]\s*/g, '')
    .replace(/^#+\s*/gm, '')
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

/** 목록 끝 줄: 받는 중 · [더 보기] · 여기까지예요 (아래로 내리면 저절로 받는다) */
export function moreRow(p: Pager<{ id: string }>): HTMLElement | undefined {
  if (!p.items.length) return undefined
  if (p.loading) return h('p', { class: 'wait page-more' }, h('span', { class: 'spin' }), '더 불러오는 중…')
  if (p.next)
    return h(
      'div',
      { class: 'page-more' },
      h('button', { class: 'btn-text small', text: '더 보기', onclick: () => p.more() }),
    )
  return h('p', { class: 'meta page-more', text: '여기까지예요' })
}

// ── 피드 ──

export function feedView(ctx: LifeCtx): HTMLElement {
  const box = h('section', { class: 'tab-page feed' }, ...header('피드'))
  // 이번 주 두리가 한 일: 한 일이 하나라도 있으면
  // (PC가 60일 날마다 개수를 세어 보낸다: 받은 피드 페이지와 상관없이 정확하다)
  const days = ctx.life?.feedDays
  if (days?.some((n) => n > 0)) box.append(statCard(days))
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
        : h('p', { class: 'meta', text: '적어 두면 매일 아침 7시 반에 정리해서 올려 드려요.' }),
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
  if (ctx.life) box.append(watchCard(ctx))
  if (ctx.waiting.length) box.append(...ctx.waiting)
  const items = ctx.feedList.items
  if (!ctx.life) box.append(h('p', { class: 'wait' }, h('span', { class: 'spin' }), 'PC에서 받는 중…'))
  else if (!items.length)
    box.append(
      empty('sleeping', '아직 올라온 소식이 없어요', '두리가 끝낸 일과 매일 아침 소식이 여기 모여요.'),
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
  const more = moreRow(ctx.feedList)
  if (more) box.append(more)
  return box
}

function feedCard(ctx: LifeCtx, f: FeedItem) {
  const k = FEED_KIND[f.kind] ?? FEED_KIND.post
  const long = f.kind === 'post' || f.kind === 'routine'
  const body = h('div', { class: long ? 'feed-body clamp' : 'feed-body' })
  if (f.body) body.append(long ? rich(f.body) : plain(f.body, 160))
  // 긴 글은 접어 두고 누르면 펼친다
  if (long) body.onclick = () => springHeight(body, () => body.classList.toggle('open'))
  const react = (r: 'up' | 'down') => () =>
    ctx.act({ action: 'feed-react', id: f.id, ...(f.reaction === r ? {} : { reaction: r }) })
  return h(
    'article',
    { class: 'card feed-card' },
    h(
      'div',
      { class: 'feed-head' },
      emoTile(k.emo, 'sm'),
      h('span', { class: 'meta', text: k.label }),
      h('span', { class: 'meta feed-time', text: shortTime(f.at) }),
    ),
    h('strong', { class: 'feed-title', text: withoutPhotoMark(f.title) }),
    f.body ? body : undefined,
    f.from ? h('p', { class: 'meta feed-from', text: f.from }) : undefined,
    f.kind === 'suggest' && f.ask
      ? suggestActions(ctx, f, f.ask)
      : h(
          'div',
          { class: 'feed-actions' },
          h(
            'button',
            {
              class: f.reaction === 'up' ? 'chip on' : 'chip',
              label: '좋아요',
              onclick: (e: MouseEvent) => {
                // 새로 누를 때만 터진다 (취소할 때는 조용히)
                if (f.reaction !== 'up') burst(e.currentTarget as HTMLElement)
                react('up')()
              },
            },
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

/** 먼저 챙긴 일의 제안: [해 줘]는 그 부탁을 대화로 보내고, [괜찮아요]는 넘긴다 */
function suggestActions(ctx: LifeCtx, f: FeedItem, ask: string) {
  if (f.answered)
    return h(
      'div',
      { class: 'feed-actions' },
      h('span', { class: 'meta', text: f.answered === 'yes' ? '맡겼어요' : '넘겼어요' }),
    )
  return h(
    'div',
    { class: 'feed-actions suggest-actions' },
    h('button', {
      class: 'btn small',
      text: f.askLabel || '해 줘',
      onclick: () => {
        ctx.act({ action: 'feed-answer', id: f.id, answer: 'yes' })
        ctx.ask(ask)
      },
    }),
    h('button', {
      class: 'btn-ghost small',
      text: '괜찮아요',
      onclick: () => ctx.act({ action: 'feed-answer', id: f.id, answer: 'no' }),
    }),
  )
}

/** 먼저 챙기기 스위치: 연결한 서비스를 아침·저녁에 살펴 챙길 일만 알린다 (ADR 0019) */
function watchCard(ctx: LifeCtx) {
  const w = ctx.life?.watch ?? { on: true }
  const sw = h('button', {
    class: w.on ? 'switch on' : 'switch',
    label: w.on ? '먼저 챙기기 끄기' : '먼저 챙기기 켜기',
    onclick: () => ctx.act({ action: 'watch', on: !w.on }),
  })
  sw.setAttribute('role', 'switch')
  sw.setAttribute('aria-checked', String(w.on))
  return h(
    'div',
    { class: 'card watch-card' },
    h(
      'div',
      { class: 'watch-row' },
      h(
        'div',
        { class: 'grow' },
        h('strong', { text: '먼저 챙기기' }),
        h('p', {
          class: 'meta',
          text: w.busy
            ? '연결한 서비스를 살펴보는 중이에요…'
            : w.on
              ? '연결한 서비스를 아침·저녁에 살펴보고 챙길 일만 알려 드려요.'
              : '꺼 두었어요.',
        }),
      ),
      sw,
    ),
    w.on && !w.busy
      ? h('button', {
          class: 'btn-text small',
          text: '지금 살펴보기',
          onclick: () => ctx.act({ action: 'watch-now' }),
        })
      : undefined,
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
  // 끝나는 때가 지나 스스로 꺼진 건 "끝남"
  if (!r.enabled) return r.endedAt ? '끝남' : '꺼 둠'
  if (!r.schedule) return '시간 정하지 않음'
  const next = r.nextRunAt ? ` · 다음 ${nextText(r.nextRunAt)}` : ''
  return `${[scheduleLabel(r.schedule), ruleLabel(r)].filter(Boolean).join(' · ')}${next}`
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
    ...header('목표', '정해 둔 때가 되면 두리가 먼저 해요'),
  )
  const list = (ctx.life?.routines ?? []).filter((r) => !(r.target === 'feed' && r.title === '피드'))
  const goals = list.filter((r) => r.category)
  const routines = list.filter((r) => !r.category)
  if (!ctx.life) box.append(h('p', { class: 'wait' }, h('span', { class: 'spin' }), 'PC에서 받는 중…'))
  if (goals.length) {
    box.append(h('h2', { class: 'over', text: '진행 중' }))
    for (const g of goals) box.append(goalCard(ctx, g))
  }
  if (routines.length) {
    box.append(h('h2', { class: 'over', text: '예약한 일' }))
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
  box.append(h('h2', { class: 'over', text: '새 목표 세우기' }))
  const grid = h('div', { class: 'goal-grid' })
  for (const c of GOAL_CATEGORIES) {
    const k = CATEGORY[c]
    grid.append(
      h(
        'button',
        { class: 'goal-tile', onclick: () => ctx.fill(`${c} 목표를 세우고 싶어요: `) },
        emoTile(k.emo),
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
  box.append(h('h2', { class: 'over', text: '이렇게 많이 예약해요' }))
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
        emoTile('routine'),
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
      rememberFlip(r.id, !r.enabled)
      ctx.act({ action: 'routine-toggle', id: r.id, on: !r.enabled })
    },
  })
  sw.dataset.id = r.id
  sw.setAttribute('role', 'switch')
  sw.setAttribute('aria-checked', String(r.enabled))
  return h(
    'div',
    { class: r.enabled ? 'card goal-card' : 'card goal-card off', onclick: () => ctx.openGoal(r.id) },
    h(
      'div',
      { class: 'goal-head' },
      emoTile(k?.emo ?? 'routine'),
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
      ? h('p', { class: 'meta goal-last', text: `최근 결과 · ${plain(resultLine(r.lastResult), 90)}` })
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
      emoTile(k?.emo ?? 'routine'),
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: r.title }),
        h('span', { class: 'meta', text: [r.category ?? '예약한 일', whenText(r)].join(' · ') }),
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
          onclick: (e: MouseEvent) => {
            // 끝냈다고 누르면 바로 체크가 그려진다 (PC 답을 기다리지 않는다)
            const b = e.currentTarget as HTMLElement
            if (!p.done) {
              b.classList.add('done')
              const box = b.querySelector('.check') as HTMLElement
              box.replaceChildren(icon('check'))
              drawCheck(box)
            }
            ctx.act({ action: 'goal-step', id: r.id, index: i, done: !p.done })
          },
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
        '대화로 이어 가기',
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

const ITEM: Record<LibraryItem['kind'], { icon: IconName; tone: string; label: string; emo: string }> = {
  note: { icon: 'note', tone: 'blue', label: '정리', emo: 'memo' },
  link: { icon: 'link', tone: 'violet', label: '링크', emo: 'link' },
  product: { icon: 'cart', tone: 'amber', label: '상품', emo: 'shopping' },
  place: { icon: 'place', tone: 'rose', label: '장소', emo: 'pin' },
  file: { icon: 'image', tone: 'mint', label: '파일', emo: 'picture' },
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
  const list = ctx.libraryList.items
  if (!ctx.life) box.append(h('p', { class: 'wait' }, h('span', { class: 'spin' }), 'PC에서 받는 중…'))
  else if (!list.length)
    box.append(
      empty(
        '',
        ctx.librarySeg === 'media' ? '아직 사진·파일이 없어요' : '아직 남긴 게 없어요',
        ctx.librarySeg === 'media'
          ? '두리가 만든 파일과 받은 사진이 여기에 모여요.'
          : '상품 비교, 정리한 글, 링크를 모아 두는 곳이에요. 두리 답을 길게 누르면 남길 수 있어요.',
      ),
    )
  for (const it of list) {
    const k = ITEM[it.kind]
    box.append(
      h(
        'button',
        { class: 'card lib-card', onclick: () => ctx.openItem(it.id) },
        emoTile(k.emo),
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
  const more = moreRow(ctx.libraryList)
  if (more) box.append(more)
  return box
}

function previewImg(b64: string, alt: string) {
  const img = h('img', { class: 'item-shot' }) as HTMLImageElement
  img.src = `data:image/jpeg;base64,${b64}`
  img.alt = alt
  return img
}

export function itemSheet(ctx: LifeCtx, id: string): HTMLElement {
  const sheet = h('section', { class: 'sheet float app-sheet rise item-sheet' })
  const it = ctx.fullItem(id)
  if (!it) return sheet
  const k = ITEM[it.kind]
  const body = h('div', { class: 'item-body bubble rich' })
  // 앞부분만 받은 글: 전체가 오면 시트를 다시 그린다
  body.append(rich(it.cut ? `${it.body}…` : it.body))
  sheet.append(
    h('button', { class: 'fbtn small sheet-x', label: '닫기', onclick: ctx.close }, icon('close')),
    h(
      'div',
      { class: 'approve-head' },
      emoTile(k.emo),
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
    // 두리가 만든 그림·초대장: PC가 그려 찍은 미리보기
    ...(it.image ? [previewImg(it.image, it.title)] : []),
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
      emoTile('routine', 'sm'),
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

/** 두리 설정: 나를 부르는 이름 · 말투 · 답 길이 */
function identityBlock(ctx: LifeCtx): HTMLElement {
  const id = ctx.life?.identity ?? {}
  const name = h('input', { class: 'field' })
  name.id = 'identity-name'
  name.placeholder = '예: 민지 (비우면 호칭 없이)'
  name.value = id.userName ?? ''
  const save = h('button', { class: 'btn small', text: '저장' })
  save.type = 'submit'
  const form = h('form', { class: 'feed-form' }, name, save)
  form.onsubmit = (e) => {
    e.preventDefault()
    ctx.act({ action: 'identity', userName: name.value })
  }
  const seg = <T extends string>(cur: T, opts: [T, string][], pick: (v: T) => void) =>
    h(
      'div',
      { class: 'seg' },
      ...opts.map(([v, label]) => segBtn(cur === v, { text: label, onclick: () => pick(v) })),
    )
  return h(
    'div',
    { class: 'identity' },
    h('p', { class: 'over', text: '나를 부르는 이름' }),
    form,
    h('p', { class: 'over', text: '말투' }),
    seg(
      id.tone ?? 'warm',
      [
        ['warm', '다정하게'],
        ['neat', '깔끔하게'],
        ['buddy', '친구처럼'],
      ],
      (tone) => ctx.act({ action: 'identity', tone }),
    ),
    h('p', { class: 'over', text: '답 길이' }),
    seg(
      id.length ?? 'normal',
      [
        ['short', '짧게'],
        ['normal', '보통'],
        ['detail', '자세히'],
      ],
      (length) => ctx.act({ action: 'identity', length }),
    ),
    h('p', { class: 'over', text: '기억' }),
  )
}

export function memorySeg(ctx: LifeCtx): HTMLElement[] {
  const out: HTMLElement[] = [identityBlock(ctx)]
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
