// Phone app: the approval detail sheet
import { doori, h, icon } from '../dom.js'
import { mdSheets } from '../locales/main-d-sheets.js'
import { holdButton } from '../motion.js'
import { approveQuestion, checkoutCard, hostOf, itemsList } from './approval-cards.js'
import { send, st } from './core.js'
import { choiceRow, choseRow, decide, finalLabel, markDecided, shipRow } from './decide.js'
import { openOverlay } from './shell.js'
import { isSms, smsCard } from './sms.js'

export function approvalSheet(id: string) {
  const a = st.approvals.get(id)
  const sheet = h('section', { class: 'sheet float app-sheet rise' })
  const close = h(
    'button',
    { class: 'fbtn small sheet-x', label: mdSheets.close, onclick: () => openOverlay(undefined) },
    icon('close'),
  )
  if (!a) {
    sheet.append(close, h('p', { class: 'meta', text: mdSheets.loading }))
    return sheet
  }
  if (!a.shot && a.status === 'pending') void send({ kind: 'approval', id })
  if (a.kind === 'money' && a.status === 'pending' && !st.decided.get(id)) {
    sheet.append(close, checkoutCard(a, true))
    return sheet
  }
  if (isSms(a) && a.status === 'pending' && !st.decided.get(id)) {
    sheet.append(close, smsCard(a, true))
    return sheet
  }
  const rows = h('dl', { class: 'kv' })
  const row = (k: string, v?: string, cls?: string) =>
    v && rows.append(h('dt', { text: k }), h('dd', { text: v, ...(cls ? { class: cls } : {}) }))
  row(mdSheets.rowWhat, a.what)
  row(mdSheets.rowWhere, a.where)
  row(mdSheets.rowUrl, hostOf(a.url), 'host')
  const pc = a.kind === 'file' || a.kind === 'print' || a.kind === 'pc'
  row(pc ? mdSheets.rowKnow : mdSheets.rowCancel, a.cancel)
  if (a.kind !== 'app' && !pc) row(mdSheets.rowButton, `"${finalLabel(a)}"`)
  const items = itemsList(a, 100)
  if (items)
    rows.append(
      h('dt', { text: a.kind === 'print' ? mdSheets.rowFile : mdSheets.rowList(a.items?.length) }),
      h('dd', {}, items),
    )
  sheet.append(
    close,
    h(
      'div',
      { class: 'approve-head' },
      doori('asking', 40),
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: approveQuestion(a) }),
        h('span', { class: 'meta', text: [a.where, st.saved?.pcName].filter(Boolean).join(' · ') }),
      ),
    ),
    ...(a.amount ? [h('p', { class: 'approve-amount', text: a.amount })] : []),
    rows,
  )
  const chose = choseRow(a)
  if (chose) sheet.append(chose)
  const ship = a.status === 'pending' ? shipRow(a) : undefined
  if (ship) sheet.append(ship)
  const pick = a.status === 'pending' ? choiceRow(a) : undefined
  if (pick) sheet.append(pick)
  if (a.shot) {
    const img = h('img', { class: 'sheet-shot' })
    img.alt = mdSheets.pcScreen
    img.src = `data:image/jpeg;base64,${a.shot}`
    sheet.append(img)
  }
  const done = st.decided.get(id)
  if (a.status !== 'pending' || done) {
    sheet.append(
      h('p', {
        class: 'done-line',
        text:
          done?.message ??
          a.result ??
          (a.status === 'rejected'
            ? mdSheets.rejected
            : a.status === 'expired'
              ? mdSheets.expiredLong
              : mdSheets.handled),
      }),
    )
    return sheet
  }
  sheet.append(
    h('p', {
      class: 'meta',
      text:
        a.kind === 'file'
          ? mdSheets.hintFile
          : a.kind === 'pc'
            ? mdSheets.hintPc
            : a.kind === 'print'
              ? mdSheets.hintPrint
              : mdSheets.hintMoney,
    }),
    h(
      'div',
      { class: 'approve-actions' },
      h('button', { class: 'btn-ghost lg', text: mdSheets.reject, onclick: () => void decide(a, 'reject') }),
      holdButton({
        label: a.kind === 'app' ? mdSheets.holdAllow : mdSheets.holdApprove,
        done: a.kind === 'app' ? mdSheets.allowed : mdSheets.approved,
        cls: 'btn btn-approve lg',
        onDone: () => decide(a, 'approve', true),
        after: () => markDecided(a, 'approve'),
      }),
    ),
  )
  return sheet
}
