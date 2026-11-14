// 두리 폰 앱. PC의 두리와 중계 서버를 거쳐 종단 간 암호화로 이야기한다 (ADR 0012).
// 화면: 연결(페어링) → 홈(승인 대기·대화 목록·부탁) → 대화 → 승인
import type {
  ApprovalRecordMessage,
  ApprovalView,
  DaemonStreamEvent,
  HandoffRecord,
  PairInvite,
  PcToPhone,
  PhoneToPc,
  StoredMessage,
  ThreadSummary,
} from '@dool2/protocol'
import {
  type Envelope,
  fromB64u,
  generateDevice,
  LINK_VERSION,
  linkKey,
  open,
  pairCode,
  seal,
  signText,
} from '@dool2/protocol/e2e'
import { approvalSignText, LinkClient } from '@dool2/protocol/link'
import { type Inline, readAppNote, richBlocks, toolLabel } from '@dool2/protocol/rich'
import { clear, load, type Saved, save } from './store.js'

const app = document.getElementById('app') as HTMLElement

// ── 상태 ──
type View =
  | { name: 'intro' }
  | { name: 'unsupported' }
  | { name: 'pairing'; code: string; pcName: string; rejected?: boolean }
  | { name: 'home' }
  | { name: 'thread'; id?: string }
  | { name: 'approval'; id: string }

const st: {
  saved?: Saved
  key?: CryptoKey
  client?: LinkClient
  online: boolean
  view: View
  pc?: Extract<PcToPhone, { kind: 'state' }>
  threads: ThreadSummary[]
  messages: Map<string, StoredMessage[]>
  /** 답하는 중인 대화: 지금까지 온 글자 */
  live: Map<string, string>
  /** 답하는 중인 대화: 지금까지 한 일 ("사용법 찾는 중") */
  steps: Map<string, string[]>
  approvals: Map<string, ApprovalView & { shot?: string }>
  decided: Map<string, { ok: boolean; message: string }>
  /** 새 대화로 보낸 부탁: 첫 응답이 오면 그 대화로 간다 */
  waitingNew?: string
  draft: string
  toast?: string
} = {
  online: false,
  view: { name: 'intro' },
  threads: [],
  messages: new Map(),
  live: new Map(),
  steps: new Map(),
  approvals: new Map(),
  decided: new Map(),
  draft: '',
}

// ── 화면 그리기 도우미 ──
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; onclick?: () => void } = {},
  ...children: (Node | string | false | undefined)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (props.class) e.className = props.class
  if (props.text !== undefined) e.textContent = props.text
  if (props.onclick) e.addEventListener('click', props.onclick)
  for (const c of children) if (c) e.append(c)
  return e
}

/** 선 아이콘 (24 격자). 화면 글자 대신 쓴다 */
const ICON = {
  back: 'M15 18l-6-6 6-6',
  dining: 'M7 3v8M5 3v4a2 2 0 0 0 4 0V3M7 11v10M17 3c-1.7 0-3 2-3 5s1.3 4 3 4v9',
  grocery: 'M4 11h16a8 8 0 0 1-16 0ZM9 7c0-1.5 1-2 1-3M13 7c0-1.5 1-2 1-3',
  parcel: 'M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5ZM3.5 7.5 12 12l8.5-4.5M12 12v9',
  mail: 'M6 3h8l4 4v14H6ZM14 3v4h4M9 12h6M9 16h6',
  send: 'M12 19V5M6 11l6-6 6 6',
  chevron: 'M9 6l6 6-6 6',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
} as const
function icon(name: keyof typeof ICON): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'i')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', ICON[name])
  svg.append(path)
  return svg
}

/** 오늘이면 "오전 10:03", 아니면 "11. 14." */
function shortTime(iso: string) {
  const d = new Date(iso)
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })
}

/** 두리 답: 문단·목록·**굵게**만 그린다 (HTML로 해석하지 않는다) */
function rich(text: string): DocumentFragment {
  const f = document.createDocumentFragment()
  const spans = (parent: HTMLElement, parts: Inline[]) => {
    for (const part of parts) parent.append(part.bold ? h('strong', { text: part.text }) : part.text)
  }
  for (const block of richBlocks(text)) {
    if (block.type === 'p') {
      const p = h('p')
      block.lines.forEach((line, i) => {
        if (i) p.append(h('br'))
        spans(p, line)
      })
      f.append(p)
      continue
    }
    const list = h(block.type)
    if (block.type === 'ol' && block.start !== 1) (list as HTMLOListElement).start = block.start
    for (const item of block.items) {
      const li = h('li')
      spans(li, item)
      list.append(li)
    }
    f.append(list)
  }
  return f
}

const go = (v: View) => {
  st.view = v
  render()
  window.scrollTo(0, v.name === 'thread' ? document.body.scrollHeight : 0)
}

// ── 연결 ──

async function send(body: PhoneToPc) {
  const s = st.saved
  if (!s || !st.key || !st.client) return
  s.seq += 1
  await save(s)
  st.client.send(
    await seal(st.key, { v: LINK_VERSION, from: s.keys.id, to: s.pcId, kind: body.kind, seq: s.seq }, body),
  )
}

function connect() {
  const s = st.saved
  if (!s) return
  st.client?.stop()
  st.client = new LinkClient({
    relay: location.origin,
    role: 'phone',
    keys: s.keys,
    room: s.pcId,
    onEnvelope: (env) => void receive(env),
    onState: (state) => {
      st.online = state === 'ready'
      if (state === 'ready' && st.saved?.paired) void send({ kind: 'hello' })
      render()
    },
  })
  st.client.start()
}

async function receive(env: Envelope) {
  const s = st.saved
  if (!s || !st.key || env.from !== s.pcId || env.to !== s.keys.id) return
  let msg: PcToPhone
  try {
    msg = await open<PcToPhone>(st.key, env)
  } catch {
    return
  }
  switch (msg.kind) {
    case 'paired':
      s.paired = true
      s.pcName = msg.pcName
      await save(s)
      toast('연결됐어요. 이제 폰으로 부탁해 보세요')
      go({ name: 'home' })
      return
    case 'pair-rejected':
      if (st.view.name === 'pairing') go({ ...st.view, rejected: true })
      await clear()
      st.saved = undefined
      return
    case 'state':
      st.pc = msg
      st.threads = msg.threads
      for (const a of msg.approvals) if (!st.approvals.has(a.id)) st.approvals.set(a.id, a)
      void syncPush()
      openPending()
      break
    case 'thread':
      st.messages.set(msg.thread.id, msg.messages)
      upsertThread(msg.thread)
      break
    case 'stream':
      onStream(msg.threadId, msg.event)
      break
    case 'approval':
      st.approvals.set(msg.approval.id, msg.approval)
      if (msg.approval.status === 'pending')
        notify('승인을 기다려요', msg.approval.what, `approval-${msg.approval.id}`)
      break
    case 'decided': {
      st.decided.set(msg.id, { ok: msg.ok, message: msg.message })
      const a = st.approvals.get(msg.id)
      if (a && msg.ok) st.approvals.set(msg.id, { ...a, status: a.status === 'pending' ? 'done' : a.status })
      toast(msg.message)
      void send({ kind: 'approval', id: msg.id })
      break
    }
    case 'error':
      toast(msg.message)
      break
  }
  render()
}

function upsertThread(t: ThreadSummary) {
  st.threads = [t, ...st.threads.filter((x) => x.id !== t.id)]
}

function onStream(threadId: string, ev: DaemonStreamEvent) {
  const list = st.messages.get(threadId) ?? []
  if (ev.type === 'saved') {
    st.messages.set(threadId, [...list.filter((m) => m.id !== ev.message.id), ev.message])
    if (ev.message.role === 'assistant') st.live.delete(threadId)
    // 이 폰에서 보낸 새 부탁이면 그 대화로 간다
    if (st.waitingNew && ev.message.role === 'user' && ev.message.text === st.waitingNew) {
      st.waitingNew = undefined
      if (st.view.name === 'thread' && !st.view.id) st.view = { name: 'thread', id: threadId }
    }
    if (!st.threads.some((t) => t.id === threadId))
      upsertThread({
        id: threadId,
        title: ev.message.text.slice(0, 30),
        agent: 'claude',
        createdAt: ev.message.createdAt,
        updatedAt: ev.message.createdAt,
      } as ThreadSummary)
  } else if (ev.type === 'agent') {
    if (ev.event.type === 'text') st.live.set(threadId, (st.live.get(threadId) ?? '') + ev.event.delta)
    else if (ev.event.type === 'tool') {
      if (!st.live.has(threadId)) st.live.set(threadId, '')
      const steps = st.steps.get(threadId) ?? []
      const label = `${toolLabel(ev.event.name)} 중`
      if (steps.at(-1) !== label) st.steps.set(threadId, [...steps, label])
    }
  } else if (ev.type === 'end') {
    st.live.delete(threadId)
    st.steps.delete(threadId)
    void send({ kind: 'hello' })
  }
}

// ── 알림 ──

function toast(text: string) {
  st.toast = text
  render()
  setTimeout(() => {
    if (st.toast === text) {
      st.toast = undefined
      render()
    }
  }, 3500)
}

function notify(title: string, body: string, tag?: string) {
  // 앱이 뒤에 있을 때만. PC가 보낸 푸시 알림과 tag가 같아서 둘이 겹치지 않는다
  if (document.visibilityState === 'visible') return
  if ('Notification' in window && Notification.permission === 'granted')
    new Notification(title, { body, ...(tag ? { tag } : {}) })
}

// ── 웹 푸시: 앱이 꺼져 있어도 알림 ──

const pushReady = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array) {
  if (!a) return false
  const x = new Uint8Array(a)
  return x.length === b.length && x.every((v, i) => v === b[i])
}

/**
 * 알림을 허락했으면 이 PC의 키로 푸시를 구독하고 PC에 알린다. 다른 PC로 바꿨으면 다시 구독한다.
 * PC가 이미 알고 있으면(state.push) 다시 보내지 않는다
 */
let syncing = false
async function syncPush() {
  const vapid = st.pc?.vapid
  if (syncing || !vapid || !pushReady() || Notification.permission !== 'granted') return
  syncing = true
  try {
    const reg = await navigator.serviceWorker.ready
    const key = fromB64u(vapid)
    let sub = await reg.pushManager.getSubscription()
    if (sub && !sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe()
      sub = null
    }
    const fresh = !sub
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    if (fresh || !st.pc?.push) {
      const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
      if (j.endpoint && j.keys?.p256dh && j.keys.auth)
        await send({
          kind: 'push',
          sub: { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } },
        })
    }
  } catch {
    // 알림 주소를 못 받는 브라우저 (예: 홈 화면에 추가하지 않은 아이폰 사파리)
  } finally {
    syncing = false
  }
}

/** 알림을 눌러 열었으면 (#a=승인 id, #t=대화 id) 그 화면으로 간다 */
let pendingOpen = ''
function openPending() {
  const m = /^#([at])=([\w-]+)$/.exec(pendingOpen)
  if (!m || !st.saved?.paired) return
  pendingOpen = ''
  history.replaceState(null, '', location.pathname)
  if (m[1] === 'a') {
    go({ name: 'approval', id: m[2] as string })
    void send({ kind: 'approval', id: m[2] as string })
  } else openThread(m[2] as string)
}

// ── 페어링 ──

async function startPairing(raw: string) {
  let invite: PairInvite
  try {
    invite = JSON.parse(new TextDecoder().decode(fromB64u(raw))) as PairInvite
  } catch {
    toast('QR이 올바르지 않아요. PC에서 다시 띄워 주세요')
    return
  }
  history.replaceState(null, '', location.pathname)
  // 예전 연결은 끊고 새 PC와 다시 시작한다
  st.client?.stop()
  st.client = undefined
  st.online = false
  st.threads = []
  st.messages.clear()
  st.live.clear()
  st.approvals.clear()
  st.decided.clear()
  st.pc = undefined
  const keys = await generateDevice(false)
  const saved: Saved = { pcId: invite.pc, pcBoxPub: invite.k, pcName: invite.n, keys, paired: false, seq: 0 }
  await save(saved)
  st.saved = saved
  st.key = await linkKey(keys.boxPriv, invite.k, [keys.id, invite.pc])
  const code = await pairCode(keys.boxPriv, invite.k)
  go({ name: 'pairing', code, pcName: invite.n })
  connect()
  // 페어링 요청: 이 폰의 X25519 공개키를 머리에 실어, PC가 키를 만들 수 있게 한다
  saved.seq += 1
  await save(saved)
  const body: PhoneToPc = { kind: 'pair', secret: invite.s, signPub: keys.signPub, name: deviceName() }
  ;(st.client as LinkClient | undefined)?.send({
    ...(await seal(
      st.key,
      { v: LINK_VERSION, from: keys.id, to: invite.pc, kind: 'pair', seq: saved.seq, pub: keys.boxPub },
      body,
    )),
  })
}

function deviceName() {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return '아이폰'
  if (/iPad/.test(ua)) return '아이패드'
  if (/Android/.test(ua)) return '안드로이드 폰'
  return '폰'
}

// ── 화면 ──

function render() {
  // 입력 중이던 칸의 커서와, 대화 아래쪽을 보고 있었는지를 기억해 다시 그린 뒤 되돌린다
  const active = document.activeElement
  const typing =
    active instanceof HTMLTextAreaElement
      ? { start: active.selectionStart, end: active.selectionEnd }
      : undefined
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 120
  const v = st.view
  const screen =
    v.name === 'intro'
      ? introView()
      : v.name === 'unsupported'
        ? unsupportedView()
        : v.name === 'pairing'
          ? pairingView(v)
          : v.name === 'home'
            ? homeView()
            : v.name === 'thread'
              ? threadView(v.id)
              : approvalView(v.id)
  const y = window.scrollY
  app.replaceChildren(screen, ...(st.toast ? [h('div', { class: 'toast', text: st.toast })] : []))
  if (v.name === 'thread' && nearBottom) window.scrollTo(0, document.body.scrollHeight)
  else window.scrollTo(0, y)
  const input = app.querySelector<HTMLTextAreaElement>('textarea')
  if (input && typing) {
    input.focus()
    input.setSelectionRange(typing.start, typing.end)
  }
}

function header(title: string, back?: () => void) {
  return h(
    'header',
    { class: 'bar' },
    back ? backButton(back) : h('span', { class: 'face' }),
    h('div', { class: 'bar-title' }, h('strong', { text: title }), statusLine()),
  )
}

function backButton(back: () => void) {
  const b = h('button', { class: 'back', onclick: back }, icon('back'))
  b.setAttribute('aria-label', '뒤로')
  return b
}

function statusLine() {
  const name = st.saved?.pcName ?? 'PC'
  return h('span', {
    class: `status ${st.online ? 'on' : 'off'}`,
    text: st.online ? `${name}와 연결됨` : `${name} 연결 중…`,
  })
}

function introView() {
  return h(
    'section',
    { class: 'center' },
    h('div', { class: 'face big' }),
    h('h1', { text: '두리' }),
    h('p', { text: '내 컴퓨터의 두리에게 폰으로 부탁해요.' }),
    h(
      'ol',
      { class: 'steps' },
      h('li', { text: 'PC에서 두리 앱을 열어요' }),
      h('li', { text: '설정 → 폰 연결 → [폰 연결하기]' }),
      h('li', { text: '폰 카메라로 QR을 찍어요' }),
    ),
    h('p', { class: 'cap', text: '주고받는 내용은 PC와 이 폰만 열 수 있게 암호화돼요.' }),
  )
}

function unsupportedView() {
  return h(
    'section',
    { class: 'center' },
    h('h1', { text: '이 브라우저는 아직 안 돼요' }),
    h('p', { text: '최신 Safari(iOS 17 이상)나 Chrome으로 열어 주세요.' }),
  )
}

function pairingView(v: Extract<View, { name: 'pairing' }>) {
  if (v.rejected)
    return h(
      'section',
      { class: 'center' },
      h('h1', { text: '연결하지 않았어요' }),
      h('p', { text: 'PC에서 "다른 숫자예요"를 눌렀어요. PC에서 QR을 다시 띄워 찍어 주세요.' }),
    )
  return h(
    'section',
    { class: 'center' },
    h('h1', { text: `${v.pcName}에 연결할게요` }),
    h('p', { text: 'PC 화면에 이 숫자가 보이나요?' }),
    h('div', { class: 'code', text: v.code.replace(/(\d{3})(\d{3})/, '$1 $2') }),
    h('p', { class: 'wait' }, h('span', { class: 'spin' }), 'PC에서 [같아요, 연결]을 눌러 주세요'),
    h('p', { class: 'cap', text: '숫자가 다르면 PC에서 "다른 숫자예요"를 눌러 주세요.' }),
  )
}

function pendingApprovals() {
  return [...st.approvals.values()].filter(
    (a) => a.status === 'pending' && Date.parse(a.expiresAt) > Date.now(),
  )
}

/** 바로 맡기기: 누르면 부탁 칸에 예시 글을 채운다 */
const QUICK: { label: string; icon: keyof typeof ICON; text: string }[] = [
  { label: '식당 예약', icon: 'dining', text: '이번 주 토요일 저녁 7시, 2명 식당 예약해 줘' },
  { label: '장보기', icon: 'grocery', text: '늘 사던 걸로 장바구니 채워 줘' },
  { label: '택배 조회', icon: 'parcel', text: '주문한 택배 어디쯤 왔는지 봐 줘' },
  { label: '메일 정리', icon: 'mail', text: '답장이 필요한 메일만 골라 줘' },
]

function whenLabel(iso: string) {
  const min = Math.floor((Date.now() - Date.parse(iso)) / 60_000)
  if (min < 2) return '방금 끝났어요'
  if (min < 60) return `${min}분 전`
  return shortTime(iso)
}

function openThread(id: string) {
  go({ name: 'thread', id })
  void send({ kind: 'thread', id })
}

/** 맡긴 일 카드: 상태 줄 → 제목 → 마지막 답 */
function taskCard(t: ThreadSummary) {
  const busy = t.busy || st.live.has(t.id)
  return h(
    'button',
    { class: 'task', onclick: () => openThread(t.id) },
    h(
      'div',
      { class: 'task-meta' },
      h('span', { text: busy ? '일하는 중' : whenLabel(t.updatedAt) }),
      busy && h('i', { class: 'spin' }),
    ),
    h('div', { class: 'task-title', text: t.title }),
    (t.preview || busy) &&
      h('p', { class: 'task-body', text: t.preview ?? `${st.saved?.pcName ?? 'PC'}에서 하고 있어요` }),
  )
}

function approvalCard(a: ApprovalView) {
  return h(
    'div',
    { class: 'task dark' },
    h('div', { class: 'task-meta' }, h('i', { class: 'dot mint' }), '승인을 기다려요'),
    h('div', { class: 'task-title', text: [a.what, a.amount].filter(Boolean).join(' · ') }),
    h('p', { class: 'task-body', text: `${a.where} · 승인하시면 "${a.label}"을(를) 눌러요` }),
    h('button', {
      class: 'btn-light lg',
      text: '확인하고 승인하기',
      onclick: () => go({ name: 'approval', id: a.id }),
    }),
  )
}

function homeView() {
  const box = h('section', { class: 'page home' }, header('두리'))
  if (st.pc && !st.pc.agents.length)
    box.append(
      h('div', {
        class: 'notice',
        text: 'PC에 일할 AI가 연결돼 있지 않아요. PC의 두리 앱에서 확인해 주세요.',
      }),
    )
  // 승인할 일이 있으면 맨 위에
  for (const a of pendingApprovals()) box.append(approvalCard(a))
  // 부탁 칸
  box.append(
    composer(undefined, true),
    h('p', { class: 'cap ask-hint', text: `맡긴 일은 ${st.saved?.pcName ?? '내 컴퓨터'}가 해요` }),
  )
  // 바로 맡기기
  const quick = h('div', { class: 'quick' })
  for (const q of QUICK)
    quick.append(
      h(
        'button',
        {
          onclick: () => {
            st.draft = q.text
            render()
            const ta = app.querySelector<HTMLTextAreaElement>('textarea')
            ta?.focus()
            ta?.setSelectionRange(q.text.length, q.text.length)
          },
        },
        h('span', { class: 'quick-icon' }, icon(q.icon)),
        q.label,
      ),
    )
  box.append(quick)
  // 아이폰은 홈 화면에 추가한 앱에서만 알림을 받을 수 있다
  const ios = /iPhone|iPad/.test(navigator.userAgent)
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  if (ios && !standalone && !pushReady())
    box.append(
      h(
        'div',
        { class: 'notify-ask' },
        icon('bell'),
        h(
          'span',
          { class: 'text' },
          h('strong', { text: '알림을 받으려면 홈 화면에 추가해 주세요' }),
          h('span', { text: '사파리 아래 공유 버튼 → 홈 화면에 추가 → 거기서 두리를 열어요' }),
        ),
      ),
    )
  // 알림은 사용자가 눌러서 켤 때만 묻는다 (아무 데나 눌렀다고 권한 창을 띄우지 않는다)
  else if ('Notification' in window && Notification.permission === 'default')
    box.append(
      h(
        'button',
        {
          class: 'notify-ask',
          onclick: () =>
            void Notification.requestPermission().then(() => {
              render()
              void syncPush()
            }),
        },
        icon('bell'),
        h(
          'span',
          { class: 'text' },
          h('strong', { text: '알림 켜기' }),
          h('span', { text: '승인할 일이 생기면 알려 드릴게요' }),
        ),
        icon('chevron'),
      ),
    )
  // 최근에 맡긴 일: 앞의 셋은 카드, 나머지는 줄
  box.append(h('h2', { class: 'over', text: '최근에 맡긴 일' }))
  if (!st.threads.length)
    box.append(h('p', { class: 'cap empty', text: '아직 맡긴 일이 없어요. 위에 부탁을 적어 보세요.' }))
  const cards = h('div', { class: 'tasks' })
  for (const t of st.threads.slice(0, 3)) cards.append(taskCard(t))
  box.append(cards)
  const rest = st.threads.slice(3, 30)
  if (rest.length) {
    const list = h('ul', { class: 'threads' })
    for (const t of rest)
      list.append(
        h(
          'li',
          {},
          h(
            'button',
            { onclick: () => openThread(t.id) },
            h('span', { class: 't', text: t.title }),
            h('span', { class: 'm', text: shortTime(t.updatedAt) }),
          ),
        ),
      )
    box.append(h('h2', { class: 'over', text: '지난 일' }), list)
  }
  return box
}

function composer(threadId: string | undefined, top = false) {
  const form = h('form', { class: top ? 'composer top' : 'composer' })
  const ta = h('textarea')
  ta.rows = 1
  ta.placeholder = top ? '무엇을 맡길까요?' : '두리에게 부탁하기…'
  ta.value = st.draft
  ta.oninput = () => {
    st.draft = ta.value
  }
  const btn = h('button', { class: 'send' }, icon('send'))
  btn.type = 'submit'
  btn.setAttribute('aria-label', '보내기')
  btn.disabled = !st.online || Boolean(threadId && st.live.has(threadId))
  form.append(h('div', { class: 'composer-box' }, ta, btn))
  form.onsubmit = (e) => {
    e.preventDefault()
    const text = st.draft.trim()
    if (!text || !st.online) return
    st.draft = ''
    if (threadId) {
      st.live.set(threadId, '')
      void send({ kind: 'ask', threadId, text })
    } else {
      st.waitingNew = text
      void send({ kind: 'ask', text })
      st.view = { name: 'thread' }
    }
    render()
  }
  return form
}

function threadView(id: string | undefined) {
  const t = st.threads.find((x) => x.id === id)
  const box = h(
    'section',
    { class: 'page thread' },
    header(t?.title ?? '새 부탁', () => go({ name: 'home' })),
  )
  const msgs = h('div', { class: 'messages' })
  const list = id ? (st.messages.get(id) ?? []) : []
  if (!id && st.waitingNew) msgs.append(h('div', { class: 'msg user' }, st.waitingNew))
  // 넘기기·승인 기록은 그 다음 답 아래에 둔다 (PC 화면과 같은 순서)
  const order = [...list]
  for (let i = 0; i + 1 < order.length; i++) {
    const a = order[i]
    const b = order[i + 1]
    if (a && b && a.role === 'tool' && b.role === 'assistant') {
      order[i] = b
      order[i + 1] = a
      i++
    }
  }
  let prev = ''
  const who = () => h('div', { class: 'who' }, h('span', { class: 'face' }), '두리')
  for (const m of order) {
    // 두리 답 위에는 이름표 (이어진 답에는 한 번만)
    if (m.role === 'assistant' && prev !== 'assistant') msgs.append(who())
    prev = m.role
    if (m.role === 'tool') msgs.append(toolCard(m.text))
    else if (m.role === 'user' && readAppNote(m.text) !== undefined)
      msgs.append(h('div', { class: 'msg note', text: readAppNote(m.text) }))
    else
      msgs.append(
        h(
          'div',
          { class: m.role === 'assistant' ? 'msg assistant rich' : `msg ${m.role}` },
          m.role === 'user' ? m.text : rich(m.text),
        ),
      )
  }
  const live = id ? st.live.get(id) : st.waitingNew ? '' : undefined
  if (live !== undefined) {
    if (prev !== 'assistant') msgs.append(who())
    const steps = (id && st.steps.get(id)) || []
    const log = h('ul', { class: 'worklog' })
    steps.forEach((label, i) => {
      log.append(h('li', { class: i === steps.length - 1 ? 'now' : 'done', text: label }))
    })
    msgs.append(
      h(
        'div',
        { class: 'work' },
        h('p', { class: 'activity shimmer', text: `${st.saved?.pcName ?? 'PC'}에서 일하는 중…` }),
        steps.length > 0 && log,
      ),
    )
    if (live) msgs.append(h('div', { class: 'msg assistant rich' }, rich(live)))
  }
  box.append(msgs, composer(id))
  return box
}

function toolCard(raw: string) {
  let rec: HandoffRecord | ApprovalRecordMessage
  try {
    rec = JSON.parse(raw)
  } catch {
    return h('span')
  }
  if (rec.kind === 'approval') {
    const a = [...st.approvals.values()]
      .filter((x) => x.tabId === rec.tabId && x.ref === rec.ref)
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0]
    const pending = a?.status === 'pending'
    return h(
      'button',
      {
        class: `card approval ${pending ? 'pending' : ''}`,
        onclick: () => a && go({ name: 'approval', id: a.id }),
      },
      h(
        'span',
        { class: 'text' },
        h('strong', {
          text: pending ? '승인을 기다려요' : a?.status === 'done' ? '승인해서 눌렀어요' : '승인 요청',
        }),
        h('span', { text: rec.what }),
      ),
      pending && icon('chevron'),
    )
  }
  return h(
    'div',
    { class: 'card handoff' },
    h('strong', { text: 'PC에서 직접 해 주세요' }),
    h('span', { text: rec.reason }),
    h('span', {
      class: 'cap',
      text: 'PC의 Chrome에 두리 탭을 띄워 뒀어요. 다 하시면 "다 했어요"라고 보내 주세요.',
    }),
  )
}

const RISK: Record<ApprovalView['kind'], string> = {
  money: '돈이 나가는 일',
  contact: '다른 사람에게 보내는 일',
  irreversible: '되돌릴 수 없는 일',
}

function approvalView(id: string) {
  const a = st.approvals.get(id)
  const box = h(
    'section',
    { class: 'page' },
    header('승인', () => go({ name: 'home' })),
  )
  if (!a) return box
  if (!a.shot && a.status === 'pending') void send({ kind: 'approval', id })
  const host = (() => {
    try {
      return new URL(a.url).host
    } catch {
      return a.url
    }
  })()
  const rows = h('dl', { class: 'kv' })
  const row = (k: string, v?: string, cls?: string) =>
    v && rows.append(h('dt', { text: k }), h('dd', { text: v, ...(cls ? { class: cls } : {}) }))
  row('무엇을', a.what)
  row('어디서', a.where)
  row('주소', host, 'host')
  row('얼마', a.amount, 'money')
  row('취소 조건', a.cancel)
  row('누를 버튼', `"${a.label}"`)
  box.append(
    h(
      'div',
      { class: `approval-head ${a.kind}` },
      h('span', { class: 'kind', text: RISK[a.kind] }),
      h('strong', { text: a.what }),
      h('span', { text: a.reason.startsWith('"') ? `누를 버튼에 ${a.reason}이(가) 있어요` : a.reason }),
    ),
    rows,
  )
  if (a.shot) {
    const img = h('img', { class: 'shot' })
    img.alt = 'PC 화면'
    img.src = `data:image/jpeg;base64,${a.shot}`
    box.append(img)
  }
  const done = st.decided.get(id)
  if (a.status !== 'pending' || done) {
    box.append(
      h('p', {
        class: 'result',
        text:
          done?.message ??
          a.result ??
          (a.status === 'rejected'
            ? '거절했어요'
            : a.status === 'expired'
              ? '승인 시간이 지났어요'
              : '처리했어요'),
      }),
    )
    return box
  }
  box.append(
    h('p', {
      class: 'cap',
      text: '화면과 내용이 맞는지 확인해 주세요. "얼마"·"무엇을"은 두리가 읽어 적은 것이라 틀릴 수 있어요. 승인하면 두리가 이 버튼 하나만 눌러요.',
    }),
  )
  const decide = async (decision: 'approve' | 'reject') => {
    const s = st.saved
    if (!s) return
    // 승인 내용에 이 폰의 키로 서명한다. PC가 페어링 때 받은 공개키로 확인한다
    const sig = await signText(s.keys.signPriv, approvalSignText(a, decision))
    st.decided.set(id, {
      ok: true,
      message: decision === 'approve' ? '승인을 보냈어요. PC에서 누르는 중…' : '거절을 보냈어요',
    })
    render()
    await send({ kind: 'decide', id, decision, sig })
  }
  box.append(
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'ghost', text: '거절', onclick: () => void decide('reject') }),
      h('button', {
        class: 'primary',
        text: `승인하고 "${a.label}" 누르기`,
        onclick: () => void decide('approve'),
      }),
    ),
  )
  return box
}

// ── 시작 ──

// 앱이 열려 있는 채로 새 QR을 찍으면 주소의 # 뒤만 바뀐다. 그때도 새로 연결한다
window.addEventListener('hashchange', () => {
  const invite = /#p=([\w-]+)/.exec(location.hash)?.[1]
  if (invite) return void startPairing(invite)
  // 앱이 열린 채로 알림을 누르면 주소의 # 뒤만 바뀐다
  if (/^#[at]=/.test(location.hash)) {
    pendingOpen = location.hash
    if (st.online) openPending()
  }
})

async function main() {
  if (!globalThis.crypto?.subtle || !('indexedDB' in window)) return go({ name: 'unsupported' })
  try {
    await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
  } catch {
    return go({ name: 'unsupported' })
  }
  if ('serviceWorker' in navigator) void navigator.serviceWorker.register('sw.js').catch(() => {})
  const invite = /#p=([\w-]+)/.exec(location.hash)?.[1]
  if (invite) return startPairing(invite)
  if (/^#[at]=/.test(location.hash)) pendingOpen = location.hash
  const saved = await load()
  if (!saved) return go({ name: 'intro' })
  st.saved = saved
  st.key = await linkKey(saved.keys.boxPriv, saved.pcBoxPub, [saved.keys.id, saved.pcId])
  if (!saved.paired) {
    go({ name: 'pairing', code: await pairCode(saved.keys.boxPriv, saved.pcBoxPub), pcName: saved.pcName })
  } else go({ name: 'home' })
  connect()
}

void main()
