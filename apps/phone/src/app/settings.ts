// Phone app: the settings page, my info and the vault sheets
import { LANG_NAMES, LANGS } from '@dool2/i18n'
import { AUTH_APPS, agentLabel, CARRIERS } from '@dool2/protocol'
import { payMethodLabel } from '@dool2/protocol/pay-methods'
import { doori, h, type IconName, icon, segBtn } from '../dom.js'
import { lang, setLang } from '../lang.js'
import { tDoori } from '../locales/doori-maker.js'
import { confirmDevice, isNative } from '../native.js'
import { mSet, send, st } from './core.js'
import { setPayConfirm } from './decide.js'
import { forgetPc, resetAll, setAutoApprove } from './link.js'
import { autoHyphen, choiceChips } from './login-sheets.js'
import { renamePc } from './overlays.js'
import { appPush, syncAppPush, syncPush } from './push.js'
import { openOverlay, render, setTab, toast } from './shell.js'

export function settingsView() {
  const box = h('section', { class: 'tab-page settings' }, h('h1', { class: 'ptitle', text: mSet.settings }))
  const row = (ic: IconName, title: string, sub: string, right?: Node, onclick?: () => void) =>
    h(
      onclick ? 'button' : 'div',
      { class: 'set-row', ...(onclick ? { onclick } : {}) },
      h('span', { class: 'tile sm blue' }, icon(ic, 'i')),
      h(
        'span',
        { class: 'row-text' },
        h('span', { class: 'row-t', text: title }),
        h('span', { class: 'row-d', text: sub }),
      ),
      right,
    )
  const toggle = (on: boolean) => {
    const sw = h('span', { class: on ? 'switch on' : 'switch' })
    sw.setAttribute('role', 'switch')
    sw.setAttribute('aria-checked', String(on))
    return sw
  }
  const link = (ic: IconName, title: string, sub: string, href: string) => {
    const a = h(
      'a',
      { class: 'set-row' },
      h('span', { class: 'tile sm blue' }, icon(ic, 'i')),
      h(
        'span',
        { class: 'row-text' },
        h('span', { class: 'row-t', text: title }),
        h('span', { class: 'row-d', text: sub }),
      ),
      icon('chevron'),
    )
    a.href = href
    a.target = '_blank'
    a.rel = 'noopener'
    return a
  }
  /** One section: a small title and its rows in a box, like the PC settings */
  const sec = (title: string, ...rows: (Node | undefined)[]) =>
    box.append(
      h('h2', { class: 'over', text: title }),
      h('div', { class: 'set-list' }, ...rows.filter((x): x is Node => Boolean(x))),
    )
  const chev = () => icon('chevron')

  // ── My Doori: dress it up (doori-maker.ts) ──
  box.append(
    h(
      'button',
      { class: 'set-row my-doori', onclick: () => openOverlay({ kind: 'doori' }) },
      doori('', 44),
      h(
        'span',
        { class: 'row-text' },
        h('span', { class: 'row-t', text: tDoori.myDoori }),
        h('span', { class: 'row-d', text: tDoori.myDooriSub }),
      ),
      chev(),
    ),
  )

  // ── General (PC: general) ──
  // Auto-approve (ADR 0030): everything except payments without a card. Turned on with the phone lock and a signed request
  const auto = st.pc?.autoApprove === true
  // Phone lock for payments (ADR 0043): only in the store app once its chip keys are registered
  const keys = isNative() && st.pc?.approveKeys
  const has = st.pc?.payKey === true
  const payOn = has && st.pc?.payConfirm === true
  sec(
    mSet.secFinal,
    row(
      'hand',
      mSet.autoApprove,
      auto ? mSet.autoApproveOnSub : mSet.autoApproveOffSub,
      toggle(auto),
      () => void setAutoApprove(!auto),
    ),
    keys
      ? row(
          'lock',
          mSet.payLock,
          !has ? mSet.payLockNoLock : payOn ? mSet.payLockOnSub : mSet.payLockOffSub,
          toggle(payOn),
          has ? () => void setPayConfirm(!payOn) : undefined,
        )
      : undefined,
  )
  if (isNative()) {
    // Store app (ADR 0042): the phone's own notification permission and FCM
    const a = appPush
    const on = Boolean(a?.allowed && st.pc?.appPush)
    sec(
      mSet.notifications,
      row(
        'bell',
        mSet.phoneNotif,
        !a?.available
          ? mSet.notifUnavailable
          : on
            ? mSet.notifOn
            : a.denied
              ? mSet.notifBlockedApp
              : mSet.notifOff,
        toggle(on),
        a?.available && !on && !a.denied ? () => void syncAppPush(true) : undefined,
      ),
    )
  } else {
    const perm = 'Notification' in window ? Notification.permission : 'denied'
    sec(
      mSet.notifications,
      row(
        'bell',
        mSet.phoneNotif,
        perm === 'granted' ? mSet.notifOn : perm === 'denied' ? mSet.notifBlocked : mSet.notifOff,
        toggle(perm === 'granted'),
        perm === 'default'
          ? () =>
              void Notification.requestPermission().then(() => {
                void syncPush()
                render()
              })
          : undefined,
      ),
    )
  }
  const theme = document.documentElement.dataset.theme ?? 'auto'
  const seg = h('div', { class: 'seg' })
  for (const [id, label] of [
    ['auto', mSet.themeAuto],
    ['light', mSet.themeLight],
    ['dark', mSet.themeDark],
  ] as const)
    seg.append(
      segBtn(theme === id, {
        text: label,
        onclick: () => {
          document.documentElement.dataset.theme = id
          localStorage.setItem('dool2-theme', id)
          render()
        },
      }),
    )
  box.append(h('h2', { class: 'over', text: mSet.screen }), seg)
  // Language of this phone (ADR 0029). Each device keeps its own; changing it reloads the app
  const langSeg = h('div', { class: 'seg' })
  for (const id of LANGS)
    langSeg.append(segBtn(lang === id, { text: LANG_NAMES[id], onclick: () => setLang(id) }))
  box.append(h('h2', { class: 'over', text: mSet.language }), langSeg)

  // ── AI · browser (PC: AI · browser): status only, changed on the PC ──
  const agent = st.pc?.defaultAgent ?? st.pc?.agents[0]
  sec(
    mSet.secAi,
    row('brain', mSet.aiRow, agent ? mSet.aiSub(agentLabel(agent, lang)) : mSet.aiNone),
    row('globe', mSet.browserRow, st.pc?.extension ? mSet.browserOn : mSet.browserOff),
    row(
      'apps',
      mSet.connectedServices,
      mSet.connectedServicesSub((st.services ?? []).filter((x) => x.connectedAt).length),
      chev(),
      () => setTab('connect'),
    ),
  )

  // ── Connection (PC: phone connection) ──
  sec(
    mSet.secPc,
    row(
      'pc',
      st.saved?.pcName ?? mSet.myPc,
      !st.online ? mSet.pcConnecting : st.pcSilent ? mSet.pcSilent : mSet.pcRunning,
      h('span', { class: 'meta', text: mSet.rename }),
      () => renamePc(),
    ),
    row('close', mSet.repair, mSet.repairSub, undefined, () => {
      if (confirm(mSet.repairConfirm)) void forgetPc()
    }),
  )

  // ── Dool2 vault (PC: Dool2 vault) ──
  sec(
    mSet.secVault,
    row('lock', mSet.vaultRow, mSet.vaultSub, chev(), () => {
      void send({ kind: 'vault-get' })
      openOverlay({ kind: 'vault' })
    }),
  )

  // ── My info · payment (PC: my info · payment) ──
  // Used when Dool2 fills booking and order fields. Values stay in the PC vault, and only masked values show here
  if (!st.profile) void send({ kind: 'profile-get' })
  const have = Object.keys(st.profile?.have ?? {})
  const infoRow = row(
    'note',
    mSet.myInfo,
    !st.profile
      ? mSet.loading
      : have.length
        ? mSet.myInfoHave(have.map((k) => PROFILE_LABEL[k] ?? k).join('·'))
        : mSet.myInfoNone,
    chev(),
    () => openOverlay({ kind: 'profile' }),
  )
  const mine = st.profile?.payMethods
  const pays = Object.entries(st.profile?.payChoices ?? {})
  // My payment methods (ADR 0023): the top one is the main method. What is remembered per site is inside the sheet
  const payRows: Node[] = mine
    ? [
        row(
          'card',
          mSet.payMethods,
          mine[0] ? mSet.payMain(payMethodLabel(mine[0], lang), mine.length - 1) : mSet.payNone,
          chev(),
          () => openOverlay({ kind: 'pay' }),
        ),
      ]
    : pays.length
      ? pays.map(([host, label]) =>
          row(
            'card',
            `${label}`,
            mSet.payRemembered(host.replace(/^www\./, '')),
            h('span', { class: 'meta', text: mSet.forget }),
            () => void send({ kind: 'pay-choice-forget', host }),
          ),
        )
      : [row('card', mSet.payMethods, mSet.payRememberNote)]
  sec(mSet.infoAndPay, infoRow, ...payRows)

  // ── About Dool2 (PC: about) ──
  sec(
    mSet.secAbout,
    row('hand', mSet.reportProblem, mSet.reportProblemSub, chev(), () => openOverlay({ kind: 'report' })),
    link('globe', mSet.siteLink, 'dool2.com', 'https://dool2.com'),
    link('link', mSet.sourceLink, 'github.com/kuzvo-dev/dool2', 'https://github.com/kuzvo-dev/dool2'),
  )

  // Reset data (PC: About Dool2 > Reset data): start over like a new user. The vault and the phone link stay
  sec(
    mSet.secReset,
    row('trash', mSet.startOver, mSet.startOverSub, chev(), () => void resetAll()),
  )

  box.append(h('h2', { class: 'over', text: mSet.promises }))
  const promises = h('div', { class: 'set-list' })
  for (const [ic, t] of [
    ['card', mSet.promise1],
    ['lock', mSet.promise2],
    ['pc', mSet.promise3],
    ['hand', mSet.promise4],
  ] as [IconName, string][])
    promises.append(
      h(
        'div',
        { class: 'set-row' },
        h('span', { class: 'tile sm mint' }, icon(ic, 'i')),
        h('span', { class: 'row-t', text: t }),
      ),
    )
  box.append(promises)
  return box
}

const PROFILE_LABEL: Record<string, string> = Object.fromEntries(
  [
    'name',
    'name_en_last',
    'name_en_first',
    'email',
    'phone',
    'birth',
    'zip',
    'address',
    'address_detail',
    'rrn_back',
    'auth_app',
    'carrier',
    'passport_no',
    'passport_issued',
    'passport_expiry',
    'sex',
    'birth_city',
    'car_no',
  ].map((k) => [k, mSet.profileLabel(k)]),
)

/** Settings > my info: existing items only show masked values, and only newly filled fields change (empty ones stay) */
export function profileSheet() {
  const sheet = h('section', { class: 'sheet float app-sheet rise info-sheet' })
  const p = st.profile
  sheet.append(
    h(
      'div',
      { class: 'approve-head' },
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: mSet.myInfo }),
        h('span', { class: 'meta', text: mSet.profileSub }),
      ),
    ),
  )
  if (!p) {
    sheet.append(h('p', { class: 'meta', text: mSet.loading }))
    return sheet
  }
  const inputs = Object.entries(PROFILE_LABEL).map(([key, label]) => {
    const input = h('input', { class: 'field' })
    input.name = key
    if (key === 'auth_app' || key === 'carrier') {
      // Verification app and carrier are picked from a list (not secret, so the current pick shows as is)
      input.type = 'hidden'
      const opts = key === 'carrier' ? CARRIERS : AUTH_APPS
      return { key, label, input, chips: choiceChips(opts, p.have[key] ?? '', (v) => (input.value = v)) }
    }
    input.placeholder = p.have[key] ? mSet.profileChange(p.have[key]) : mSet.profileEmpty
    input.setAttribute('aria-label', label)
    if (key === 'phone') input.type = 'tel'
    if (key === 'email') input.type = 'email'
    if (key === 'rrn_back') {
      input.type = 'password'
      input.inputMode = 'numeric'
      input.autocomplete = 'off'
    }
    autoHyphen(input, key)
    return { key, label, input, chips: undefined as HTMLElement | undefined }
  })
  const go = h('button', { class: 'btn lg', text: mSet.save })
  go.type = 'submit'
  const form = h(
    'form',
    { class: 'cred-form profile-form' },
    ...inputs.map(({ label, input, chips }) =>
      chips
        ? h('div', { class: 'field-label' }, h('span', { class: 'meta', text: label }), chips, input)
        : h('label', { class: 'field-label' }, h('span', { class: 'meta', text: label }), input),
    ),
    go,
  )
  form.onsubmit = (e) => {
    e.preventDefault()
    const values: Record<string, string> = {}
    for (const { key, input } of inputs) if (input.value.trim()) values[key] = input.value.trim()
    if (!Object.keys(values).length) return openOverlay(undefined)
    void send({ kind: 'profile-set', values })
    openOverlay(undefined)
  }
  sheet.append(
    form,
    h('p', { class: 'lock-note' }, icon('lock'), mSet.profileNote),
    h('button', {
      class: 'btn-text cred-direct',
      text: mSet.profileClear,
      onclick: () => {
        if (!confirm(mSet.profileClearConfirm)) return
        void send({ kind: 'profile-clear' })
        openOverlay(undefined)
      },
    }),
  )
  return sheet
}

/**
 * Settings > vault (ADR 0026): the list of saved logins. Show checks the phone lock (fingerprint, face, PIN), asks the PC, and shows it for 30 seconds only.
 * Edit changes the ID and password (empty fields stay). Dool2 (the AI) never gets the password
 */
export function vaultSheet() {
  const sheet = h('section', { class: 'sheet float app-sheet rise info-sheet' })
  sheet.append(
    h(
      'div',
      { class: 'approve-head' },
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: mSet.vault }),
        h('span', { class: 'meta', text: mSet.vaultSheetSub }),
      ),
    ),
  )
  const list = st.vault
  if (!list) {
    sheet.append(h('p', { class: 'meta', text: mSet.loading }))
    return sheet
  }
  if (!list.length) sheet.append(h('p', { class: 'meta', text: mSet.vaultEmpty }))
  const site = (o: string) => {
    try {
      return new URL(o).hostname.replace(/^www\./, '')
    } catch {
      return o
    }
  }
  for (const e of list) {
    const shown = st.vaultShown?.id === e.id ? st.vaultShown : undefined
    const view = h('button', {
      text: shown ? mSet.hide : mSet.show,
      onclick: async () => {
        if (shown) {
          st.vaultShown = undefined
          render()
          return
        }
        const ok = await confirmDevice(mSet.showPassword, mSet.showPasswordWhy(e.name ?? site(e.origin)))
        if (ok === 'ok') void send({ kind: 'vault-reveal', id: e.id })
        else if (ok === 'no-lock') toast(mSet.noLock)
        else if (ok === 'web') toast(mSet.onlyInApp)
      },
    })
    const edit = h('button', {
      text: mSet.edit,
      onclick: () => {
        st.vaultEdit = st.vaultEdit === e.id ? undefined : e.id
        render()
      },
    })
    const del = h('button', {
      class: 'danger',
      text: mSet.remove,
      onclick: () => {
        if (!confirm(mSet.vaultDeleteConfirm(e.name ?? site(e.origin)))) return
        void send({ kind: 'vault-delete', id: e.id })
      },
    })
    const card = h(
      'div',
      { class: 'vault-row' },
      h(
        'div',
        { class: 'row-text' },
        h('strong', { class: 'row-t', text: e.name ?? site(e.origin) }),
        h('span', { class: 'row-d', text: `${shown?.username ?? e.username} · ${site(e.origin)}` }),
        ...(shown ? [h('code', { class: 'vault-pw', text: shown.password })] : []),
      ),
      h('div', { class: 'vault-acts' }, view, edit, del),
    )
    if (st.vaultEdit === e.id) {
      const user = h('input', { class: 'field' }) as HTMLInputElement
      user.placeholder = mSet.idPlaceholder(e.username)
      user.autocomplete = 'off'
      const pw = h('input', { class: 'field' }) as HTMLInputElement
      pw.type = 'password'
      pw.placeholder = mSet.newPassword
      pw.autocomplete = 'new-password'
      const save = h('button', { class: 'btn sm', text: mSet.save })
      save.type = 'submit'
      const form = h('form', { class: 'cred-form' }, user, pw, save)
      form.onsubmit = (ev) => {
        ev.preventDefault()
        if (!user.value.trim() && !pw.value) return
        void send({
          kind: 'vault-set',
          id: e.id,
          ...(user.value.trim() ? { username: user.value.trim() } : {}),
          ...(pw.value ? { password: pw.value } : {}),
        })
      }
      card.append(form)
    }
    sheet.append(card)
  }
  sheet.append(h('p', { class: 'lock-note' }, icon('lock'), mSet.vaultNote))
  return sheet
}
