// Phone app: approval cards in the chat (checkout card, delivery and payment pickers, items to approve)
import type { ApprovalRecordMessage, ApprovalView, ConnectRecordMessage } from '@dool2/protocol'
import { findCard } from '@dool2/protocol/connect-text'
import { h, type IconName, icon, withLogo } from '../dom.js'
import { holdButton } from '../motion.js'
import {
  MY_ADDRESS_PREFIX,
  MY_ADDRESS_PREFIX_RE,
  PEOPLE_LABEL_RE,
  REQUEST_LABEL_RE,
  TICKET_LABEL_RE,
  TIME_LABEL_RE,
  WHEN_LABEL_RE,
} from '../region/kr/main-b-approval.js'
import { FILE_MOVE_LABEL, FILE_RESTORE_LABEL } from '../region/kr/main-c-labels.js'
import { thumbOf } from './cards.js'
import { approvalFor } from './chat.js'
import { mCards, st, tAppr } from './core.js'
import {
  choiceRow,
  chosenOf,
  choseRow,
  decide,
  markDecided,
  shipChosenOf,
  shipRow,
  subChosenOf,
  subsFor,
} from './decide.js'
import { openOverlay, render, toast } from './shell.js'
import { heldLine, isSms, smsCard } from './sms.js'

/** Approval card in the chat: what · how much · [Decline][Approve] */
export function approvalInline(rec: ApprovalRecordMessage): HTMLElement {
  const a = approvalFor(rec)
  const decided = a ? st.decided.get(a.id) : undefined
  if (!a || a.status !== 'pending' || decided) {
    // Once decided, one line: Approved · 15,900 won · Jeju tangerines 3kg, buy now
    const what = a?.what || rec.what || tAppr.request
    const failed = (decided && !decided.ok) || a?.status === 'failed'
    const sms = a ? isSms(a) : rec.ref === 'sms'
    const head = failed
      ? sms
        ? tAppr.notSent
        : tAppr.notTapped
      : a?.status === 'rejected'
        ? tAppr.rejected
        : a?.status === 'expired'
          ? tAppr.expired
          : a?.auto && !sms
            ? tAppr.autoDone
            : a || decided
              ? sms
                ? tAppr.sent
                : tAppr.approved
              : ''
    return h(
      'p',
      { class: `done-line${failed ? ' warn' : ''}` },
      icon(failed || a?.status === 'rejected' ? 'close' : 'check'),
      [head, a?.amount, failed ? (decided?.message ?? what) : what].filter(Boolean).join(' · '),
    )
  }
  if (a.kind === 'money') return checkoutCard(a)
  if (isSms(a)) return smsCard(a)
  const tone: IconName = a.kind === 'contact' ? 'mail' : 'hand'
  return h(
    'div',
    { class: 'card approve-card' },
    h(
      'div',
      { class: 'approve-head' },
      h('span', { class: 'tile amber' }, icon(tone, 'i md')),
      h(
        'div',
        {},
        h('strong', { text: approveQuestion(a) }),
        h('span', { class: 'meta', text: [a.where, hostOf(a.url)].filter(Boolean).join(' · ') }),
      ),
    ),
    heldLine(a),
    a.amount && h('p', { class: 'approve-amount', text: a.amount }),
    h('p', { class: 'approve-what', text: a.what }),
    itemsList(a, 5),
    choseRow(a),
    shipRow(a),
    choiceRow(a),
    h(
      'div',
      { class: 'approve-actions' },
      h('button', { class: 'btn-ghost', text: tAppr.reject, onclick: () => void decide(a, 'reject') }),
      holdButton({
        label: tAppr.holdApprove,
        done: tAppr.approved,
        cls: 'btn btn-approve',
        onDone: () => decide(a, 'approve', true),
        after: () => markDecided(a, 'approve'),
      }),
    ),
    h('button', {
      class: 'btn-link',
      text: tAppr.viewScreen,
      onclick: () => openOverlay({ kind: 'approval', id: a.id }),
    }),
  )
}

/**
 * Checkout card (user mockup, 11-20): the same frame for every payment. Shop, goods, amount, delivery address, payment method, info rows, and a big pay button at the bottom.
 * Tapping a whole delivery or payment row opens a picker sheet. Approval happens once, on this card
 */
export function checkoutCard(a: ApprovalView & { shot?: string }, inSheet = false): HTMLElement {
  const host = hostOf(a.url)
  const name = a.where || host
  // One arrival or usage time goes in the header line (not repeated in the row list)
  const when = (a.info ?? []).find((x) => WHEN_LABEL_RE.test(x.label))
  const head = h(
    'div',
    { class: 'co-head' },
    withLogo(h('span', { class: 'svc-mark lg', text: [...name][0] ?? '' }), cardIdFor(a.url)),
    h(
      'div',
      { class: 'co-head-t' },
      h('strong', { text: a.title || name }),
      h('span', {
        class: 'meta',
        text: [a.title ? name : host, when?.value].filter(Boolean).join(' · '),
      }),
    ),
  )
  const goods = (a.goods ?? []).length
    ? h(
        'div',
        { class: 'co-goods' },
        ...(a.goods ?? []).map((g) => {
          const th = h('span', { class: 'co-th' }, icon('box', 'i'))
          if (g.image)
            void thumbOf(g.image).then((data) => {
              if (!data) return
              const img = h('img', { class: 'co-th' }) as HTMLImageElement
              img.src = data
              img.alt = ''
              th.replaceWith(img)
            })
          return h(
            'div',
            { class: 'co-good' },
            th,
            h(
              'div',
              { class: 'co-good-t' },
              h('span', { class: 'co-nm', text: g.name }),
              ...(g.option || g.qty
                ? [h('span', { class: 'meta', text: [g.option, g.qty].filter(Boolean).join(' · ') })]
                : []),
            ),
            ...(g.price ? [h('span', { class: 'co-pr', text: g.price })] : []),
          )
        }),
      )
    : h('p', { class: 'co-what', text: a.what })
  const amount = h(
    'div',
    { class: 'co-amt' },
    ...(a.lines ?? []).map((l) =>
      h(
        'div',
        { class: `co-ln${l.kind === 'discount' ? ' minus' : ''}` },
        h('span', { text: l.label }),
        h('span', { text: l.value }),
      ),
    ),
    ...(a.amount
      ? [h('div', { class: 'co-tot' }, h('span', { text: tAppr.total }), h('b', { text: a.amount }))]
      : []),
  )
  const row = (ic: IconName, k: string, v: string, onclick?: () => void, warn = false) =>
    h(
      onclick ? 'button' : 'div',
      { class: `co-row${warn ? ' warn' : ''}${onclick ? ' tap' : ''}`, ...(onclick ? { onclick } : {}) },
      icon(ic, 'i co-ic'),
      h(
        'span',
        { class: 'co-row-t' },
        h('span', { class: 'co-k', text: k }),
        h('span', { class: 'co-v', text: v }),
      ),
      ...(onclick ? [icon('chevron', 'i co-chev')] : []),
    )
  const rows: HTMLElement[] = []
  const ship = shipChosenOf(a)
  if (a.shipOptions?.length) {
    const cur = ship?.startsWith('n:')
      ? tAppr.newAddr(decodeURIComponent(ship.slice(2)))
      : (a.shipOptions.find((o) => o.id === ship) ?? a.shipOptions[0])?.label.replace(
          MY_ADDRESS_PREFIX_RE,
          '',
        )
    const warn = Boolean(a.shipWarn) && (ship ?? 'a0') === 'a0'
    rows.push(
      row(
        'place',
        warn ? tAppr.shipWarn : tAppr.ship,
        cur ?? '',
        () => openOverlay({ kind: 'pick-ship', id: a.id, back: inSheet }),
        warn,
      ),
    )
  }
  for (const x of a.info ?? []) {
    if (x === when) continue
    const ic: IconName = REQUEST_LABEL_RE.test(x.label)
      ? 'chat'
      : TIME_LABEL_RE.test(x.label)
        ? 'clock'
        : PEOPLE_LABEL_RE.test(x.label)
          ? 'users'
          : TICKET_LABEL_RE.test(x.label)
            ? 'ticket'
            : 'note'
    rows.push(row(ic, x.label, x.value))
  }
  if (a.choices?.length || subsFor(a).length) {
    const main = a.choices?.find((c) => c.id === chosenOf(a))
    const subs = subsFor(a)
      .map((g) => g.options.find((o) => o.id === subChosenOf(a, g))?.label ?? '')
      .filter(Boolean)
    rows.push(
      row(
        'card',
        a.choiceTitle ?? tAppr.payMethod,
        [main?.label, ...subs].filter(Boolean).join(' · ') || tAppr.choose,
        () => openOverlay({ kind: 'pick-pay', id: a.id, back: inSheet }),
      ),
    )
  }
  const fine = [a.cancel, a.chose?.length ? tAppr.chose(a.chose.join(' · ')) : ''].filter(Boolean).join(' · ')
  const shot =
    inSheet && a.shot
      ? (() => {
          const img = h('img', { class: 'sheet-shot' }) as HTMLImageElement
          img.alt = tAppr.pcScreenAlt
          img.src = `data:image/jpeg;base64,${a.shot}`
          return h(
            'details',
            { class: 'co-shot' },
            h('summary', { class: 'meta', text: tAppr.viewPcCheckout }),
            img,
          )
        })()
      : undefined
  return h(
    'div',
    { class: `card co-card${inSheet ? ' in-sheet' : ''}` },
    head,
    goods,
    amount,
    ...(rows.length ? [h('div', { class: 'co-rows' }, ...rows)] : []),
    ...(fine ? [h('p', { class: 'co-fine', text: fine })] : []),
    ...(shot ? [shot] : []),
    h(
      'div',
      { class: 'co-actions' },
      h('button', { class: 'btn-ghost', text: tAppr.reject, onclick: () => void decide(a, 'reject') }),
      holdButton({
        label: tAppr.holdPay(a.amount),
        done: tAppr.approved,
        cls: 'btn btn-approve',
        onDone: () => decide(a, 'approve', true),
        after: () => markDecided(a, 'approve'),
      }),
    ),
    h('p', { class: 'co-lock' }, icon('lock', 'i'), tAppr.afterNote(a.after)),
    ...(inSheet
      ? []
      : [
          h('button', {
            class: 'btn-link',
            text: tAppr.viewPcCheckout,
            onclick: () => openOverlay({ kind: 'approval', id: a.id }),
          }),
        ]),
  )
}

/** Delivery address picker sheet: address on screen, saved address, my info address, new address */
export function shipPicker(id: string, back = false): HTMLElement {
  const a = st.approvals.get(id)
  const sheet = h('section', { class: 'sheet float app-sheet rise pick-sheet' })
  if (!a?.shipOptions?.length) return sheet
  const key = `${a.id}:ship`
  const now = shipChosenOf(a) ?? 'a0'
  const isNew = now.startsWith('n:')
  const input = h('input', { class: 'field' }) as HTMLInputElement
  input.placeholder = tAppr.addrPlaceholder
  input.value = isNew ? decodeURIComponent(now.slice(2)) : ''
  const opt = (
    on: boolean,
    title: string,
    sub: string | undefined,
    tag: string | undefined,
    pick: () => void,
    extra?: HTMLElement,
  ) =>
    h(
      'button',
      { class: `pick-opt${on ? ' on' : ''}`, onclick: pick },
      h('span', { class: 'pick-radio' }),
      h(
        'span',
        { class: 'pick-t' },
        h(
          'span',
          { class: 'pick-name' },
          title,
          ...(tag ? [h('span', { class: 'pick-tag', text: tag })] : []),
        ),
        ...(sub ? [h('span', { class: 'meta', text: sub })] : []),
        ...(extra ? [extra] : []),
      ),
    )
  sheet.append(
    h('h3', { class: 'title-2', text: tAppr.whereTitle }),
    ...(a.shipWarn ? [h('p', { class: 'field-err', text: `⚠ ${a.shipWarn}` })] : []),
    ...a.shipOptions.map((o, i) => {
      const mine = o.label.startsWith(MY_ADDRESS_PREFIX)
      return opt(
        now === o.id,
        mine ? tAppr.home : i === 0 ? tAppr.screenAddr : tAppr.savedAddr,
        o.label.replace(MY_ADDRESS_PREFIX_RE, ''),
        mine ? tAppr.myInfo : undefined,
        () => {
          st.choice.set(key, o.id)
          render()
        },
      )
    }),
    opt(
      isNew,
      tAppr.newAddrBtn,
      undefined,
      undefined,
      () => {
        if (!isNew) st.choice.set(key, 'n:')
        render()
        queueMicrotask(() => document.querySelector<HTMLInputElement>('.pick-sheet .field')?.focus())
      },
      isNew ? input : undefined,
    ),
    h('button', {
      class: 'btn lg',
      text: tAppr.useAddr,
      onclick: () => {
        if (isNew) {
          const v = input.value.trim()
          if (!v) return toast(tAppr.enterAddr)
          st.choice.set(key, `n:${encodeURIComponent(v.slice(0, 100))}`)
        }
        // If opened from the checkout sheet, go back to that card
        openOverlay(back ? { kind: 'approval', id } : undefined)
      },
    }),
  )
  return sheet
}

/** Payment method picker sheet: one row per method, with card and installments inside the chosen method as select boxes */
export function payPicker(id: string, back = false): HTMLElement {
  const a = st.approvals.get(id)
  const sheet = h('section', { class: 'sheet float app-sheet rise pick-sheet' })
  if (!a) return sheet
  const main = chosenOf(a)
  const groups = (forMain: string | undefined) =>
    (a.subChoices ?? []).filter((g) => !g.when || !forMain || g.when === forMain)
  const subsOf = (forMain: string | undefined) =>
    groups(forMain).map((g) => {
      const sel = h('select', { class: 'field select-field' }) as HTMLSelectElement
      for (const o of g.options) {
        const el = document.createElement('option')
        el.value = o.id
        el.textContent = o.label
        if (o.id === subChosenOf(a, g)) el.selected = true
        sel.append(el)
      }
      sel.onclick = (e) => e.stopPropagation()
      sel.onchange = () => {
        st.choice.set(`${a.id}:${g.key}`, sel.value)
        render()
      }
      return h('label', { class: 'pick-sub' }, h('span', { class: 'meta', text: g.title }), sel)
    })
  const list = a.choices?.length ? a.choices : [{ id: '', label: mCards.nowPayMethod }]
  sheet.append(
    h('h3', { class: 'title-2', text: mCards.howToPay }),
    ...list.map((c) =>
      h(
        'button',
        {
          class: `pick-opt${c.id === (main ?? '') ? ' on' : ''}`,
          onclick: () => {
            if (c.id) st.choice.set(a.id, c.id)
            render()
          },
        },
        h('span', { class: 'pick-radio' }),
        h(
          'span',
          { class: 'pick-t' },
          h(
            'span',
            { class: 'pick-name' },
            c.label,
            ...(c.mine ? [h('span', { class: 'pick-tag', text: mCards.myPayMethod })] : []),
          ),
          ...(c.id === (main ?? '') ? subsOf(c.id || undefined) : []),
        ),
      ),
    ),
    h('button', {
      class: 'btn lg',
      text: mCards.useThis,
      onclick: () => openOverlay(back ? { kind: 'approval', id } : undefined),
    }),
  )
  return sheet
}

/** Items to approve (PC file moves and prints): the first max lines and how many are left */
export function itemsList(a: ApprovalView, max: number): HTMLElement | undefined {
  if (!a.items?.length) return undefined
  return h(
    'ul',
    { class: 'approve-items' },
    ...a.items.slice(0, max).map((line) => h('li', { text: line })),
    ...(a.items.length > max
      ? [h('li', { class: 'meta', text: mCards.moreItems(a.items.length - max) })]
      : []),
  )
}

export function approveQuestion(a: ApprovalView) {
  if (a.kind === 'money') return mCards.qMoney
  if (a.kind === 'contact') return isSms(a) ? mCards.qSms : mCards.qSend
  if (a.kind === 'app') return mCards.qApp
  if (a.kind === 'file')
    return a.label === FILE_MOVE_LABEL
      ? mCards.qFileMove
      : a.label === FILE_RESTORE_LABEL
        ? mCards.qFileRestore
        : mCards.qFileSave
  if (a.kind === 'print') return mCards.qPrint
  if (a.kind === 'pc') return mCards.qPc(a.label)
  return mCards.qGo
}

/** Which connect card's site a login address belongs to (for the logo) */
export function cardIdFor(url: string): string | undefined {
  const host = hostOf(url).replace(/^www\./, '')
  if (!host) return undefined
  return st.services?.find((s) => {
    const site = (s.card.site ?? '').replace(/^www\./, '')
    return site && (host === site || host.endsWith(`.${site}`))
  })?.card.id
}

export function hostOf(url: string) {
  if (url.startsWith('app:')) return ''
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

export function connectFor(rec: ConnectRecordMessage) {
  const services = st.services ?? []
  const card = findCard(
    services.map((s) => s.card),
    rec.service,
  )
  return card ? services.find((s) => s.card.id === card.id) : undefined
}
