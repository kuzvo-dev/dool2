// Phone app: approval choices (payment method, delivery place) and sending approve or decline
import type { ApprovalView } from '@dool2/protocol'
import { signText } from '@dool2/protocol/e2e'
import { approvalSignText, approveKeysSignText, payConfirmSignText } from '@dool2/protocol/link'
import { h } from '../dom.js'
import { lang } from '../lang.js'
import { mainApproval } from '../locales/main-a-approval.js'
import { approveKeys, approveSign, isNative } from '../native.js'
import { PREFERRED_INSTALLMENT } from '../region/kr/main-a-chat.js'
import { cardIdFor } from './approval-cards.js'
import { mark, mSet, send, st, tAppr } from './core.js'
import { render, toast } from './shell.js'

/** Option picked when approving (payment method). If none, the card's default */
export function chosenOf(a: ApprovalView): string | undefined {
  if (!a.choices?.length) return undefined
  return st.choice.get(a.id) ?? a.choice ?? a.choices[0]?.id
}

/** What was picked in a sub-choice (registered card, installments). If none, what was preselected on the payment screen */
export function subChosenOf(
  a: ApprovalView,
  g: NonNullable<ApprovalView['subChoices']>[number],
): string | undefined {
  return st.choice.get(`${a.id}:${g.key}`) ?? g.choice ?? g.options[0]?.id
}

/** Only the sub-choices of the current payment method (registered cards and installments exist only for cards) */
export function subsFor(a: ApprovalView) {
  const main = chosenOf(a)
  return (a.subChoices ?? []).filter((g) => !g.when || !main || g.when === main)
}

/** What was picked for the delivery place (default: the current address a0) */
export function shipChosenOf(a: ApprovalView): string | undefined {
  if (!a.shipOptions?.length) return undefined
  return st.choice.get(`${a.id}:ship`) ?? 'a0'
}

/** All picks to sign and send: payment method, sub-choices and a changed delivery place, comma-joined ("c2,s1o3,a1") */
function choiceString(a: ApprovalView): string | undefined {
  const ship = shipChosenOf(a)
  const parts = [
    chosenOf(a),
    ...subsFor(a).map((g) => subChosenOf(a, g)),
    ship && ship !== 'a0' && ship !== 'n:' ? ship : undefined,
  ].filter((x): x is string => !!x)
  return parts.length ? parts.join(',') : undefined
}

/** Delivery place: the current address on one line plus [Change]; expanded, it lists other saved addresses (everything is decided on one payment approval) */
export function shipRow(a: ApprovalView): HTMLElement | undefined {
  const opts = a.shipOptions
  if (!opts?.length) return undefined
  const now = shipChosenOf(a)
  const cur = opts.find((o) => o.id === now) ?? opts[0]
  const key = `${a.id}:ship`
  // If it differs from the address in My info, open it from the start with a warning
  const open = st.choice.has(`${key}:open`) || Boolean(a.shipWarn)
  if (!open)
    return h(
      'div',
      { class: 'approve-choices one-line' },
      h('span', { class: 'meta', text: mainApproval(lang).shipTo(cur?.label ?? '') }),
      h('button', {
        class: 'chip chip-more',
        text: mainApproval(lang).change,
        onclick: () => {
          st.choice.set(`${key}:open`, '1')
          render()
        },
      }),
    )
  // New address: deliver somewhere that site does not have yet (Dool2 adds it to the site's addresses, then pays)
  const isNew = now?.startsWith('n:')
  const input = h('input', { class: 'field' }) as HTMLInputElement
  input.placeholder = mainApproval(lang).newAddressPlaceholder
  input.value = isNew ? decodeURIComponent(now?.slice(2) ?? '') : ''
  input.onchange = () => {
    const v = input.value.trim()
    if (v) st.choice.set(key, `n:${encodeURIComponent(v.slice(0, 100))}`)
  }
  return h(
    'div',
    { class: 'approve-choices' },
    h('span', { class: 'meta', text: mainApproval(lang).shipWhere }),
    ...(a.shipWarn ? [h('p', { class: 'field-err ship-warn', text: `⚠ ${a.shipWarn}` })] : []),
    h(
      'div',
      { class: 'choice-list' },
      ...opts.map((o) =>
        h('button', {
          class: `chip${o.id === now ? ' on' : ''}`,
          text: o.label,
          onclick: () => {
            st.choice.set(key, o.id)
            render()
          },
        }),
      ),
      h('button', {
        class: `chip${isNew ? ' on' : ''}`,
        text: mainApproval(lang).newAddress,
        onclick: () => {
          if (!isNew) st.choice.set(key, 'n:')
          render()
        },
      }),
    ),
    ...(isNew ? [input] : []),
  )
}

export async function decide(a: ApprovalView, decision: 'approve' | 'reject', quiet = false) {
  const s = st.saved
  if (!s) return
  // The chosen payment method, card and installment are signed too (nobody in between can swap them)
  const choice = decision === 'approve' ? choiceString(a) : undefined
  const text = approvalSignText(a, decision, choice)
  let sig: string
  let key: 'pay' | 'plain' | undefined
  if (isNative() && st.pc?.approveKeys) {
    // Security-chip keys (ADR 0043): a payment or transfer is signed only after the phone lock, unless turned off
    key = decision === 'approve' && a.kind === 'money' && st.pc.payConfirm ? 'pay' : 'plain'
    const r = await approveSign(
      key,
      text,
      tAppr.payCheckTitle,
      [a.what, a.amount].filter(Boolean).join(' · '),
    )
    // Throwing rolls the hold button back, so the approval stays open
    if (r === 'cancel') throw new Error(tAppr.payCheckCancel)
    if (!r) {
      toast(tAppr.signFailed)
      throw new Error(tAppr.signFailed)
    }
    sig = r
  }
  // Older app or browser: the pairing key. The PC verifies it with the public key it received at pairing
  else sig = await signText(s.keys.signPriv, text)
  // Hold-to-approve folds the card after showing the check (markDecided is called later)
  if (!quiet) markDecided(a, decision)
  await send({
    kind: 'decide',
    id: a.id,
    decision,
    sig,
    ...(choice ? { choice } : {}),
    ...(key ? { key } : {}),
  })
}

/**
 * Store app: registers this phone's security-chip approval keys with the PC (ADR 0043), signed with the pairing key.
 * Also adds the pay key later if the phone got a screen lock after the keys were first sent
 */
let keysSyncing = false
export async function syncApproveKeys() {
  const s = st.saved
  if (keysSyncing || !isNative() || !s || !st.pc || (st.pc.approveKeys && st.pc.payKey)) return
  keysSyncing = true
  try {
    const k = await approveKeys()
    if (!k || (st.pc.approveKeys && !k.pay)) return
    const at = Date.now()
    const sig = await signText(s.keys.signPriv, approveKeysSignText(k, at))
    await send({ kind: 'approve-keys', plain: k.plain, ...(k.pay ? { pay: k.pay } : {}), at, sig })
  } finally {
    keysSyncing = false
  }
}

/** Phone lock for payment approvals on or off (ADR 0043). Off is signed with the pay key, so it takes the lock too */
export async function setPayConfirm(on: boolean) {
  if (!on && !confirm(mSet.payLockOffAsk)) return
  const at = Date.now()
  const key = on ? 'plain' : 'pay'
  const sig = await approveSign(key, payConfirmSignText(on, at), mSet.payLockOffTitle)
  if (!sig || sig === 'cancel') return
  mark(`pay confirm ${on ? 'on' : 'off'}`)
  await send({ kind: 'pay-confirm', on, at, sig, key })
}

/** Final button label that follows the chosen payment method ("Pay by card" becomes "Pay with Naver Pay" when that is picked) */
export function finalLabel(a: ApprovalView): string {
  const now = a.choices?.find((c) => c.id === chosenOf(a))
  if (!now) return a.label
  const from = a.choices?.find((c) => a.label.startsWith(c.label))
  return from ? `${now.label}${a.label.slice(from.label.length)}` : a.label
}

/** The "which payment method?" row of an approval card (only methods the site accepts; default is the last one used on this site) */
/**
 * With many options (12-month installments and so on) show the common ones first: the current pick, pay-in-full and interest-free, a few from the top. The rest sit behind [More]
 * (measured on Coupang installments: 12 chips from pay-in-full to 12 months made the approval card long)
 */
function shown<T extends { id: string; label: string }>(
  options: T[],
  now: string | undefined,
  key: string,
): T[] {
  if (options.length <= 6 || st.choice.get(`${key}:more`)) return options
  const keep = options.filter((o, i) => i < 3 || PREFERRED_INSTALLMENT.test(o.label)).slice(0, 5)
  // The current pick is always shown
  const cur = options.find((o) => o.id === now)
  if (cur && !keep.includes(cur)) keep.push(cur)
  return keep.length < options.length ? keep : options
}

export function choiceRow(a: ApprovalView): HTMLElement | undefined {
  const subs = subsFor(a)
  if (!a.choices?.length && !subs.length) return undefined
  const row = (
    title: string,
    options: { id: string; label: string; mine?: string }[],
    now: string | undefined,
    key: string,
  ) =>
    // With many options (registered cards, installments, banks) use one select box instead of chips (real use on 11-20: a long row of chips was hard to choose from)
    options.length > 4
      ? selectRow(title, options, now, (id) => {
          st.choice.set(key, id)
          render()
        })
      : h(
          'div',
          { class: 'approve-choices' },
          h('span', { class: 'meta', text: title }),
          h(
            'div',
            { class: 'chip-row' },
            ...shown(options, now, key).map((c) => {
              // A chip that matches my payment method gets a dot (ADR 0023)
              const chip = h(
                'button',
                {
                  class: `chip${c.id === now ? ' on' : ''}${c.mine ? ' mine' : ''}`,
                  onclick: () => {
                    st.choice.set(key, c.id)
                    render()
                  },
                },
                c.mine ? h('span', { class: 'mine-dot' }) : '',
                c.label,
              )
              if (c.mine) chip.setAttribute('aria-label', mainApproval(lang).mineAria(c.label, c.mine ?? ''))
              return chip
            }),
            ...(shown(options, now, key).length < options.length
              ? [
                  h('button', {
                    class: 'chip chip-more',
                    text: mainApproval(lang).more(options.length - shown(options, now, key).length),
                    onclick: () => {
                      st.choice.set(`${key}:more`, '1')
                      render()
                    },
                  }),
                ]
              : []),
          ),
        )
  // If nothing was changed yet, summarize on one line (Card · Shinhan Card · Pay in full [Change]). Tapping [Change] opens the chips
  const groups: {
    title: string
    options: { id: string; label: string; mine?: string }[]
    now?: string
    key: string
  }[] = [
    ...(a.choices?.length
      ? [
          {
            title: a.choices.some((c) => c.mine)
              ? mainApproval(lang).titleMine(a.choiceTitle ?? mainApproval(lang).payMethod)
              : mainApproval(lang).titleAsk(a.choiceTitle ?? mainApproval(lang).payMethod),
            options: a.choices,
            now: chosenOf(a),
            key: a.id,
          },
        ]
      : []),
    ...subs.map((g) => ({
      title: g.title,
      options: g.options,
      now: subChosenOf(a, g),
      key: `${a.id}:${g.key}`,
    })),
  ]
  const touched = groups.some((g) => st.choice.has(g.key))
  if (groups.length > 1 && !touched && !st.choice.has(`${a.id}:open`)) {
    const summary = groups
      .map((g) => g.options.find((o) => o.id === g.now)?.label ?? '')
      .filter(Boolean)
      .join(' · ')
    return h(
      'div',
      { class: 'approve-choices one-line' },
      h('span', {
        class: 'meta',
        text: mainApproval(lang).titleSummary(a.choiceTitle ?? mainApproval(lang).payMethod, summary),
      }),
      h('button', {
        class: 'chip chip-more',
        text: mainApproval(lang).change,
        onclick: () => {
          st.choice.set(`${a.id}:open`, '1')
          render()
        },
      }),
    )
  }
  return h('div', {}, ...groups.map((g) => row(g.title, g.options, g.now, g.key)))
}

/** Select box row: a title and a list to pick from (the phone's own picker opens). My payment methods get a ● */
function selectRow(
  title: string,
  options: { id: string; label: string; mine?: string }[],
  now: string | undefined,
  onPick: (id: string) => void,
): HTMLElement {
  const sel = h('select', { class: 'field select-field' }) as HTMLSelectElement
  for (const o of options) {
    const opt = document.createElement('option')
    opt.value = o.id
    opt.textContent = `${o.mine ? '● ' : ''}${o.label}`
    if (o.id === now) opt.selected = true
    sel.append(opt)
  }
  sel.setAttribute('aria-label', title)
  sel.onchange = () => onPick(sel.value)
  return h('label', { class: 'approve-choices select-row' }, h('span', { class: 'meta', text: title }), sel)
}

/** Shows what Dool2 picked by itself before paying (no insurance, terms accepted and so on) as its own line */
export function choseRow(a: ApprovalView): HTMLElement | undefined {
  if (!a.chose?.length) return undefined
  return h(
    'div',
    { class: 'approve-chose' },
    h('span', { class: 'meta', text: mainApproval(lang).choseTitle }),
    h('p', { text: a.chose.join(' · ') }),
  )
}

export function markDecided(a: ApprovalView, decision: 'approve' | 'reject') {
  if (st.decided.has(a.id)) return
  st.decided.set(a.id, {
    ok: true,
    message: decision === 'approve' ? mainApproval(lang).approveSent : mainApproval(lang).rejectSent,
  })
  render()
}

export const pendingApprovals = () =>
  [...st.approvals.values()].filter((a) => a.status === 'pending' && !st.decided.has(a.id))
/** Pending logins, minus expired ones and ones whose service is already connected */
export const pendingLogins = () =>
  [...st.logins.values()].filter((l) => {
    if (l.status !== 'pending' || Date.parse(l.expiresAt) <= Date.now()) return false
    const cid = cardIdFor(l.origin)
    const svc = cid ? st.services?.find((x) => x.card.id === cid) : undefined
    return !(svc?.connectedAt && Date.parse(svc.connectedAt) >= Date.parse(l.createdAt))
  })
