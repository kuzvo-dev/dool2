// What store review needs from the phone app:
// - Looking around without a PC: a pretend PC inside the app answers through the same messages a real PC sends, so
//   every screen (chat, approval card, settings) is the real one. Nothing is saved; reopening the app ends it
// - The AI consent screen, once, before the first use: what goes where (Apple 5.1.2, Google user data)
// - Reporting an AI answer to the Dool2 team (Google AI-generated content policy)
import type {
  AnswerReportReason,
  ApprovalView,
  ConversationState,
  PcToPhone,
  PhoneToPc,
  StoredMessage,
} from '@dool2/protocol'
import { generateDevice } from '@dool2/protocol/e2e'
import { h } from '../dom.js'
import { DEMO_ORDER, DEMO_PARCEL, tReview } from '../locales/review.js'
import { demoHook, send, st } from './core.js'
import { handle } from './link.js'
import { openOverlay, render, toast } from './shell.js'

// ── AI consent ──

const CONSENT = 'dool2-ai-consent'
export const consented = () => localStorage.getItem(CONSENT) === '1'

export function consentView() {
  return h(
    'section',
    { class: 'center-page consent-page' },
    h('h1', { class: 'display-s', text: tReview.consentTitle }),
    h(
      'ol',
      { class: 'steps' },
      h('li', { text: tReview.consentBody1 }),
      h('li', { text: tReview.consentBody2 }),
      h('li', { text: tReview.consentBody3 }),
    ),
    h('button', {
      class: 'btn lg',
      text: tReview.consentAgree,
      onclick: () => {
        localStorage.setItem(CONSENT, '1')
        render()
      },
    }),
  )
}

// ── Reporting an AI answer ──

export function reportAnswerSheet(id: string) {
  const m = st.conv.find((x) => x.id === id)
  const sheet = h('section', { class: 'sheet float app-sheet rise msg-sheet' })
  if (!m) return sheet
  const note = h('textarea', { class: 'field report-note' })
  note.rows = 2
  note.maxLength = 300
  note.placeholder = tReview.reportNotePh
  const pick = (reason: AnswerReportReason, label: string) =>
    h('button', {
      class: 'set-row',
      onclick: () => {
        void send({
          kind: 'report-answer',
          messageId: m.id,
          threadId: m.threadId,
          reason,
          ...(note.value.trim() ? { note: note.value.trim() } : {}),
        })
        openOverlay(undefined)
      },
      text: label,
    })
  sheet.append(
    h('h2', { class: 'title-s', text: tReview.reportTitle }),
    // The note first: picking a reason sends right away
    note,
    pick('harmful', tReview.reportHarmful),
    pick('wrong', tReview.reportWrong),
    pick('other', tReview.reportOther),
    h('p', { class: 'meta', text: tReview.reportWhatGoes }),
  )
  return sheet
}

// ── Looking around without a PC ──

let seq = 0
const now = () => new Date().toISOString()
const msgs: StoredMessage[] = []
const approvals: ApprovalView[] = []

const say = (role: StoredMessage['role'], text: string) =>
  msgs.push({ id: `demo-${++seq}`, threadId: 'demo', role, text, createdAt: now() })

function conv(busy = false): PcToPhone {
  const state: ConversationState = { messages: [...msgs], busy, queued: [], hasMore: false, tasks: [] }
  return { kind: 'conversation', state }
}

function pcState(): PcToPhone {
  return {
    kind: 'state',
    pcName: tReview.demoPc,
    agents: ['claude'],
    extension: true,
    threads: [],
    approvals: [...approvals],
  }
}

function orderApproval(): ApprovalView {
  const t = Date.now()
  return {
    id: `demo-a${++seq}`,
    tabId: 1,
    ref: 'demo',
    role: 'button',
    label: tReview.demoPayLabel,
    url: 'https://shop.example/pay',
    kind: 'money',
    reason: 'demo',
    what: tReview.demoOrderWhat,
    where: tReview.demoShop,
    amount: tReview.demoAmount,
    status: 'pending',
    createdAt: new Date(t).toISOString(),
    expiresAt: new Date(t + 10 * 60_000).toISOString(),
  }
}

/** The pretend PC: answers a few kinds of message the way a real PC would */
function reply(body: PhoneToPc) {
  const later = (f: () => void, ms = 900) => setTimeout(() => void Promise.resolve(f()).then(render), ms)
  switch (body.kind) {
    case 'hello':
    case 'conversation':
      void handle(pcState())
        .then(() => handle(conv()))
        .then(render)
      return
    case 'ask': {
      say('user', body.text)
      void handle(conv(true)).then(render)
      later(async () => {
        if (DEMO_PARCEL.test(body.text)) say('assistant', tReview.demoParcel)
        else if (DEMO_ORDER.test(body.text)) {
          say('assistant', tReview.demoOrder)
          const a = orderApproval()
          approvals.push(a)
          await handle({ kind: 'approval', approval: a })
          await handle(pcState())
          // Opened at once, the way tapping its notification does
          openOverlay({ kind: 'approval', id: a.id })
        } else say('assistant', tReview.demoGeneric)
        await handle(conv())
      }, 1200)
      return
    }
    case 'decide': {
      const a = approvals.find((x) => x.id === body.id)
      if (a) a.status = body.decision === 'approve' ? 'approved' : 'rejected'
      later(async () => {
        await handle({ kind: 'decided', id: body.id, ok: true, message: tReview.demoApproved })
        await handle(pcState())
        if (body.decision === 'approve') {
          say('assistant', tReview.demoApproved)
          await handle(conv())
        }
      }, 500)
      return
    }
    case 'report-answer':
      later(() => handle({ kind: 'answer-reported', messageId: body.messageId, ok: true, id: 'DEMO' }), 400)
      return
    default:
      return
  }
}

export async function startDemo() {
  const keys = await generateDevice(false)
  msgs.length = 0
  approvals.length = 0
  say('assistant', tReview.demoHello)
  st.demo = true
  st.online = true
  st.saved = { pcId: 'demo', pcBoxPub: '', pcName: tReview.demoPc, keys, paired: true, seq: 0 }
  demoHook.send = reply
  st.screen = { name: 'app' }
  await handle(pcState())
  await handle(conv())
  render()
}

/** The bar on top while in the demo; leaving reloads the app, which starts from the intro again (nothing was saved) */
export function demoBar(): HTMLElement | undefined {
  if (!st.demo) return undefined
  return h(
    'div',
    { class: 'demo-bar' },
    h('span', { text: tReview.demoBar }),
    h('button', { class: 'btn-link', text: tReview.demoExit, onclick: () => location.reload() }),
  )
}

export function demoToast() {
  toast(tReview.demoBar)
}
