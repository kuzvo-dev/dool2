// Phone app: payment method sheets (my methods and adding one)
import {
  CARD_ISSUERS,
  PAY_KINDS,
  type PayKind,
  type PayMethod,
  payMethodDetail,
  payMethodLabel,
  payMethodTitle,
} from '@dool2/protocol/pay-methods'
import { h, icon } from '../dom.js'
import { lang } from '../lang.js'
import { mdSheets } from '../locales/main-d-sheets.js'
import { mSet, send, st } from './core.js'
import { openOverlay, render, toast } from './shell.js'

/** Payment method mark: pay apps get a colored first letter, cards get a card picture */
const PAY_LETTER: Partial<Record<PayKind, string>> = {
  naverpay: 'N',
  kakaopay: 'K',
  tosspay: 'T',
  payco: 'P',
  samsungpay: 'S',
  applepay: 'A',
  smilepay: 'S',
  ssgpay: 'S',
  lpay: 'L',
}

function payMark(kind: PayKind): HTMLElement {
  const letter = PAY_LETTER[kind]
  const mark = h('span', { class: `pay-mark pay-${kind}`, text: letter ?? '' })
  if (!letter) mark.append(icon('card', 'i'))
  return mark
}

/** Send the whole list to the PC (the PC checks it, saves it and returns the saved list) */
function savePayMethods(list: PayMethod[]) {
  if (st.profile) st.profile = { ...st.profile, payMethods: list }
  void send({ kind: 'pay-methods-set', methods: list })
  render()
}

/** Settings > payment methods: the top one is the main method. At payment, the first one the site accepts is picked */
export function paySheet() {
  const sheet = h('section', { class: 'sheet float app-sheet rise info-sheet pay-sheet' })
  sheet.append(
    h(
      'div',
      { class: 'approve-head' },
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: mSet.payMethods }),
        h('span', { class: 'meta', text: mSet.paySub }),
      ),
    ),
  )
  const list = st.profile?.payMethods
  if (!list) {
    sheet.append(h('p', { class: 'meta', text: mSet.loading }))
    return sheet
  }
  if (!list.length)
    sheet.append(
      h('p', {
        class: 'pay-empty',
        text: mSet.payEmpty,
      }),
    )
  const ul = h('ul', { class: 'pay-list' })
  list.forEach((m, i) => {
    const detail = payMethodDetail(m, lang)
    ul.append(
      h(
        'li',
        { class: 'pay-row' },
        payMark(m.kind),
        h(
          'span',
          { class: 'row-text' },
          h(
            'span',
            { class: 'row-t' },
            payMethodTitle(m, lang),
            i === 0 ? h('span', { class: 'pay-main', text: mSet.payMainTag }) : '',
          ),
          detail ? h('span', { class: 'row-d', text: detail }) : '',
        ),
        i > 0
          ? h('button', {
              class: 'btn-text',
              text: mSet.makeMain,
              onclick: () => savePayMethods([m, ...list.filter((x) => x.id !== m.id)]),
            })
          : '',
        h('button', {
          class: 'btn-text danger',
          text: mSet.remove,
          onclick: () => {
            if (!confirm(mSet.removePayConfirm(payMethodLabel(m, lang)))) return
            savePayMethods(list.filter((x) => x.id !== m.id))
          },
        }),
      ),
    )
  })
  if (list.length) sheet.append(ul)
  sheet.append(
    h('button', {
      class: 'btn lg',
      text: mSet.payAdd,
      onclick: () => {
        st.payDraft = { inner: '', issuer: '', nickname: '', last4: '' }
        openOverlay({ kind: 'pay-add' })
      },
    }),
  )
  // What was picked last time for each site (used when my payment methods are not on that site)
  const pays = Object.entries(st.profile?.payChoices ?? {})
  if (pays.length) {
    sheet.append(h('h3', { class: 'over', text: mSet.lastChosen }))
    for (const [host, label] of pays)
      sheet.append(
        h(
          'div',
          { class: 'pay-row' },
          h(
            'span',
            { class: 'row-text' },
            h('span', { class: 'row-t', text: label }),
            h('span', { class: 'row-d', text: host.replace(/^www\./, '') }),
          ),
          h('button', {
            class: 'btn-text',
            text: mSet.forget,
            onclick: () => void send({ kind: 'pay-choice-forget', host }),
          }),
        ),
      )
  }
  sheet.append(h('p', { class: 'lock-note' }, icon('lock'), mSet.payNote))
  return sheet
}

/** Add payment method: pick a type, then for pay apps what is used inside (optional), for cards the issuer, nickname and last 4 digits */
export function payAddSheet() {
  const d = st.payDraft
  const sheet = h('section', { class: 'sheet float app-sheet rise info-sheet pay-sheet' })
  sheet.append(
    h(
      'div',
      { class: 'approve-head' },
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: mSet.payAdd }),
        h('span', { class: 'meta', text: mSet.payAddSub }),
      ),
    ),
  )
  const pick = (kind: PayKind) => {
    st.payDraft = { ...d, kind }
    render()
  }
  sheet.append(
    h(
      'div',
      { class: 'approve-choices' },
      h('span', { class: 'meta', text: mdSheets.payHow }),
      h(
        'div',
        { class: 'chip-row' },
        ...(Object.keys(PAY_KINDS) as PayKind[]).map((k) =>
          h('button', {
            class: `chip${d.kind === k ? ' on' : ''}`,
            text: PAY_KINDS[k],
            onclick: () => pick(k),
          }),
        ),
      ),
    ),
  )
  if (!d.kind) return sheet
  const field = (id: string, label: string, key: 'inner' | 'nickname' | 'last4', placeholder: string) => {
    const input = h('input', { class: 'field' })
    input.id = id
    input.value = d[key]
    input.placeholder = placeholder
    input.setAttribute('aria-label', label)
    input.oninput = () => {
      st.payDraft[key] = input.value
    }
    if (key === 'last4') {
      input.inputMode = 'numeric'
      input.maxLength = 4
    }
    return h('label', { class: 'field-label' }, h('span', { class: 'meta', text: label }), input)
  }
  const form = h('form', { class: 'cred-form profile-form' })
  if (d.kind === 'card') {
    form.append(
      h(
        'div',
        { class: 'approve-choices' },
        h('span', { class: 'meta', text: mdSheets.issuer }),
        h(
          'div',
          { class: 'chip-row' },
          ...CARD_ISSUERS.map((c) =>
            h('button', {
              class: `chip${d.issuer === c ? ' on' : ''}`,
              text: c,
              onclick: (e: Event) => {
                e.preventDefault()
                st.payDraft = { ...st.payDraft, issuer: c }
                render()
              },
            }),
          ),
        ),
      ),
      field('pay-nickname', mdSheets.nicknameLabel, 'nickname', mdSheets.nicknamePh),
      field('pay-last4', mdSheets.last4Label, 'last4', mdSheets.last4Ph),
    )
  } else form.append(field('pay-inner', mdSheets.innerLabel(PAY_KINDS[d.kind]), 'inner', mdSheets.innerPh))
  const go = h('button', { class: 'btn lg', text: mdSheets.register })
  go.type = 'submit'
  form.append(go)
  form.onsubmit = (e) => {
    e.preventDefault()
    const now = st.payDraft
    if (!now.kind) return
    if (now.kind === 'card' && !now.issuer) return toast(mdSheets.pickIssuer)
    if (now.last4 && !/^\d{4}$/.test(now.last4.trim())) return toast(mdSheets.last4Err)
    const m: PayMethod = {
      id: crypto.randomUUID(),
      kind: now.kind,
      addedAt: new Date().toISOString(),
      ...(now.kind === 'card'
        ? {
            issuer: now.issuer,
            ...(now.nickname.trim() ? { nickname: now.nickname.trim() } : {}),
            ...(now.last4.trim() ? { last4: now.last4.trim() } : {}),
          }
        : now.inner.trim()
          ? { inner: now.inner.trim() }
          : {}),
    }
    savePayMethods([...(st.profile?.payMethods ?? []), m])
    openOverlay({ kind: 'pay' })
  }
  sheet.append(form, h('p', { class: 'lock-note' }, icon('lock'), mdSheets.noSecrets))
  return sheet
}
