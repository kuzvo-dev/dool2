// Phone app: the feed top, long lists that page in, the life context and saving or sharing files
import {
  type FeedItem,
  FILE_CHUNK,
  type LibraryItem,
  type LifeAction,
  type LifeState,
  type PcToPhone,
} from '@dool2/protocol'
import { Pager } from '@dool2/protocol/paging'
import { readAppNote, stripLinks } from '@dool2/protocol/rich'
import { doori, h, setFileOpener } from '../dom.js'
import type { LifeCtx } from '../life-views.js'
import { springTo } from '../motion.js'
import { saveFile, shareFile } from '../native.js'
import { hostOf } from './approval-cards.js'
import { ask } from './ask.js'
import { loginLink, openLogin, openViewer } from './cards.js'
import { mark, mFeed, send, st } from './core.js'
import { pendingApprovals, pendingLogins } from './decide.js'
import { openOverlay, render, renderSoon, setTab, shell, shellVars, toast } from './shell.js'

// ── Tasks ──

/** Top of the feed: what is waiting for me, what is being done now, and what is next */

function waitingCards(): HTMLElement[] {
  const box = h('div', { class: 'waiting' })
  const approvals = pendingApprovals()
  const logins = pendingLogins()
  if (approvals.length || logins.length) {
    box.append(h('h2', { class: 'over', text: mFeed.waitingForMe }))
    for (const a of approvals)
      box.append(
        h(
          'button',
          { class: 'task-card ask', onclick: () => openOverlay({ kind: 'approval', id: a.id }) },
          h('span', { class: 'meta' }, h('span', { class: 'dot ask' }), mFeed.waitingApproval),
          h('strong', { text: [a.what, a.amount].filter(Boolean).join(' · ') }),
          h('span', { class: 'meta', text: a.where }),
        ),
      )
    for (const l of logins) {
      const link = loginLink(l.origin)
      const state = link?.busy
        ? (st.connectSteps.get(link.cid)?.at(-1)?.text ?? mFeed.doriLoggingIn)
        : link?.fail?.reason === 'human'
          ? mFeed.doYourself
          : link?.fail?.reason === 'wrong'
            ? mFeed.wrongLogin
            : link?.fail
              ? mFeed.loginNotFinished
              : mFeed.loginNeeded
      box.append(
        h(
          'button',
          { class: 'task-card ask', onclick: () => openLogin(l) },
          h(
            'span',
            { class: 'meta' },
            h('span', { class: `dot ${link?.busy ? 'work pulse' : 'ask'}` }),
            state,
          ),
          h('strong', { text: mFeed.siteLogin(l.site) }),
          h('span', { class: 'meta', text: hostOf(l.origin) }),
        ),
      )
    }
  }
  if (st.busy) {
    const log = h('ul', { class: 'worklog' })
    if (st.steps.length < shellVars.shownSteps) shellVars.shownSteps = 0
    st.steps.forEach((s, i) => {
      const li = h('li', { class: i === st.steps.length - 1 ? 'now' : 'done', text: s })
      // When a new step arrives: the circle of the step just finished pops, and the new step rises from below
      if (i >= shellVars.shownSteps && i > 0) {
        springTo(
          li,
          [
            { opacity: 0, transform: 'translateY(10px)' },
            { opacity: 1, transform: 'none' },
          ],
          'item',
        )
        const prev = log.lastElementChild
        if (prev)
          springTo(prev, [{ transform: 'scale(0.6)' }, { transform: 'scale(1)' }], 'pop', {}, '::before')
      }
      log.append(li)
    })
    shellVars.shownSteps = st.steps.length
    box.append(
      h('h2', { class: 'over', text: mFeed.workingNow }),
      h(
        'div',
        { class: 'task-card' },
        h('span', { class: 'meta' }, h('span', { class: 'dot work pulse' }), mFeed.working),
        h('strong', { text: lastUserText() ?? mFeed.yourRequest }),
        st.steps.length ? log : h('span', { class: 'meta', text: mFeed.writingReply }),
        h('button', {
          class: 'btn-text',
          text: mFeed.stop,
          onclick: () => void send({ kind: 'conversation-cancel' }),
        }),
      ),
    )
  }
  if (st.queued.length) {
    box.append(h('h2', { class: 'over', text: mFeed.upNext }))
    for (const q of st.queued) box.append(h('div', { class: 'row' }, h('span', { class: 'row-t', text: q })))
  }
  return box.childNodes.length ? [box] : []
}

// ── Long lists: the first page comes with life, scrolling down fetches the next pages with life-page ──
export const feedPager = new Pager<FeedItem>(
  (f) => f.at,
  (before) => void send({ kind: 'life-page', list: 'feed', ...(before ? { before } : {}) }),
  () => renderSoon(),
)
const libPager = (tab: 'made' | 'files') =>
  new Pager<LibraryItem>(
    (it) => it.savedAt,
    (before) => void send({ kind: 'life-page', list: 'library', tab, ...(before ? { before } : {}) }),
    () => renderSoon(),
  )
export const libPagers = { made: libPager('made'), files: libPager('files') }
/** Dool2 panel activity: finished and scheduled tasks only (the first page is fetched separately) */
export const activityPager = new Pager<FeedItem>(
  (f) => f.at,
  (before) =>
    void send({ kind: 'life-page', list: 'feed', kinds: ['done', 'routine'], ...(before ? { before } : {}) }),
  () => renderSoon(),
)
export const listsVars = { activityAskedAt: 0 }
/** Full text of one library item (the list only has the beginning) */
export const fullItems = new Map<string, LibraryItem>()

/** Fit the first page we got into each list (pages fetched later stay as they are) */
export function takeLife(life: LifeState) {
  st.life = life
  feedPager.take(undefined, { items: life.feed, ...(life.feedNext ? { next: life.feedNext } : {}) })
  for (const tab of ['made', 'files'] as const) {
    const next = life.libraryNext?.[tab]
    libPagers[tab].take(undefined, {
      items: life.library.filter((it) => (tab === 'files' ? it.kind === 'file' : it.kind !== 'file')),
      ...(next ? { next } : {}),
    })
  }
  // Library items may have changed: fetch again when reopened
  fullItems.clear()
  if (activityPager.started) activityPager.refresh()
}

/** The long list in view (scrolling down fetches more) */
export function visiblePager(): Pager<{ id: string }> | undefined {
  if (st.tab === 'feed') return feedPager
  if (st.tab === 'library') return libPagers[st.librarySeg === 'media' ? 'files' : 'made']
  return undefined
}

export function lifeAct(a: LifeAction) {
  // Show taps outside the first page right away (a new first page from the PC only fixes the part before it)
  for (const p of [feedPager, activityPager]) {
    if (a.action === 'feed-react')
      p.patch(a.id, (f) => {
        const { reaction: _r, ...rest } = f
        return a.reaction ? { ...rest, reaction: a.reaction } : rest
      })
    if (a.action === 'feed-answer') p.patch(a.id, (f) => (f.answered ? f : { ...f, answered: a.answer }))
  }
  if (a.action === 'library-delete') for (const p of Object.values(libPagers)) p.remove(a.id)
  void send({ kind: 'life-action', ...a })
}

export function lifeCtx(): LifeCtx {
  return {
    ...(st.life ? { life: st.life } : {}),
    online: st.online,
    act: lifeAct,
    ask: (text) => ask(text),
    fill: (text) => {
      st.draft = text
      setTab('chat')
      requestAnimationFrame(() => {
        shell?.textarea.focus()
        shell?.textarea.setSelectionRange(text.length, text.length)
      })
    },
    openGoal: (id) => openOverlay({ kind: 'goal', id }),
    openItem: (id) => openOverlay({ kind: 'item', id }),
    close: () => openOverlay(undefined),
    waiting: waitingCards(),
    feedList: feedPager,
    libraryList: libPagers[st.librarySeg === 'media' ? 'files' : 'made'],
    fullItem: (id) => {
      const full = fullItems.get(id)
      if (full) return full
      const it = [...libPagers.made.items, ...libPagers.files.items].find((x) => x.id === id)
      // If only the beginning arrived, ask for the whole text (the sheet is redrawn when it comes)
      if (it?.cut) void send({ kind: 'life-item', id })
      return it
    },
    fileAction: (it, how) => void fileAction(it, how),
    view: (src, title, path) => openViewer(src, title, path),
    librarySeg: st.librarySeg,
    setLibrarySeg: (seg) => {
      st.librarySeg = seg
      render()
    },
  }
}

/** Waiting for chunks of a library file original ("id:offset" -> what to call when it arrives) */
export const fileChunkWaits = new Map<string, (m: Extract<PcToPhone, { kind: 'file-chunk' }>) => void>()
let fileBusy = false

// PC file links inside a reply: tapping gets the file from the PC and saves it on the phone (the daemon checks the path is inside the user's folders)
let fileLinkSeq = 0
setFileOpener((path, name) => void fileAction({ id: `link-${++fileLinkSeq}`, title: name, path }, 'save'))

/**
 * Gets the original from the PC in chunks and saves or shares it on the phone (192KB at a time because of the relay envelope limit).
 * Library items are asked for by id, file links inside replies by path (the id marks which chunk we wait for)
 */
async function fileAction(it: Pick<LibraryItem, 'id' | 'title' | 'path'>, how: 'save' | 'share') {
  if (fileBusy) return toast(mFeed.fileBusy)
  if (!st.online) return toast(mFeed.pcOffNoFile)
  fileBusy = true
  mark(how === 'save' ? 'Library file save' : 'Library file share')
  toast(mFeed.receivingFile)
  try {
    const parts: string[] = []
    let offset = 0
    let size = 0
    let name = it.title
    let mime = 'application/octet-stream'
    do {
      const at = offset
      const m = await new Promise<Extract<PcToPhone, { kind: 'file-chunk' }>>((done, fail) => {
        const key = `${it.id}:${at}`
        const timer = setTimeout(() => {
          fileChunkWaits.delete(key)
          fail(new Error(mFeed.pcNoAnswer))
        }, 30_000)
        fileChunkWaits.set(key, (x) => {
          clearTimeout(timer)
          fileChunkWaits.delete(key)
          done(x)
        })
        void send({
          kind: 'file-chunk',
          id: it.id,
          offset: at,
          // The daemon finds library items by id. Only links inside replies use a path
          ...(it.id.startsWith('link-') && it.path ? { path: it.path } : {}),
        })
      })
      if (m.error || !m.data) throw new Error(m.error ?? mFeed.fileFailed)
      size = m.size ?? 0
      name = m.name ?? name
      mime = m.mime ?? mime
      parts.push(m.data)
      offset += FILE_CHUNK
    } while (offset < size)
    const data = parts.join('')
    const said = how === 'save' ? await saveFile(name, mime, data) : await shareFile(name, mime, data)
    if (said) toast(said)
  } catch (e) {
    toast((e as Error).message)
  } finally {
    fileBusy = false
  }
}

export function lastUserText() {
  return [
    ...st.pending.map((p) => p.text).reverse(),
    ...[...st.conv]
      .reverse()
      .filter((m) => m.role === 'user')
      .map((m) => m.text),
  ][0]
}

/** A reply as a one-line preview: drop bold and list marks, squeeze whitespace */
function plainPreview(text: string, max = 80) {
  const t = stripLinks(text)
    .replace(/\*\*/g, '')
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/**
 * Task list (latest 6). One request is one task:
 * - A follow-up answer to something Dool2 asked ("Dongtan Station") and app notes (approval results) are not new tasks. They attach to the one before
 * - The title is the first request, the description is the last reply
 */
function recentDone() {
  const out: { ask: string; answer: string; at: string; id: string }[] = []
  let open: { ask: string; asked: boolean } | undefined
  let last: { text: string; at: number } | undefined
  for (const m of st.conv) {
    if (m.role === 'user') {
      // A short answer right after Dool2 asked ("Dongtan Station") continues the previous task
      const quickReply =
        !!last && m.text.trim().length <= 8 && Date.parse(m.createdAt) - last.at < 10 * 60_000
      const followUp = readAppNote(m.text) !== undefined || quickReply
      if (!followUp || !out.length) open = { ask: m.text, asked: true }
      else open = { ask: '', asked: false }
    } else if (m.role === 'assistant') {
      last = { text: m.text, at: Date.parse(m.createdAt) }
      const item = { answer: plainPreview(m.text), at: m.createdAt, id: m.id }
      if (open?.asked) out.push({ ask: open.ask, ...item })
      else if (out.length) Object.assign(out[out.length - 1] as object, item)
      open = undefined
    }
  }
  return out.reverse().slice(0, 6)
}

/** Go to the chat tab so that message is in view */
function showInChat(id: string) {
  setTab('chat')
  requestAnimationFrame(() => {
    const el = shell?.chat.querySelector<HTMLElement>(`[data-key="${CSS.escape(id)}"]`)
    if (!el) return
    shellVars.stickToBottom = false
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.add('flash')
    setTimeout(() => el.classList.remove('flash'), 1400)
  })
}

function emptyState(mood: string, title: string, sub: string) {
  return h(
    'div',
    { class: 'empty' },
    doori(mood, 64),
    h('strong', { text: title }),
    h('span', { class: 'meta', text: sub }),
  )
}
