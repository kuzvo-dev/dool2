import { readAppNote } from '@dool2/protocol/rich'
import { describe, expect, it } from 'vitest'
import {
  notesMessage,
  parseTaskSpec,
  saidIn,
  signInSpec,
  stoppedText,
  TaskBoard,
  type TaskSpec,
  takeoverTarget,
  taskBrief,
  taskListText,
  withNotes,
} from './tasks.js'

const spec = (o: Partial<TaskSpec> = {}): TaskSpec => ({
  title: 'Train',
  goal: 'Book a KTX to Busan',
  doneWhen: ['a ticket number is read'],
  known: [],
  avoid: [],
  browser: true,
  lookup: false,
  ...o,
})

describe('task specs', () => {
  it('need a goal and a done-when; the title falls back to the goal', () => {
    expect(parseTaskSpec({ goal: 'x' })).toContain('goal is missing')
    expect(parseTaskSpec({ goal: 'Book a KTX' })).toContain('done_when is missing')
    expect(parseTaskSpec({ goal: 'Book a KTX', done_when: ['ticket read', '', 3] })).toEqual({
      title: 'Book a KTX',
      goal: 'Book a KTX',
      doneWhen: ['ticket read'],
      known: [],
      avoid: [],
      browser: true,
      lookup: false,
    })
    expect(parseTaskSpec({ goal: 'Sort files', done_when: ['sorted'], browser: false })).toMatchObject({
      browser: false,
    })
    // A lookup reads web pages, whatever browser says
    expect(
      parseTaskSpec({ goal: 'Weather tomorrow', done_when: ['forecast read'], browser: false, lookup: true }),
    ).toMatchObject({ browser: true, lookup: true })
  })

  it('a second try of a stopped job starts from what the first found', () => {
    const b = new TaskBoard()
    const t = b.create('th', 'seg', spec())
    expect(taskBrief(t, 'en')).not.toContain('earlier try')
    t.earlier = { id: 't12', status: 'stopped', answer: "Stopped: the site needs the father's name." }
    const brief = taskBrief(t, 'en')
    expect(brief).toContain('An earlier try of this job (t12, stopped)')
    expect(brief).toContain("the site needs the father's name")
    expect(brief).toContain('ask for that first')
  })

  it('a browser task hears which basic items of my info are not saved, never their values', () => {
    const t = new TaskBoard().create('th', 'seg', spec())
    t.missingInfo = ['birth', 'carrier']
    const brief = taskBrief(t, 'en')
    expect(brief).toContain('My info has nothing saved yet for: birth, carrier')
    expect(brief).toContain('browser_request_profile')
  })

  it('the brief shows only its title to people and gives the AI the whole spec', () => {
    const b = new TaskBoard()
    const t = b.create('th', 'seg', spec({ known: ['2 adults'], avoid: ['over 100,000 won'] }))
    b.note(t, 'window seat')
    const brief = taskBrief(t, 'en')
    expect(readAppNote(brief)).toBe('Working on: Train.')
    expect(brief).toContain('Goal: Book a KTX to Busan')
    expect(brief).toContain('Done when:\n- a ticket number is read')
    expect(brief).toContain('- 2 adults')
    expect(brief).toContain('- over 100,000 won')
    // A note sent while it waited goes into the brief, once
    expect(brief).toContain('- "window seat"')
    expect(t.notes).toEqual([])
    const n = [{ said: 'make it 7 pm' }]
    expect(readAppNote(notesMessage(n, 'ko'))).toBe('"make it 7 pm" 전해 받았어요.')
    // Words the person typed in the task's detail are already in its chat: not shown a second time
    expect(readAppNote(notesMessage(n, 'en', new Set(['make it 7 pm'])))).toBe('')
    expect(notesMessage(n, 'en', new Set(['make it 7 pm']))).toContain('"make it 7 pm"')
    // What the conversation added reaches the task as its own, never in the person's chat as their words
    const added = notesMessage([{ said: 'make it 7', added: 'the Friday train' }], 'en')
    expect(readAppNote(added)).toBe('Passed on: "make it 7".')
    expect(added).toContain('"make it 7" (Dool2\'s own addition, not the user\'s words: the Friday train)')
  })
})

describe("the words passed to a task are the user's", () => {
  it('found in what they wrote, whatever the spacing or punctuation, or across two messages', () => {
    const asked = ['아 기차 7시로 바꿔 줘', 'and a window seat!']
    expect(saidIn('아 기차 7시로 바꿔 줘', asked)).toBe(true)
    expect(saidIn('기차 7시로 바꿔줘.', asked)).toBe(true)
    expect(saidIn('Window seat', asked)).toBe(true)
    expect(saidIn('바꿔 줘 and a window', asked)).toBe(true)
    // A detail the user never said, or a translation, is not their words
    expect(saidIn('기차 오전 7시로 바꿔 줘', asked)).toBe(false)
    expect(saidIn('make the train 7', asked)).toBe(false)
    expect(saidIn('...', asked)).toBe(false)
  })
})

describe('the browser line', () => {
  it('one browser task at a time; the others wait in order and a task without the browser runs at once', () => {
    let now = 0
    const b = new TaskBoard({ now: () => ++now })
    const a = b.create('ta', 'seg', spec())
    const c = b.create('tc', 'seg', spec({ title: 'Hotel' }))
    const files = b.create('tf', 'seg', spec({ title: 'Files', browser: false }))
    expect(b.canStart(a)).toBe(true)
    b.start(a)
    expect(b.canStart(c)).toBe(false)
    expect(b.ahead(c)).toBe(1)
    expect(b.nextReady()).toBe(files)
    b.start(files)
    // The task without the browser reaching for it while another holds it is told so
    expect(b.claim('tf')).toMatchObject({ ok: false, holder: a })
    expect(b.claim('ta')).toEqual({ ok: true })
    // Chats that are not tasks are not lined up
    expect(b.claim('side-chat')).toEqual({ ok: true })
    b.end(a, 'done')
    expect(b.holder).toBeUndefined()
    expect(b.nextReady()).toBe(c)
  })
})

describe('the browser slot: waiting for the person, lookups beside, one task per tab', () => {
  it('a task waiting for the person gives the slot up; the one the person answers goes first and the holder yields', () => {
    let now = 0
    const b = new TaskBoard({ now: () => ++now })
    const a = b.create('ta', 'seg', spec())
    const c = b.create('tc', 'seg', spec({ title: 'Hotel' }))
    const d = b.create('td', 'seg', spec({ title: 'Flights' }))
    b.start(a)
    a.begun = true
    expect(b.canStart(c)).toBe(false)
    // a waits for a sign-in: the slot is free, c starts
    a.status = 'needs-you'
    b.release(a)
    expect(b.nextReady()).toBe(c)
    b.start(c)
    c.begun = true
    // The person answers a while c drives: a waits first in line, before d that never started
    a.status = 'waiting'
    a.answered = true
    a.resume.push('signed in')
    expect(b.ahead(a)).toBe(1)
    expect(b.ahead(d)).toBe(2)
    expect(b.yieldsTo(c)).toBe(a)
    expect(b.yieldsTo(a)).toBeUndefined()
    // c gives the slot over at its turn's end and goes on after a
    b.release(c)
    c.status = 'waiting'
    c.resume.push('next round')
    expect(b.nextReady()).toBe(a)
    b.start(a)
    expect(a.answered).toBeUndefined()
    expect(b.holder).toBe(a.id)
    b.end(a, 'done')
    // c had begun: it goes before d
    expect(b.nextReady()).toBe(c)
  })

  it('a lookup reads beside the holder in the background, and acts only when the slot is free', () => {
    const b = new TaskBoard()
    const a = b.create('ta', 'seg', spec())
    const w = b.create('tw', 'seg', spec({ title: 'Weather', lookup: true }))
    b.start(a)
    expect(b.canStart(w)).toBe(true)
    b.start(w)
    expect(b.holder).toBe(a.id)
    expect(b.claim('tw', { read: true })).toEqual({ ok: true, background: true })
    expect(b.readsBeside('tw')).toBe(true)
    // A click waits for the holder
    expect(b.claim('tw', { tabId: 9 })).toMatchObject({ ok: false, holder: a })
    b.end(a, 'done')
    expect(b.readsBeside('tw')).toBe(false)
    expect(b.claim('tw', { read: true })).toEqual({ ok: true })
    expect(b.claim('tw', { tabId: 9 })).toEqual({ ok: true })
    expect(b.holder).toBe(w.id)
  })

  it('with an extension that brings every tab forward, a lookup takes turns like the others', () => {
    let bg = false
    const b = new TaskBoard({ parallelReads: () => bg })
    const a = b.create('ta', 'seg', spec())
    const w = b.create('tw', 'seg', spec({ title: 'Weather', lookup: true }))
    b.start(a)
    expect(b.canStart(w)).toBe(false)
    expect(b.claim('tw', { read: true })).toMatchObject({ ok: false, holder: a })
    bg = true
    expect(b.canStart(w)).toBe(true)
  })

  it('a tab belongs to the task that opened or first used it, until that task ends', () => {
    const b = new TaskBoard()
    const a = b.create('ta', 'seg', spec())
    const w = b.create('tw', 'seg', spec({ title: 'Weather', lookup: true }))
    b.start(a)
    b.start(w)
    b.own(a, 5)
    expect(b.claim('tw', { read: true, tabId: 5 })).toMatchObject({ ok: false, tab: a })
    expect(b.claim('ta', { tabId: 5 })).toEqual({ ok: true })
    // A tab nobody owns becomes the first user's
    expect(b.claim('tw', { read: true, tabId: 6 })).toMatchObject({ ok: true })
    expect(b.tabOwner(6)).toBe(w)
    expect(b.claim('ta', { tabId: 6 })).toMatchObject({ ok: false, tab: w })
    b.end(w, 'done')
    expect(b.tabOwner(6)).toBeUndefined()
    expect(b.claim('ta', { tabId: 6 })).toEqual({ ok: true })
  })
})

describe('notes passed on while a task works', () => {
  it('ride at the end of its next tool result, once, also where the AI reads structured results', () => {
    const b = new TaskBoard()
    const t = b.create('th', 'seg', spec())
    b.start(t)
    b.note(t, 'make it 7 pm', 'the Friday train')
    const notes = b.takeNotes('th')
    expect(b.takeNotes('th')).toEqual([])
    const r = withNotes({ content: [{ type: 'text', text: 'page' }] }, notes)
    expect(r.content.at(-1)?.text).toContain('Message from the user')
    // The user's exact words come first, the conversation's addition after them, marked as not theirs
    expect(r.content.at(-1)?.text).toContain(
      '"make it 7 pm" (Dool2\'s own addition, not the user\'s words: the Friday train)',
    )
    const sc = withNotes(
      { content: [{ type: 'text', text: 'x' }], structuredContent: { a: 1 }, hint: 'next' },
      notes,
    )
    expect(sc.hint).toContain('"make it 7 pm"')
    expect(sc.hint).toContain('next')
  })

  it('task_list says what each task does and what came out', () => {
    const b = new TaskBoard({ now: () => 1000 })
    const a = b.create('ta', 'seg', spec())
    b.start(a)
    b.step(a, 'mcp__dool2__browser_open', { url: 'https://www.letskorail.com' })
    const c = b.create('tc', 'seg', spec({ title: 'Hotel' }))
    b.end(c, 'done')
    const text = taskListText(b, new Map([[c.id, 'Booked hotel X']]), 61_000)
    expect(text).toContain('t1 "Train": working')
    expect(text).toContain('t2 "Hotel": done 1 min ago')
    expect(text).toContain('do not say it is missing): Booked hotel X')
    // An ended result is how it was then: asked again, try again instead of repeating its blocker (11-27)
    expect(text).toContain('start a new task and try')
    expect(taskListText(b, new Map(), 61_000)).not.toContain('start a new task and try')
  })

  it('task_list names the card a waiting task has open, or its last step', () => {
    const b = new TaskBoard({ now: () => 1000 })
    const a = b.create('ta', 'seg', spec())
    b.start(a)
    a.status = 'needs-you'
    a.now = 'Asking for approval'
    const c = b.create('tc', 'seg', spec({ title: 'Hotel' }))
    b.start(c)
    c.status = 'needs-you'
    const cards = (id: string) => (id === 'tc' ? [] : ['an approval card on the phone ("Pay 14,900 won")'])
    const text = taskListText(b, new Map(), 2000, (id) => cards(b.get(id)?.threadId ?? ''))
    expect(text).toContain(
      't1 "Train": waiting for the user: an approval card on the phone ("Pay 14,900 won")',
    )
    expect(text).toContain(
      't2 "Hotel": waiting for the user (an approval, a sign-in or a card in the conversation)',
    )
    expect(text).not.toContain('last step: undefined')
  })

  it('task_stop says where the task was and whether anything was approved', () => {
    const b = new TaskBoard({ now: () => 1000 })
    const t = b.create('ta', 'seg', spec())
    b.start(t)
    b.step(t, 'mcp__dool2__browser_open', { url: 'https://www.letskorail.com' })
    const none = stoppedText(t, [])
    expect(none).toContain('Task t1 is stopped.')
    expect(none).toContain('(1 steps)')
    expect(none).toContain('Nothing it asked for was approved')
    expect(stoppedText(t, ['Pay: KTX 2 seats'])).toContain('so it may have happened: Pay: KTX 2 seats')
  })

  it('cards outlive a restart; a task that was running shows as stopped', () => {
    const b = new TaskBoard({ now: () => 0 })
    const t = b.create('ta', 'seg', spec())
    b.start(t)
    const views = b.views()
    const again = new TaskBoard({ now: () => 0 })
    again.restore(views)
    expect(again.frozenView('t1')).toMatchObject({ status: 'stopped' })
    expect(again.create('tb', 'seg', spec()).id).toBe('t2')
  })
})

describe('an automatic sign-in that stopped partway (ADR 0038)', () => {
  it('goes to the task that asked, else to a new sign-in task in task mode, else to the conversation', () => {
    const b = new TaskBoard()
    const asker = b.create('ta', 'seg', spec())
    b.start(asker)
    expect(takeoverTarget(b, 'ta', 'conversation')).toEqual({ kind: 'task', task: asker })
    // The conversation of task sessions has no browser: never the conversation
    expect(takeoverTarget(b, 'seg', 'conversation')).toEqual({ kind: 'new-task' })
    expect(takeoverTarget(b, undefined, 'conversation')).toEqual({ kind: 'new-task' })
    b.end(asker, 'done')
    expect(takeoverTarget(b, 'ta', 'conversation')).toEqual({ kind: 'new-task' })
    // Without task sessions the conversation has the browser, as before
    expect(takeoverTarget(b, undefined, undefined)).toEqual({ kind: 'conversation' })
    const s = signInSpec('Yogiyo', 'Read tab 3 with browser_read', 'en')
    expect(s).toMatchObject({
      title: 'Finish signing in to Yogiyo',
      goal: 'Read tab 3 with browser_read',
      browser: true,
    })
    expect(s.doneWhen[0]).toContain('signed in to Yogiyo')
  })
})
