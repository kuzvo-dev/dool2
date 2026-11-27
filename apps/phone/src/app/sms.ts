// Phone app: sending a text from this phone (number lookup, auto-send, the text card)
import type { ApprovalView, PhoneCap } from '@dool2/protocol'
import { h, icon } from '../dom.js'
import { holdButton } from '../motion.js'
import { type SmsPerson, smsAvailable, smsFind, smsPermissions, smsSend } from '../native.js'
import { HONORIFIC_RE } from '../region/kr/main-b-approval.js'
import { mark, send, tAppr, tSms } from './core.js'
import { decide, markDecided } from './decide.js'
import { render, toast } from './shell.js'

// ── Sending a text (from my own number) ─────────────────────────────
// The PC (Dool2) sends only the recipient's name and the text. This phone finds the number in contacts and never sends it out.
// When the user holds to approve, this phone sends it right away (no other app opens), then tells the PC the result, then the approval signature

/** What this app can do (so the PC knows whether it may hand off texting) */
const capsReady: Promise<PhoneCap[]> = smsAvailable().then((ok) => (ok ? ['sms'] : []))
export function hello() {
  void capsReady.then((caps) => send({ kind: 'hello', caps }))
}

interface SmsState {
  state: 'finding' | 'found' | 'none' | 'denied'
  people: SmsPerson[]
  pick: number
  manual: string
  error?: string
}
export const smsStates = new Map<string, SmsState>()
export const isSms = (a: ApprovalView) => a.url.startsWith('sms:')
const smsTo = (a: ApprovalView) => a.url.slice(4)
/** If it looks like a number (8 or more digits), use it as is without searching contacts */
const phoneLike = (v: string) => v.replace(/[^0-9]/g, '').length >= 8 && /^[0-9+\-\s().]+$/.test(v)
const maskNumber = (n: string) => {
  const d = n.replace(/[^0-9]/g, '')
  return d.length >= 8 ? `${d.slice(0, 3)}-****-${d.slice(-4)}` : n
}
const showNumber = (n: string) => {
  const d = n.replace(/[^0-9]/g, '')
  return d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : n
}

function smsState(a: ApprovalView): SmsState {
  let s = smsStates.get(a.id)
  if (s) return s
  const to = smsTo(a)
  if (phoneLike(to)) {
    s = { state: 'found', people: [{ name: '', number: to, label: '' }], pick: 0, manual: '' }
    smsStates.set(a.id, s)
    autoSendSms(a, s)
    return s
  }
  s = { state: 'finding', people: [], pick: 0, manual: '' }
  smsStates.set(a.id, s)
  const mine = s
  // When the card first shows, ask for contacts and text permission at once, then search
  void smsPermissions()
    // Search without the Korean honorific suffix (see region/kr/main-b-approval.ts)
    .then(() => smsFind(to.replace(HONORIFIC_RE, '').trim()))
    .then((r) => {
      mine.people = r.people
      mine.state = r.denied ? 'denied' : r.people.length ? 'found' : 'none'
      autoSendSms(a, mine)
      render()
    })
  return s
}

/**
 * Auto-approve (ADR 0030): a text flagged auto is sent without the long press once the recipient is clear (one
 * match or a number). Several matches or none still wait for the user on the card
 */
const autoSent = new Set<string>()
function autoSendSms(a: ApprovalView, s: SmsState) {
  if (!a.auto || a.status !== 'pending' || autoSent.has(a.id)) return
  if (s.state !== 'found' || s.people.length !== 1) return
  autoSent.add(a.id)
  mark('sms auto-send')
  void sendSms(a)
    .then(() => markDecided(a, 'approve'))
    .catch(() => render())
}

/** Number to send to and the recipient's name (undefined if not decided) */
function smsTarget(s: SmsState): { name: string; number: string } | undefined {
  if (s.manual.replace(/[^0-9]/g, '').length >= 8) return { name: '', number: s.manual }
  const p = s.state === 'found' ? s.people[s.pick] : undefined
  return p ? { name: p.name, number: p.number } : undefined
}

/** Text plugin failure code -> message for the user */
function smsWhy(reason?: string, detail?: string): string {
  switch (reason) {
    case 'denied':
      return tSms.denied
    case 'bad':
      return tSms.bad
    case 'no-phone':
      return tSms.noPhone
    case 'no-service':
      return tSms.noSignal
    case 'radio-off':
      return tSms.airplane
    case 'carrier':
      return tSms.carrier(detail)
    case 'timeout':
      return tSms.timeout
    default:
      return detail ? tSms.failedWith(detail) : tSms.unknown
  }
}

async function sendSms(a: ApprovalView) {
  const s = smsState(a)
  const t = smsTarget(s)
  if (!t) {
    s.error = tSms.pickNumber
    render()
    throw new Error(s.error)
  }
  if (Date.parse(a.expiresAt) <= Date.now()) {
    s.error = tSms.expired
    render()
    throw new Error(s.error)
  }
  s.error = undefined
  if (!(await smsPermissions()).sms) {
    s.error = tSms.needPerm
    render()
    throw new Error(s.error)
  }
  const r = await smsSend(t.number, a.what)
  const who = t.name ? `${t.name}(${maskNumber(t.number)})` : maskNumber(t.number)
  const message = r.ok ? tSms.sent(who) : tSms.notSent(who, smsWhy(r.reason, r.message))
  // Result first, then the approval signature (the PC records this result as final only when the signature is valid)
  await send({ kind: 'sms-result', id: a.id, ok: r.ok, message })
  await decide(a, 'approve', true)
  if (!r.ok) toast(message)
}

export function smsCard(a: ApprovalView, big = false): HTMLElement {
  const s = smsState(a)
  const to = smsTo(a)
  const who = h('div', { class: 'approve-choices sms-to' })
  const label = (t: string) => h('span', { class: 'meta', text: t })
  if (s.state === 'finding') who.append(label(tSms.finding(to)))
  else if (s.state === 'found' && s.people.length === 1) {
    const p = s.people[0] as SmsPerson
    who.append(
      label(tSms.to),
      h('strong', { text: [p.name, showNumber(p.number)].filter(Boolean).join(' · ') }),
      ...(p.label ? [h('span', { class: 'meta', text: p.label })] : []),
    )
  } else if (s.state === 'found') {
    who.append(
      label(tSms.many(to)),
      h(
        'div',
        { class: 'choice-list' },
        ...s.people.map((p, i) =>
          h('button', {
            class: `chip${i === s.pick && !s.manual ? ' on' : ''}`,
            text: `${p.name} · ${p.number.replace(/[^0-9]/g, '').slice(-4)}`,
            onclick: () => {
              s.pick = i
              s.manual = ''
              render()
            },
          }),
        ),
      ),
    )
  }
  if (s.state === 'none' || s.state === 'denied') {
    who.append(label(s.state === 'denied' ? tSms.noAccess(to) : tSms.notFound(to)))
    const input = h('input', { class: 'field' }) as HTMLInputElement
    input.type = 'tel'
    input.inputMode = 'tel'
    input.placeholder = '010-0000-0000'
    input.value = s.manual
    input.oninput = () => {
      s.manual = input.value.trim().slice(0, 20)
    }
    who.append(input)
  }
  return h(
    'div',
    { class: `card approve-card sms-card${big ? ' big' : ''}` },
    h(
      'div',
      { class: 'approve-head' },
      h('span', { class: 'tile amber' }, icon('mail', 'i md')),
      h('div', {}, h('strong', { text: tSms.askTitle }), h('span', { class: 'meta', text: tSms.askMeta })),
    ),
    heldLine(a),
    who,
    h('p', { class: 'approve-what sms-text', text: a.what }),
    s.error ? h('p', { class: 'field-err', text: s.error }) : undefined,
    h(
      'div',
      { class: 'approve-actions' },
      h('button', { class: 'btn-ghost', text: tAppr.reject, onclick: () => void decide(a, 'reject') }),
      holdButton({
        label: tSms.hold,
        done: tSms.done,
        cls: 'btn btn-approve',
        onDone: () => sendSms(a),
        after: () => markDecided(a, 'approve'),
      }),
    ),
  )
}

/** Why auto-approve sent this one as a card (ADR 0030 amendment). Nothing when it was a normal request */
export function heldLine(a: ApprovalView): HTMLElement | undefined {
  if (!a.held) return undefined
  return h('p', {
    class: 'approve-held',
    text: a.held === 'unrelated' ? tAppr.heldUnrelated : tAppr.heldUnchecked,
  })
}
