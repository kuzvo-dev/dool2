// Phone app: the Dool2 panel (upcoming, memory, screen, activity, approvals)
import { withoutPhotoMark } from '@dool2/protocol/rich'
import { h, type IconName, icon, liveDoori, shortTime } from '../dom.js'
import { memorySeg, moreRow, plain, upcomingSeg } from '../life-views.js'
import { mdSheets } from '../locales/main-d-sheets.js'
import { hostOf } from './approval-cards.js'
import { openLogin } from './cards.js'
import { st } from './core.js'
import { pendingApprovals, pendingLogins } from './decide.js'
import { activityPager, lastUserText, lifeCtx, listsVars } from './lists.js'
import { openOverlay, render } from './shell.js'
import { openRemote } from './work.js'

export function agentPanel() {
  const waiting = pendingApprovals().length + pendingLogins().length
  const mood = !st.online || st.pcSilent ? 'sleeping' : waiting ? 'asking' : st.busy ? 'working' : ''
  const segs: [typeof st.agentSeg, IconName, string][] = [
    ['upcoming', 'clock', mdSheets.segUpcoming],
    ['memory', 'brain', mdSheets.segMemory],
    ['screen', 'pc', mdSheets.segScreen],
    ['activity', 'list', mdSheets.segActivity],
    ['approvals', 'hand', mdSheets.segApprovals],
  ]
  const seg = h(
    'div',
    { class: 'agent-icons' },
    ...segs.map(([id, ic, label]) => {
      const b = h(
        'button',
        {
          class: st.agentSeg === id ? 'on' : '',
          label,
          onclick: () => {
            st.agentSeg = id
            render()
          },
        },
        h(
          'span',
          { class: 'ic' },
          icon(ic, 'i md'),
          id === 'approvals' && waiting ? h('span', { class: 'badge' }) : undefined,
        ),
        h('span', { class: 'lb', text: label }),
      )
      b.setAttribute('aria-pressed', String(st.agentSeg === id))
      return b
    }),
  )
  const body = h('div', { class: 'agent-body' })
  const ctx = lifeCtx()
  const act = (tile: Node, title: string, sub?: string, time?: string, onclick?: () => void) =>
    h(
      onclick ? 'button' : 'div',
      { class: 'act-row', ...(onclick ? { onclick } : {}) },
      tile,
      h(
        'span',
        { class: 'row-text' },
        h('span', { class: 'row-t', text: title }),
        sub && h('span', { class: 'row-d', text: sub }),
      ),
      time && h('span', { class: 'meta', text: time }),
    )
  if (st.agentSeg === 'upcoming') body.append(...upcomingSeg(ctx))
  else if (st.agentSeg === 'memory') body.append(...memorySeg(ctx))
  else if (st.agentSeg === 'screen') {
    const tab = st.pc?.activeTab
    body.append(
      h('p', {
        class: 'meta seg-note',
        text: mdSheets.screenNote,
      }),
      tab !== undefined
        ? h('button', { class: 'btn wide', onclick: () => openRemote(tab) }, icon('pc'), mdSheets.viewScreen)
        : h('p', {
            class: 'meta seg-empty',
            text: mdSheets.noScreen,
          }),
    )
  } else if (st.agentSeg === 'activity') {
    if (st.busy)
      body.append(
        act(
          h('span', { class: 'tile sm mint' }, icon('globe', 'i')),
          st.steps.at(-1) ?? mdSheets.answering,
          lastUserText(),
        ),
      )
    // Ask for the first page when opened (retry after 10 seconds if no answer)
    if (!activityPager.started && Date.now() - listsVars.activityAskedAt > 10_000) {
      listsVars.activityAskedAt = Date.now()
      activityPager.refresh()
    }
    const done = activityPager.items
    for (const f of done)
      body.append(
        act(
          h(
            'span',
            { class: `tile sm ${f.kind === 'done' ? 'blue' : 'violet'}` },
            icon(f.kind === 'done' ? 'check' : 'clock', 'i'),
          ),
          withoutPhotoMark(f.title),
          f.body ? plain(f.body, 70) : undefined,
          shortTime(f.at),
        ),
      )
    const more = moreRow(activityPager)
    if (more) body.append(more)
    if (!done.length && !st.busy)
      body.append(
        activityPager.started
          ? h('p', { class: 'meta seg-empty', text: mdSheets.nothingDone })
          : h('p', { class: 'wait' }, h('span', { class: 'spin' }), mdSheets.receiving),
      )
  } else {
    const approvals = pendingApprovals()
    const logins = pendingLogins()
    for (const a of approvals)
      body.append(
        act(
          h('span', { class: 'tile sm amber' }, icon('card', 'i')),
          [a.what, a.amount].filter(Boolean).join(' · '),
          a.where,
          mdSheets.waiting,
          () => openOverlay({ kind: 'approval', id: a.id }),
        ),
      )
    for (const l of logins)
      body.append(
        act(
          h('span', { class: 'tile sm amber' }, icon('lock', 'i')),
          mdSheets.loginOf(l.site),
          hostOf(l.origin),
          mdSheets.waiting,
          () => openLogin(l),
        ),
      )
    const history = [...st.approvals.values()]
      .filter((a) => a.status !== 'pending')
      .slice(-10)
      .reverse()
    for (const a of history)
      body.append(
        act(
          h('span', { class: 'tile sm mint' }, icon(a.status === 'rejected' ? 'close' : 'check', 'i')),
          [a.what, a.amount].filter(Boolean).join(' · '),
          a.status === 'rejected'
            ? mdSheets.rejected
            : a.status === 'expired'
              ? mdSheets.expired
              : mdSheets.approved,
        ),
      )
    if (!approvals.length && !logins.length && !history.length)
      body.append(
        h('p', {
          class: 'meta seg-empty',
          text: mdSheets.noApprovals,
        }),
      )
  }
  const where = st.saved?.pcName ?? mdSheets.myPc
  return h(
    'section',
    { class: 'agent-panel rise' },
    h(
      'div',
      { class: 'panel-head' },
      h(
        'button',
        { class: 'fbtn', label: mdSheets.close, onclick: () => openOverlay(undefined) },
        icon('close'),
      ),
    ),
    h('div', { class: 'agent-big' }, liveDoori('agent', mood, 136)),
    h('h2', { class: 'agent-name', text: st.busy ? mdSheets.nameWorking : mdSheets.name }),
    h(
      'p',
      { class: 'agent-where' },
      h('span', { class: st.online ? 'dot work' : 'dot' }),
      st.online
        ? mdSheets.onPc(where, st.busy ? (st.steps.at(-1) ?? mdSheets.working) : mdSheets.resting)
        : mdSheets.connectingPc(where),
    ),
    seg,
    body,
  )
}
