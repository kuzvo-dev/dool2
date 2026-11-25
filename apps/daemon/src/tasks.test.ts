import { readAppNote } from '@dool2/protocol/rich'
import { describe, expect, it } from 'vitest'
import {
  notesMessage,
  parseTaskSpec,
  signInSpec,
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
    })
    expect(parseTaskSpec({ goal: 'Sort files', done_when: ['sorted'], browser: false })).toMatchObject({
      browser: false,
    })
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
    expect(brief).toContain('- window seat')
    expect(t.notes).toEqual([])
    expect(readAppNote(notesMessage(['make it 7 pm'], 'ko'))).toBe('"make it 7 pm" 전해 받았어요.')
    // Words the person typed in the task's detail are already in its chat: not shown a second time
    expect(readAppNote(notesMessage(['make it 7 pm'], 'en', new Set(['make it 7 pm'])))).toBe('')
    expect(notesMessage(['make it 7 pm'], 'en', new Set(['make it 7 pm']))).toContain('"make it 7 pm"')
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

describe('notes passed on while a task works', () => {
  it('ride at the end of its next tool result, once, also where the AI reads structured results', () => {
    const b = new TaskBoard()
    const t = b.create('th', 'seg', spec())
    b.start(t)
    b.note(t, 'make it 7 pm')
    const notes = b.takeNotes('th')
    expect(b.takeNotes('th')).toEqual([])
    const r = withNotes({ content: [{ type: 'text', text: 'page' }] }, notes)
    expect(r.content.at(-1)?.text).toContain('Message from the user')
    expect(r.content.at(-1)?.text).toContain('"make it 7 pm"')
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
    expect(text).toContain('Result: Booked hotel X')
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
