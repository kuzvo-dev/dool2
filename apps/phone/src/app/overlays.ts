// Phone app: drawing and closing overlays, the menu drawer, the quick menu, the message menu and reporting a problem
import { doori, h, type IconName, icon } from '../dom.js'
import { goalSheet, itemSheet, plain } from '../life-views.js'
import { mdCred } from '../locales/main-d-cred.js'
import { mdSheets } from '../locales/main-d-sheets.js'
import { drawCheck, riseIn, springTo } from '../motion.js'
import { agentPanel } from './agent-panel.js'
import { payPicker, shipPicker } from './approval-cards.js'
import { approvalSheet } from './approval-sheet.js'
import { pickPhoto } from './ask.js'
import { mark, mSet, send, st, type Tab, trail } from './core.js'
import { lifeAct, lifeCtx } from './lists.js'
import { connectSheet, infoSheet, loginSheet } from './login-sheets.js'
import { payAddSheet, paySheet } from './pay.js'
import { profileSheet, vaultSheet } from './settings.js'
import { openOverlay, reducedMotion, setTab, shell, toast, typingIn } from './shell.js'
import { newSide, sideMenu } from './threads.js'

// ── Overlays: menu drawer, Dool2 panel, approval sheet, login sheet ──

/** Shape of the overlay drawn last (if it is the same, do not insert it again) */
let overlayDrawn = ''
/** Closing animations (cancelled if reopened while closing) */
let overlayClosing: Animation[] = []

export function renderOverlay() {
  const o = shell?.overlay
  if (!o) return
  const ov = st.overlay
  if (!ov) return closeOverlay(o)
  for (const a of overlayClosing) a.cancel()
  overlayClosing = []
  delete o.dataset.closing
  o.hidden = false
  // Redrawing while a button is held or sending resets it, so leave it alone meanwhile
  const key = 'id' in ov ? `${ov.kind}:${ov.id}` : ov.kind
  if (o.dataset.key === key && o.querySelector('.hold.holding, .hold.busy, .hold.done')) return
  const opening = o.dataset.key !== key
  const putBack = holdLive(o)
  const body =
    ov.kind === 'drawer'
      ? drawerView()
      : ov.kind === 'agent'
        ? agentPanel()
        : ov.kind === 'approval'
          ? approvalSheet(ov.id)
          : ov.kind === 'pick-ship'
            ? shipPicker(ov.id, ov.back)
            : ov.kind === 'pick-pay'
              ? payPicker(ov.id, ov.back)
              : ov.kind === 'connect'
                ? connectSheet(ov.id)
                : ov.kind === 'goal'
                  ? goalSheet(lifeCtx(), ov.id)
                  : ov.kind === 'item'
                    ? itemSheet(lifeCtx(), ov.id)
                    : ov.kind === 'msg'
                      ? msgSheet(ov.id)
                      : ov.kind === 'plus'
                        ? plusSheet()
                        : ov.kind === 'info'
                          ? infoSheet(ov.id)
                          : ov.kind === 'profile'
                            ? profileSheet()
                            : ov.kind === 'vault'
                              ? vaultSheet()
                              : ov.kind === 'pay'
                                ? paySheet()
                                : ov.kind === 'pay-add'
                                  ? payAddSheet()
                                  : ov.kind === 'report'
                                    ? reportSheet()
                                    : loginSheet(ov.id)
  // While open, this runs every time news arrives from the PC. If the shape is the same, leave it alone:
  // inserting anew replays the rise animation, so sheets and menus bounce two or three times and lose typed text and scroll
  const drawn = body.outerHTML
  if (!opening && drawn === overlayDrawn && o.childElementCount) return putBack()
  overlayDrawn = drawn
  o.dataset.key = key
  o.dataset.kind = ov.kind
  // Input cards do not close when tapping outside (a slip blocked it). Only the "later" button closes them
  const scrim = h('div', { class: 'scrim', onclick: () => ov.kind !== 'info' && openOverlay(undefined) })
  // If only the content changed, swap it in place (the rise animation runs once, on first open)
  if (!opening) {
    scrim.classList.add('still')
    body.classList.add('still')
  }
  const was = o.lastElementChild
  const y = !opening && was instanceof HTMLElement ? was.scrollTop : 0
  const typing = opening ? undefined : typingIn(o)
  o.replaceChildren(scrim, body)
  if (y) body.scrollTop = y
  // Only on first open: menu rows rise one by one
  if (opening) riseIn(body.querySelectorAll(':scope > .set-row, :scope > .navi, :scope > .row'))
  typing?.()
}

/**
 * Where parts that are moved instead of rebuilt (like the animated Dool2) are right now.
 * Building a new screen moves those parts into it, so when a new screen is thrown away they are put back
 */
function holdLive(box: HTMLElement): () => void {
  const spots = [...box.querySelectorAll<HTMLElement>('[data-live-slot]')].map((el) => ({
    el,
    parent: el.parentNode,
    next: el.nextSibling,
  }))
  return () => {
    for (const s of spots) if (s.el.parentNode !== s.parent) s.parent?.insertBefore(s.el, s.next)
  }
}

/** Close: slides away in reverse of opening (not an abrupt cut) */
function closeOverlay(o: HTMLElement) {
  if (o.hidden || o.dataset.closing) return
  const done = () => {
    o.replaceChildren()
    o.hidden = true
    delete o.dataset.closing
    overlayClosing = []
  }
  // Opening the same one again right away counts as a first open
  delete o.dataset.key
  overlayDrawn = ''
  const els = [...o.children] as HTMLElement[]
  if (!els.length || reducedMotion()) return done()
  o.dataset.closing = '1'
  overlayClosing = els.map((el) =>
    el.animate(
      el.classList.contains('scrim')
        ? [{ opacity: 1 }, { opacity: 0 }]
        : el.classList.contains('drawer')
          ? [{ transform: 'none' }, { transform: 'translateX(-100%)' }]
          : [
              { transform: 'none', opacity: 1 },
              { transform: 'translateY(24px)', opacity: 0 },
            ],
      { duration: 170, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
    ),
  )
  const closing = overlayClosing
  const end = () => {
    if (overlayClosing === closing) done()
  }
  void Promise.all(closing.map((a) => a.finished)).then(end, () => {})
  // Even if the animation stops because the screen is hidden (app went to background), do not stay half closed
  setTimeout(end, 600)
}

function drawerView() {
  const tabs: [Tab, IconName, string][] = [
    ['chat', 'chat', mSet.tabChat],
    ['feed', 'feed', mSet.tabFeed],
    ['ideas', 'idea', mSet.tabIdeas],
    ['goals', 'goal', mSet.tabGoals],
    ['library', 'library', mSet.tabLibrary],
  ]
  const navi = (tab: Tab, ic: IconName, label: string, extra?: Node) =>
    h(
      'button',
      { class: st.tab === tab ? 'navi on' : 'navi', onclick: () => setTab(tab) },
      icon(ic, 'i md'),
      label,
      extra,
    )
  const connected = (st.services ?? []).filter((x) => x.connectedAt).length
  return h(
    'aside',
    { class: 'drawer app-drawer' },
    h('div', { class: 'drawer-title' }, doori('', 28), mSet.appName),
    ...tabs.map(([t, ic, label]) => navi(t, ic, label)),
    h(
      'div',
      { class: 'drawer-sec side-head' },
      h('span', { class: 'over', text: mSet.sideChats }),
      h('button', { class: 'fbtn small', label: mSet.newChat, onclick: newSide }, icon('pencil')),
    ),
    ...sideMenu(),
    h('p', { class: 'over drawer-sec', text: mSet.settings }),
    navi(
      'connect',
      'apps',
      mSet.connections,
      connected ? h('span', { class: 'meta navi-count', text: mSet.placesCount(connected) }) : undefined,
    ),
    navi('settings', 'gear', mSet.settings),
    h(
      'div',
      { class: 'navi static' },
      icon('pc', 'i md'),
      h(
        'span',
        { class: 'row-text' },
        h('span', { text: st.saved?.pcName ?? mSet.myPc }),
        h('span', {
          class: 'meta',
          text: !st.online ? mSet.pcConnecting : st.pcSilent ? mSet.pcSilent : mSet.pcConnected,
        }),
      ),
    ),
    h('p', { class: 'meta drawer-foot', text: mSet.drawerFoot }),
  )
}

/** Rename my PC: saved in the PC settings, so other phones connected to the same PC see the new name too */
export function renamePc() {
  if (!st.online) return toast(mSet.renameNeedsOnline)
  const name = prompt(mSet.renamePrompt, st.saved?.pcName ?? '')?.trim()
  if (!name || name === st.saved?.pcName) return
  void send({ kind: 'rename-pc', name: name.slice(0, 40) })
  toast(mSet.renamed(name.slice(0, 40)))
}

/** Settings (menu > settings): notifications, display, my PC, promises */
// Settings follows the PC settings page (apps/desktop setup.ts): the same sections in the same order and words
// (general → AI · browser → connection → vault → my info · payment → about), each a boxed list, on/off as switches.
// What only the PC can change (which AI, the extension) shows as status with where to change it
/** Composer + menu: ideas, goals, feed, separate chat, connections */
function plusSheet() {
  const item = (ic: IconName, tone: string, title: string, sub: string, onclick: () => void) =>
    h(
      'button',
      { class: 'set-row', onclick },
      h('span', { class: `tile sm ${tone}` }, icon(ic, 'i')),
      h(
        'span',
        { class: 'row-text' },
        h('span', { class: 'row-t', text: title }),
        h('span', { class: 'row-d', text: sub }),
      ),
    )
  return h(
    'section',
    { class: 'sheet float app-sheet rise plus-sheet' },
    item('image', 'blue', mdSheets.plusPhoto, mdSheets.plusPhotoSub, () => pickPhoto()),
    item('idea', 'amber', mdSheets.plusIdeas, mdSheets.plusIdeasSub, () => setTab('ideas')),
    item('goal', 'rose', mdSheets.plusGoals, mdSheets.plusGoalsSub, () => setTab('goals')),
    item('feed', 'blue', mdSheets.plusFeed, mdSheets.plusFeedSub, () => setTab('feed')),
    item('pencil', 'violet', mdSheets.plusSide, mdSheets.plusSideSub, () => newSide()),
    item('apps', 'mint', mdSheets.plusConnect, mdSheets.plusConnectSub, () => setTab('connect')),
  )
}

/** Long-press on a reply: save to the library or copy */
function msgSheet(id: string) {
  const m = st.conv.find((x) => x.id === id)
  const sheet = h('section', { class: 'sheet float app-sheet rise msg-sheet' })
  if (!m) return sheet
  const title = plain(m.text, 30)
  sheet.append(
    h('p', { class: 'msg-quote', text: plain(m.text, 140) }),
    h(
      'button',
      {
        class: 'set-row',
        onclick: () => {
          lifeAct({ action: 'library-save', title, body: m.text })
          openOverlay(undefined)
          toast(mdSheets.savedToLibrary)
        },
      },
      h('span', { class: 'tile sm amber' }, icon('bookmark', 'i')),
      h('span', { class: 'row-t', text: mdSheets.saveToLibrary }),
    ),
    h(
      'button',
      {
        class: 'set-row',
        onclick: (e: MouseEvent) => {
          const row = e.currentTarget as HTMLElement
          void navigator.clipboard?.writeText(m.text).then(
            () => {
              // The copy icon shrinks as the check is drawn, and the label slides up to "Copied"
              const tile = row.querySelector('.tile') as HTMLElement
              const label = row.querySelector('.row-t') as HTMLElement
              const ok = icon('check', 'i')
              tile.replaceChildren(ok)
              tile.classList.replace('blue', 'mint')
              drawCheck(ok)
              label.textContent = mdSheets.copied
              springTo(
                label,
                [
                  { opacity: 0, transform: 'translateY(10px)' },
                  { opacity: 1, transform: 'none' },
                ],
                'fade',
              )
              setTimeout(() => openOverlay(undefined), 700)
            },
            () => {
              toast(mdSheets.copyFailed)
              openOverlay(undefined)
            },
          )
        },
      },
      h('span', { class: 'tile sm blue' }, icon('copy', 'i')),
      h('span', { class: 'row-t', text: mdSheets.copy }),
    ),
    h('button', { class: 'btn-ghost wide', text: mdSheets.close, onclick: () => openOverlay(undefined) }),
  )
  return sheet
}

/** Report a problem: write a line (optional) and send, and what just happened in the app is saved in the PC's activity log */
function reportSheet() {
  const note = h('textarea', { class: 'field report-note' })
  note.id = 'report-note'
  note.rows = 3
  note.maxLength = 500
  note.placeholder = mdCred.reportPh
  const go = h('button', { class: 'btn lg', text: st.online ? mdCred.reportSend : mdCred.reportNeedPc })
  go.disabled = !st.online
  go.onclick = () => {
    void send({
      kind: 'report',
      trail: [...trail],
      ...(note.value.trim() ? { note: note.value.trim() } : {}),
      app: navigator.userAgent,
    })
    mark('report sent')
    st.overlay = undefined
    toast(mdCred.reportSaved)
  }
  return h(
    'section',
    { class: 'sheet float app-sheet rise report-sheet' },
    h(
      'button',
      { class: 'fbtn small sheet-x', label: mdCred.close, onclick: () => openOverlay(undefined) },
      icon('close'),
    ),
    h(
      'div',
      { class: 'approve-head' },
      h('span', { class: 'tile sm mint' }, icon('hand', 'i')),
      h(
        'div',
        {},
        h('strong', { class: 'title-2', text: mdCred.reportTitle }),
        h('span', { class: 'meta', text: mdCred.reportKeepOn(st.saved?.pcName ?? mdCred.myPc) }),
      ),
    ),
    note,
    go,
    h('p', { class: 'lock-note' }, icon('lock'), mdCred.reportNote),
  )
}
