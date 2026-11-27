// Phone app: the ideas tab (search, categories, running an idea after connecting)
import {
  type IdeaItem,
  type IdeaSection,
  ideaCatalog,
  ideaCount,
  needsConnect,
  searchIdeas,
} from '@dool2/protocol/ideas'
import { doori, emoTile, h, icon, withLogo } from '../dom.js'
import { lang } from '../lang.js'
import { swipeDeck } from '../motion-cards.js'
import { ask, connectInChat } from './ask.js'
import { mFeed, st } from './core.js'
import { lifeAct } from './lists.js'
import { pageSettled, render, shell } from './shell.js'

// ── Ideas ──

/** Send the idea we put off until connecting (only if connected within 10 minutes) */
export function runAfterConnect(id: string) {
  const p = st.afterConnect
  if (!p || p.id !== id) return
  st.afterConnect = undefined
  if (Date.now() - p.at < 10 * 60_000) setTimeout(() => ask(p.text), 400)
}

function tapIdea(it: IdeaItem) {
  if (needsConnect(it) && it.service) {
    st.afterConnect = { id: it.service.id, text: it.ask, at: Date.now() }
    connectInChat(it.service.id)
    return
  }
  // A request with blanks to fill (this product, I'll send a photo…) goes into the input box instead of being sent
  if (it.fill) {
    composeDraft(it.fill)
    return
  }
  ask(it.ask)
}

/** Put text in the chat input and place the cursor at the end (does not send) */
function composeDraft(text: string) {
  st.draft = text
  st.tab = 'chat'
  render()
  requestAnimationFrame(() => {
    const ta = shell?.textarea
    if (!ta) return
    ta.value = text
    ta.dispatchEvent(new Event('input'))
    ta.focus()
    ta.setSelectionRange(text.length, text.length)
  })
}

function ideaRow(it: IdeaItem, sec: IdeaSection) {
  const lead = it.service
    ? withLogo(h('span', { class: 'svc-mark', text: it.service.mark }), it.service.id)
    : emoTile(sec.emo)
  return h(
    'button',
    { class: 'idea', onclick: () => tapIdea(it) },
    lead,
    h(
      'span',
      { class: 'row-text' },
      h('span', { class: 'row-t', text: it.text }),
      h('span', { class: 'row-d', text: it.note }),
    ),
    needsConnect(it)
      ? h('span', { class: 'idea-tag', text: mFeed.tagConnect })
      : it.fill
        ? h('span', { class: 'idea-tag', text: mFeed.tagFill })
        : undefined,
  )
}

export function ideasView() {
  const groups = ideaCatalog(st.services ?? [], lang)
  const box = h(
    'section',
    { class: 'tab-page' },
    h('h1', { class: 'ptitle', text: mFeed.ideasTitle }),
    h('p', { class: 'psub', text: mFeed.ideasSub(ideaCount(groups)) }),
  )
  // Things Dool2 found to do on its own (from memory, goals and connections, fresh every morning)
  const ideas = st.life?.ideas ?? []
  const busy = Boolean(st.life?.ideasBusy)
  const refresh = h('button', {
    class: 'btn-ghost small',
    text: busy ? mFeed.searching : ideas.length ? mFeed.findAgain : mFeed.findForMe,
    onclick: () => lifeAct({ action: 'ideas-refresh' }),
  })
  refresh.disabled = busy || !st.online
  box.append(
    h(
      'div',
      { class: 'card suggested' },
      h(
        'div',
        { class: 'suggested-head' },
        doori(busy ? 'thinking' : '', 28),
        h(
          'span',
          { class: 'row-text' },
          h('span', { class: 'row-t', text: mFeed.todaysPick }),
          h('span', { class: 'row-d', text: mFeed.todaysPickSub }),
        ),
        refresh,
      ),
      // Two or more become a card stack: swipe right to hand it over, left for later
      ...(ideas.length > 1
        ? [swipeDeck(ideas, { onTake: (text) => ask(text) })]
        : ideas.map((i) =>
            h(
              'button',
              { class: 'idea', onclick: () => ask(i.text) },
              emoTile('bulb'),
              h(
                'span',
                { class: 'row-text' },
                h('span', { class: 'row-t', text: i.text }),
                h('span', { class: 'row-d', text: i.why }),
              ),
            ),
          )),
    ),
  )

  // Search and categories. Redrawing the whole page on every keystroke breaks Hangul composition, so only the list below is redrawn
  const wasTyping = document.activeElement?.id === 'idea-search'
  const search = h('input', { class: 'field idea-search' })
  search.id = 'idea-search'
  search.type = 'search'
  search.placeholder = mFeed.searchPlaceholder
  search.value = st.ideaQuery
  if (wasTyping)
    queueMicrotask(() => {
      search.focus()
      search.setSelectionRange(search.value.length, search.value.length)
    })
  const chips = h('div', { class: 'chips idea-cats' })
  const body = h('div', { class: 'idea-body' })
  const list = (items: { section: IdeaSection; item: IdeaItem }[]) =>
    h('div', { class: 'idea-list' }, ...items.map((x) => ideaRow(x.item, x.section)))
  const pick = (id: string) => {
    st.ideaCat = id
    st.ideaQuery = ''
    search.value = ''
    draw()
    pageSettled()
    chips.querySelector('.chip.on')?.scrollIntoView({ inline: 'center', block: 'nearest' })
    chips.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
  const draw = () => {
    const cat = groups.some((g) => g.section.id === st.ideaCat) ? st.ideaCat : 'all'
    const q = st.ideaQuery.trim()
    const chip = (id: string, label: string) =>
      h('button', {
        class: `chip quiet${cat === id && !q ? ' on' : ''}`,
        text: label,
        onclick: () => pick(id),
      })
    chips.replaceChildren(chip('all', mFeed.all), ...groups.map((g) => chip(g.section.id, g.section.label)))
    body.replaceChildren()
    if (q) {
      const found = searchIdeas(groups, q)
      if (found.length) body.append(list(found))
      body.append(
        h(
          'button',
          { class: 'idea idea-raw', onclick: () => ask(q) },
          h('span', { class: 'tile' }, icon('send', 'i md')),
          h(
            'span',
            { class: 'row-text' },
            h('span', { class: 'row-t', text: mFeed.askAsIs(q) }),
            h('span', {
              class: 'row-d',
              text: found.length ? mFeed.justSay : mFeed.noMatch,
            }),
          ),
        ),
      )
      return
    }
    if (cat === 'all') {
      for (const g of groups) {
        const sec = g.section
        body.append(
          h(
            'button',
            { class: 'idea-sec-head', onclick: () => pick(sec.id) },
            emoTile(sec.emo, 'sm'),
            h('strong', { text: sec.label }),
            h('span', { class: 'meta', text: mFeed.count(g.items.length) }),
            icon('chevron', 'i chev'),
          ),
          list(g.items.slice(0, 3).map((item) => ({ section: sec, item }))),
        )
      }
      return
    }
    const g = groups.find((x) => x.section.id === cat)
    if (!g) return
    const ready = g.items.filter((i) => !needsConnect(i))
    const later = g.items.filter(needsConnect)
    if (ready.length)
      body.append(
        h('h2', { class: 'over', text: mFeed.readyNow }),
        list(ready.map((item) => ({ section: g.section, item }))),
      )
    if (later.length)
      body.append(
        h('h2', { class: 'over', text: mFeed.afterConnect }),
        h('p', {
          class: 'meta idea-later',
          text: mFeed.afterConnectNote,
        }),
        list(later.map((item) => ({ section: g.section, item }))),
      )
  }
  search.oninput = () => {
    st.ideaQuery = search.value
    draw()
    pageSettled()
  }
  draw()
  box.append(search, chips, body)

  box.append(
    h(
      'div',
      { class: 'card ask-card' },
      h('div', { class: 'card-label' }, doori('asking', 22), mFeed.doItYourself),
      h('p', {
        class: 'card-text',
        text: mFeed.doItYourselfText,
      }),
    ),
  )
  return box
}
