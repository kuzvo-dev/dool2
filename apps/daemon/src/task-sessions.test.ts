// Conversation and task sessions (ADR 0038), end to end through the daemon with stand-in agents. The stand-ins call
// Dool2's tools over HTTP the way the real tool server does (tool token + x-dool2-toolset), so the split, the notes
// passed on in tool results, the approvals and the one result per task are the daemon's real paths.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRuntime, TurnInput } from '@dool2/engine'
import type { AgentEvent, AgentStatus, StoredMessage, TaskView } from '@dool2/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { type Daemon, startDaemon } from './index.js'
import { FIND_HINT, TASK_HINT, TASK_SESSIONS_DEFAULT, withTaskHint } from './tasks.js'

type Result = { isError?: boolean; content: { type: string; text: string }[]; routed?: boolean }
type Script = (input: TurnInput, rt: TwoSessions) => AsyncGenerator<AgentEvent>

/** Calls a Dool2 tool the way the tool server does */
async function tool(input: TurnInput, kind: string, name: string, args: unknown): Promise<Result> {
  const env = input.mcpServers[0]?.env ?? {}
  const r = await fetch(`${env.DOOL2_API}/api/tools/${kind}/${name}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.DOOL2_TOOL_TOKEN}`,
      'content-type': 'application/json',
      'x-dool2-toolset': env.DOOL2_TOOLSET ?? '',
    },
    body: JSON.stringify(args),
  })
  return (await r.json()) as Result
}
const textOf = (r: Result) => r.content.map((c) => c.text).join('\n')

/** A gate a stand-in waits at until the test opens it (or the turn is stopped) */
function gate() {
  let open: () => void = () => {}
  const p = new Promise<void>((r) => {
    open = r
  })
  return {
    open: () => open(),
    wait: (signal?: AbortSignal) =>
      Promise.race([p, new Promise<void>((r) => signal?.addEventListener('abort', () => r()))]),
  }
}

/** One agent that plays the conversation or a task, by the kind of session its tool server was given */
class TwoSessions implements AgentRuntime {
  readonly id = 'claude' as const
  seen: TurnInput[] = []
  results: Record<string, Result[]> = {}
  constructor(
    private readonly conv: Script,
    private readonly task: Script,
  ) {}
  async detect(): Promise<AgentStatus> {
    return { id: 'claude', installed: true, loggedIn: true, version: '9.9.9' }
  }
  kind(input: TurnInput) {
    return input.mcpServers[0]?.env?.DOOL2_SESSION
  }
  keep(key: string, r: Result) {
    this.results[key] = [...(this.results[key] ?? []), r]
    return r
  }
  async *runTurn(input: TurnInput): AsyncGenerator<AgentEvent> {
    this.seen.push(input)
    const kind = this.kind(input)
    yield { type: 'started', resumeId: kind === 'task' ? 'r-task' : 'r-conv', tools: ['mcp__dool2__status'] }
    yield* (kind === 'task' ? this.task : this.conv)(input, this)
  }
}

async function* say(text: string): AsyncGenerator<AgentEvent> {
  yield { type: 'text', delta: text }
  yield { type: 'done', text }
}
async function* used(input: TurnInput, rt: TwoSessions, kind: string, name: string, args: unknown) {
  const r = rt.keep(name, await tool(input, kind, name, args))
  const full = kind === 'browser' ? `browser_${name}` : name
  yield { type: 'tool', name: `mcp__dool2__${full}`, input: args } as AgentEvent
  yield { type: 'tool_result', name: `mcp__dool2__${full}`, ok: !r.isError } as AgentEvent
  return r
}

/** The conversation: hands "book" to a task, passes "make it" on, stops on "stop", answers the rest itself */
const conversation: Script = async function* (input, rt) {
  const ask = input.text.split('\n\n').at(-1) ?? ''
  if (/^book/i.test(ask)) {
    yield* used(input, rt, 'task', 'task_start', {
      title: ask.includes('hotel') ? 'Hotel' : 'Train',
      goal: ask,
      done_when: ['a ticket number is read on the completion screen'],
      known: ['2 adults'],
      avoid: ['nothing over 100,000 won'],
      // "book … offline" needs no browser, so it runs next to another task
      ...(ask.includes('offline') ? { browser: false } : {}),
    })
    yield* say('On it.')
    return
  }
  // "look up …": a lookup task, which reads beside a task that drives the browser
  if (/^look up/i.test(ask)) {
    yield* used(input, rt, 'task', 'task_start', {
      title: 'Forecast',
      goal: ask,
      done_when: ['the forecast is read'],
      lookup: true,
    })
    yield* say('Looking it up.')
    return
  }
  if (/^make it/i.test(ask)) {
    yield* used(input, rt, 'task', 'task_steer', { id: 't1', said: ask })
    yield* say('Passed on.')
    return
  }
  // "change it": first passes words the user never wrote (a detail filled in), then their own words with an addition
  if (/^change it/i.test(ask)) {
    yield* used(input, rt, 'task', 'task_steer', { id: 't1', said: 'change it to 7 am' })
    yield* used(input, rt, 'task', 'task_steer', { id: 't1', said: ask, added: 'the Friday train' })
    yield* say('Passed on.')
    return
  }
  // A question answered with a lookup: talk, not a job done
  if (/^is it raining/i.test(ask)) {
    yield* used(input, rt, 'life', 'conversation_search', { query: 'rain' })
    yield* say('No rain tomorrow.')
    return
  }
  if (/^open/i.test(ask)) {
    yield* used(input, rt, 'browser', 'open', { url: 'https://example.com' })
    yield* say('Hmm.')
    return
  }
  yield* say(`Sure: ${ask}`)
}

let daemon: Daemon | undefined
let dir: string | undefined
let home: string | undefined
afterEach(async () => {
  await daemon?.close()
  daemon = undefined
  for (const d of [dir, home]) if (d) await rm(d, { recursive: true, force: true })
  dir = undefined
  home = undefined
})

async function boot(rt: AgentRuntime, more: Partial<Parameters<typeof startDaemon>[0]> = {}) {
  dir = await mkdtemp(join(tmpdir(), 'dool2-task-'))
  daemon = await startDaemon({
    timeLine: () => undefined,
    dataDir: dir,
    token: 't0ken',
    runtimes: { claude: rt },
    chrome: { detect: async () => ({ installed: true, version: '157.0.8103.79' }) },
    ...more,
  })
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${daemon?.url}${path}`, {
      ...init,
      headers: { authorization: 'Bearer t0ken', 'content-type': 'application/json', ...init.headers },
    })
  await api('/api/settings', { method: 'PATCH', body: '{"taskSessions":true}' })
  type State = { messages: StoredMessage[]; busy: boolean; queued: string[]; tasks?: TaskView[] }
  const state = async () => (await (await api('/api/conversation')).json()) as State
  const send = async (text: string) =>
    (await (
      await api('/api/conversation/messages', { method: 'POST', body: JSON.stringify({ text }) })
    ).json()) as {
      queued: boolean
    }
  const task = async (id = 't1') => (await state()).tasks?.find((t) => t.id === id)
  return { api, state, send, task }
}

const until = async (f: () => Promise<boolean> | boolean, what = 'condition') => {
  for (let i = 0; i < 400; i++) {
    if (await f()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function downloads() {
  home = await mkdtemp(join(tmpdir(), 'dool2-home-'))
  const dl = join(home, 'Downloads')
  mkdirSync(dl)
  writeFileSync(join(dl, 'a.pdf'), 'a')
  writeFileSync(join(dl, 'b.pdf'), 'b')
  return dl
}

describe('task sessions (ADR 0038)', () => {
  it('start → talk while it runs → steer → approval in the task → finish check on done-when → one result', async () => {
    const dl = await downloads()
    const held = gate()
    let taskTurns = 0
    const searched: string[] = []
    const task: Script = async function* (input, rt) {
      taskTurns++
      if (taskTurns === 1) {
        await held.wait()
        // The person's note rides on this result
        const r: Result = yield* used(input, rt, 'life', 'conversation_search', { query: 'train' })
        searched.push(textOf(r))
        // Something that needs the person: moving two files asks for approval
        yield* used(input, rt, 'file', 'file_move', {
          moves: [
            { from: join(dl, 'a.pdf'), folder: join(dl, 'x') },
            { from: join(dl, 'b.pdf'), folder: join(dl, 'y') },
          ],
        })
        yield* say('Approve the move on your phone, then I book it.')
        return
      }
      // A step on a site (not a lookup), so the finish check judges it
      yield { type: 'tool', name: 'mcp__dool2__browser_click', input: { tabId: 1, ref: 'e1' } }
      yield* say('Booked the 7 pm KTX, ticket 1234.')
    }
    const rt = new TwoSessions(conversation, task)
    const prompts: string[] = []
    const {
      api,
      state,
      send,
      task: view,
    } = await boot(rt, {
      fileFolders: { desktop: [], documents: [], downloads: [dl] },
      finishJudge: async (p) => {
        prompts.push(p)
        return '{"done":true,"why":"ticket read"}'
      },
    })

    // 1) The conversation hands the work over and answers at once
    expect(await send('book a KTX to Busan on Friday')).toEqual({ queued: false })
    await until(() => rt.seen.some((x) => rt.kind(x) === 'task'), 'task turn')
    await until(async () => !(await state()).busy, 'conversation free')
    const convInput = rt.seen.find((x) => rt.kind(x) === 'conversation')
    const taskInput = rt.seen.find((x) => rt.kind(x) === 'task')
    expect(taskInput?.text).toContain('Goal: book a KTX to Busan on Friday')
    expect(taskInput?.text).toContain('- a ticket number is read on the completion screen')
    expect(taskInput?.text).toContain('- 2 adults')
    expect(taskInput?.mcpServers[0]?.env?.DOOL2_TOOLSET).not.toBe(
      convInput?.mcpServers[0]?.env?.DOOL2_TOOLSET,
    )
    let s = await state()
    // The task's card is saved during the turn, so before the answer; the screens show it below (like approval cards)
    expect(s.messages.map((x) => x.role)).toEqual(['user', 'tool', 'assistant'])
    expect(s.messages[1]?.text).toContain('"kind":"task"')

    // 2) Talk while it runs: answered now, not queued
    expect(await send('what is the weather')).toEqual({ queued: false })
    await until(
      async () => (await state()).messages.some((x) => x.text === 'Sure: what is the weather'),
      'answer',
    )
    // The conversation is told what is running
    expect(rt.seen.at(-1)?.text).toContain('Tasks running now')
    expect(rt.seen.at(-1)?.text).toContain('t1 "Train"')

    // 3) Change it midway: the note rides on the task's next tool result
    await send('make it 7 pm')
    await until(async () => (await view())?.notes === 1, 'note waiting')
    expect(textOf(rt.results.task_steer?.[0] as Result)).toContain('reads it at its next step')
    held.open()
    await until(() => searched.length === 1, 'search')
    expect(searched[0]).toContain('Message from the user')
    expect(searched[0]).toContain('"make it 7 pm"')

    // 4) The approval belongs to the task, shows in the conversation, and the approval continues the task
    await until(async () => (await view())?.status === 'needs-you', 'needs you')
    s = await state()
    expect(s.messages.filter((x) => x.text.includes('"kind":"approval"'))).toHaveLength(1)
    const { approvals } = (await (await api('/api/approvals')).json()) as { approvals: { id: string }[] }
    const r = (await (
      await api(`/api/approvals/${approvals[0]?.id}`, { method: 'POST', body: '{"decision":"approve"}' })
    ).json()) as Result & { ok: boolean }
    expect(r).toMatchObject({ ok: true, routed: true })
    expect(existsSync(join(dl, 'x', 'a.pdf'))).toBe(true)

    // 5) The finish check compares with done-when, and the result reaches the conversation once
    await until(async () => (await view())?.status === 'done', 'task done')
    expect(prompts.at(-1)).toContain('Done when')
    expect(prompts.at(-1)).toContain('a ticket number is read on the completion screen')
    s = await state()
    const results = s.messages.filter((x) => x.text === 'Booked the 7 pm KTX, ticket 1234.')
    expect(results).toHaveLength(1)
    expect(results[0]?.role).toBe('assistant')
    // The task's tool results and its own messages stay in its chat
    expect(s.messages.some((x) => x.text.includes('Approve the move'))).toBe(false)
    expect(s.messages.some((x) => x.text.includes('Goal:'))).toBe(false)
    const detail = (await (await api(`/api/threads/${(await view())?.threadId}`)).json()) as {
      messages: StoredMessage[]
    }
    expect(detail.messages.some((x) => x.text.includes('Approve the move'))).toBe(true)
    // Its chat is reached from the card, never listed with the side chats
    const taskChat = (await view())?.threadId
    const listed = (await (await api('/api/threads')).json()) as { threads: { id: string }[] }
    expect(taskChat).toBeTruthy()
    expect(listed.threads.length).toBeGreaterThan(0)
    expect(listed.threads.some((x) => x.id === taskChat)).toBe(false)

    // 6) The conversation hears the result on its next message
    await send('thanks')
    await until(async () => (await state()).messages.some((x) => x.text === 'Sure: thanks'), 'thanks')
    expect(rt.seen.at(-1)?.text).toContain('Tasks that ended since your last answer')
    expect(rt.seen.at(-1)?.text).toContain('Booked the 7 pm KTX, ticket 1234.')
    expect(rt.seen.at(-1)?.text).not.toContain('Tasks running now')
  })

  it("two tasks at once: the finish check sees only its own task's approvals", async () => {
    const dl = await downloads()
    const asked = gate()
    const bStarted = gate()
    const prompts: string[] = []
    let bTurns = 0
    const task: Script = async function* (input, rt) {
      if (input.text.includes('Goal: book files offline')) {
        // Task A asks for an approval (while B is already working) and waits for the person
        await bStarted.wait()
        yield* used(input, rt, 'file', 'file_move', {
          moves: [
            { from: join(dl, 'a.pdf'), folder: join(dl, 'x') },
            { from: join(dl, 'b.pdf'), folder: join(dl, 'y') },
          ],
        })
        asked.open()
        yield* say('Approve the move on your phone.')
        return
      }
      // Task B claims a booking with no approval of its own
      bStarted.open()
      await asked.wait()
      bTurns++
      yield { type: 'tool', name: 'mcp__dool2__browser_click', input: { tabId: 1, ref: 'e1' } }
      yield* say(bTurns === 1 ? 'I booked the table for 7 pm.' : 'Not booked yet: pick a time.')
    }
    const rt = new TwoSessions(conversation, task)
    const {
      send,
      state,
      task: view,
    } = await boot(rt, {
      fileFolders: { desktop: [], documents: [], downloads: [dl] },
      finishJudge: async (p) => {
        prompts.push(p)
        return '{"done":true,"why":"asked the time"}'
      },
    })
    await send('book files offline')
    await until(async () => !(await state()).busy, 'conversation free')
    await send('book a table offline')
    await until(async () => (await view('t1'))?.status === 'needs-you', 't1 needs you')
    await until(async () => (await view('t2'))?.status === 'done', 't2 done')
    // A's approval did not count for B: the code check sent B's claim back, and the judge saw no approvals for B
    expect(bTurns).toBe(2)
    expect(prompts.at(-1)).toContain('Approval requests during this request: none')
  })

  it('the finished-jobs feed (and so the return summary) gets the task, never the questions around it', async () => {
    const task: Script = async function* () {
      yield { type: 'tool', name: 'mcp__dool2__browser_click', input: { tabId: 1, ref: 'e1' } }
      yield* say('Booked the 7 pm KTX, ticket 1234.')
    }
    const rt = new TwoSessions(conversation, task)
    const {
      api,
      send,
      state,
      task: view,
    } = await boot(rt, {
      finishJudge: async () => '{"done":true,"why":"ticket read"}',
    })
    const done = async () =>
      ((await (await api('/api/life')).json()) as { feed: { kind: string; title: string }[] }).feed.filter(
        (f) => f.kind === 'done',
      )
    await send('is it raining tomorrow')
    await until(async () => (await state()).messages.some((x) => x.text === 'No rain tomorrow.'), 'answer')
    await send('book a KTX to Busan on Friday')
    await until(async () => (await view())?.status === 'done', 'task done')
    await until(async () => (await done()).length > 0, 'feed')
    // One entry, the task's: the lookup question and the turn that handed the work over are not jobs done
    expect((await done()).map((f) => f.title)).toEqual(['Train'])
  })

  it('a task waiting on a card gives the browser up, a lookup starts at once, and the answered task goes first', async () => {
    const dl = await downloads()
    const hotel = gate()
    const order: string[] = []
    const refused: string[] = []
    const task: Script = async function* (input, rt) {
      const goal = /Goal: (.*)/.exec(input.text)?.[1] ?? ''
      if (/KTX/.test(goal)) {
        order.push('train')
        // Something that needs the person: moving two files asks for approval (a card on the phone)
        yield* used(input, rt, 'file', 'file_move', {
          moves: [
            { from: join(dl, 'a.pdf'), folder: join(dl, 'x') },
            { from: join(dl, 'b.pdf'), folder: join(dl, 'y') },
          ],
        })
        yield* say('Approve the move on your phone, then I book it.')
        return
      }
      if (/hotel/i.test(goal)) {
        order.push('hotel')
        await hotel.wait()
        yield* say('Booked the hotel, number 77.')
        return
      }
      if (/weather/i.test(goal)) {
        order.push('weather')
        // Clicking waits for the task that drives the browser; a service tool (which drives it too) as well
        const click: Result = yield* used(input, rt, 'browser', 'click', { tabId: 1, ref: 'e1' })
        const svc: Result = yield* used(input, rt, 'service', 'call', { tool: 'x_search', input: {} })
        refused.push(textOf(click), textOf(svc))
        yield* say('Sunny tomorrow, 16 degrees.')
        return
      }
      // The train task after the approval
      order.push('train again')
      yield* say('Moved the files and booked the train, ticket 1234.')
    }
    const rt = new TwoSessions(conversation, task)
    const {
      api,
      send,
      state,
      task: view,
    } = await boot(rt, {
      fileFolders: { desktop: [], documents: [], downloads: [dl] },
      finishJudge: async () => '{"done":true,"why":"ok"}',
    })
    await send('book a KTX to Busan on Friday')
    await until(async () => (await view('t1'))?.status === 'needs-you', 'train waits on its card')
    // Waiting on the card, it does not hold the browser: the hotel booking does not queue behind it
    await send('book a hotel in Busan')
    await until(async () => (await view('t2'))?.status === 'working', 'hotel runs')
    await until(() => order.includes('hotel'), 'hotel turn')
    // The person approves while the hotel task drives the browser: the train task waits first in line
    const { approvals } = (await (await api('/api/approvals')).json()) as { approvals: { id: string }[] }
    await api(`/api/approvals/${approvals[0]?.id}`, { method: 'POST', body: '{"decision":"approve"}' })
    await until(async () => (await view('t1'))?.status === 'waiting', 'train in line')
    expect((await view('t1'))?.ahead).toBe(1)
    // A quick lookup starts at once, beside the hotel task, without waiting for either
    await send('look up the weather in Busan tomorrow')
    await until(async () => (await view('t3'))?.status === 'done', 'lookup done')
    expect((await view('t2'))?.status).toBe('working')
    expect(order).toEqual(['train', 'hotel', 'weather'])
    expect(refused[0]).toContain('clicking, typing, signing in, paying and PC apps wait for it')
    expect(refused[0]).toContain('t2 "Hotel"')
    expect(refused[1]).toContain('Service tools drive the browser')
    // The hotel finishes; the train task takes the browser back and goes on with the approval's result
    hotel.open()
    await until(async () => (await view('t1'))?.status === 'done', 'train done')
    expect(order).toEqual(['train', 'hotel', 'weather', 'train again'])
    const resumed = rt.seen.filter((x) => rt.kind(x) === 'task').at(-1)?.text ?? ''
    expect(resumed).not.toContain('Goal:')
    const msgs = (await state()).messages.map((x) => x.text)
    expect(msgs).toContain('Sunny tomorrow, 16 degrees.')
    expect(msgs).toContain('Moved the files and booked the train, ticket 1234.')
  })

  it("typing in a task's detail is passed on like task_steer, not a raw turn of its chat", async () => {
    const held = gate()
    const results: string[] = []
    let turns = 0
    const task: Script = async function* (input, rt) {
      turns++
      await held.wait()
      const r: Result = yield* used(input, rt, 'life', 'conversation_search', { query: 'train' })
      results.push(textOf(r))
      yield* say('Booked the 7 pm train.')
    }
    const rt = new TwoSessions(conversation, task)
    const { api, task: view } = await boot(rt, { finishJudge: async () => '{"done":true,"why":"ok"}' })
    await api('/api/conversation/messages', { method: 'POST', body: '{"text":"book a train"}' })
    await until(() => turns === 1, 'task turn')
    const threadId = (await view())?.threadId ?? ''
    const r = await api(`/api/threads/${threadId}/messages`, {
      method: 'POST',
      body: '{"text":"make it 7 pm"}',
    })
    expect(r.status).toBe(202)
    expect((await view())?.notes).toBe(1)
    held.open()
    await until(async () => (await view())?.status === 'done', 'done')
    // Delivered at the next tool result; no extra turn was started in the task's chat
    expect(results[0]).toContain('"make it 7 pm"')
    expect(turns).toBe(1)
    const detail = (await (await api(`/api/threads/${threadId}`)).json()) as { messages: StoredMessage[] }
    expect(detail.messages.filter((x) => x.text === 'make it 7 pm')).toHaveLength(1)
  })

  it('stop from the card ends the task, turns down its approvals and posts no result', async () => {
    const held = gate()
    const task: Script = async function* (input) {
      await held.wait(input.signal)
      yield* say('half done')
    }
    const rt = new TwoSessions(conversation, task)
    const { api, state, send, task: view } = await boot(rt)
    await send('book a train')
    await until(() => rt.seen.some((x) => rt.kind(x) === 'task'), 'task turn')
    const r = (await (await api('/api/tasks/t1/stop', { method: 'POST' })).json()) as { ok: boolean }
    expect(r.ok).toBe(true)
    await until(async () => (await view())?.status === 'stopped', 'stopped')
    held.open()
    await new Promise((x) => setTimeout(x, 50))
    expect((await state()).messages.some((x) => x.text === 'half done')).toBe(false)
  })

  it('one browser at a time: the second task waits in line and starts when the first ends', async () => {
    const first = gate()
    const briefs: string[] = []
    const task: Script = async function* (input) {
      briefs.push(input.text)
      if (briefs.length === 1) await first.wait()
      yield* say(`done ${briefs.length}`)
    }
    const rt = new TwoSessions(conversation, task)
    const {
      send,
      task: view,
      state,
    } = await boot(rt, {
      finishJudge: async () => '{"done":true,"why":"ok"}',
    })
    await send('book a train')
    await until(async () => (await view('t1'))?.status === 'working', 't1 working')
    await until(async () => !(await state()).busy, 'conversation free')
    await send('book a hotel')
    await until(async () => (await view('t2'))?.status === 'waiting', 't2 waiting')
    expect((await view('t2'))?.ahead).toBe(1)
    expect(textOf(rt.results.task_start?.[1] as Result)).toContain('in line for the browser (1 ahead)')
    expect(briefs).toHaveLength(1)
    first.open()
    await until(async () => (await view('t2'))?.status === 'done', 't2 done')
    expect(briefs).toHaveLength(2)
    expect(briefs[1]).toContain('Goal: book a hotel')
    const answers = (await state()).messages.filter((x) => /^done \d$/.test(x.text)).map((x) => x.text)
    expect(answers).toEqual(['done 1', 'done 2'])
  })

  it('take it as is: the draft being checked becomes the result', async () => {
    const task: Script = async function* (input, rt) {
      yield { type: 'tool', name: 'mcp__dool2__browser_click', input: { tabId: 1, ref: 'e1' } }
      yield* say('Found 2 trains; the 7 pm one is cheapest.')
    }
    const rt = new TwoSessions(conversation, task)
    let judged = 0
    const {
      api,
      state,
      send,
      task: view,
    } = await boot(rt, {
      finishJudge: (_p, signal) => {
        judged++
        return new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve('{"done":false,"why":"x","next":"y"}')),
        )
      },
    })
    await send('book a train')
    await until(() => judged === 1, 'judging')
    await until(async () => (await view())?.status === 'checking', 'checking')
    expect((await view())?.draft).toBe('Found 2 trains; the 7 pm one is cheapest.')
    const r = (await (await api('/api/tasks/t1/accept', { method: 'POST' })).json()) as { ok: boolean }
    expect(r.ok).toBe(true)
    await until(async () => (await view())?.status === 'done', 'done')
    const msgs = (await state()).messages.filter(
      (x) => x.text === 'Found 2 trains; the 7 pm one is cheapest.',
    )
    expect(msgs).toHaveLength(1)
  })

  it('the conversation has no browser: the daemon refuses it too, and each session gets its kind', async () => {
    const rt = new TwoSessions(conversation, async function* () {
      yield* say('x')
    })
    const { send, state } = await boot(rt)
    await send('open the site')
    await until(async () => (await state()).messages.some((x) => x.text === 'Hmm.'), 'answer')
    expect(textOf(rt.results.open?.[0] as Result)).toContain('This works in a task')
    expect(rt.kind(rt.seen[0] as TurnInput)).toBe('conversation')
  })

  it('each kind of session gets its own instructions', async () => {
    const held = gate()
    const rt = new TwoSessions(conversation, async function* (input, self) {
      // A task cannot manage memory: the daemon refuses it too (round 2: the conversation owns memory and goals)
      yield* used(input, self, 'life', 'memory_save', { text: 'likes window seats', origin: 'said' })
      await held.wait()
      yield* say('Booked: ticket 42.')
    })
    const { send, state } = await boot(rt)
    await send('book a train to Busan')
    await until(() => rt.seen.some((x) => rt.kind(x) === 'task'), 'task turn')
    const conv = rt.seen.find((x) => rt.kind(x) === 'conversation')?.systemPrompt ?? ''
    const work = rt.seen.find((x) => rt.kind(x) === 'task')?.systemPrompt ?? ''
    expect(conv).toContain('## Answer, look up, or hand over')
    expect(conv).not.toContain('## Do the work')
    expect(work).toContain('## Do the work (you are a task)')
    expect(work).not.toContain('## Answer, look up, or hand over')
    await until(() => Boolean(rt.results.memory_save), 'memory_save')
    expect(rt.results.memory_save?.[0]?.isError).toBe(true)
    expect(textOf(rt.results.memory_save?.[0] as Result)).toContain('stay with the conversation')
    held.open()
    await until(async () => (await state()).messages.some((x) => x.text === 'Booked: ticket 42.'), 'result')
  })

  it('a result that names a tool only a task has tells the conversation to hand it over', () => {
    const r = withTaskHint({ content: [{ type: 'text', text: 'Read the tab with browser_read and go on.' }] })
    expect(r.content.at(-1)?.text).toBe(TASK_HINT)
    const plain = { content: [{ type: 'text', text: 'Found 3 orders.' }] }
    expect(withTaskHint(plain)).toBe(plain)
    // A service tool's structured result: the line rides in its hint, where the AI reads it
    const s = withTaskHint({
      content: [{ type: 'text', text: 'x' }],
      structuredContent: {},
      hint: 'use file_find',
    })
    expect(s.hint).toContain(TASK_HINT)
    // service_find in the conversation: when nothing listed fits, a web lookup is a task
    const found = { content: [{ type: 'text', text: '## Air (air) — not connected' }] }
    expect(withTaskHint(found, 'service/find').content.at(-1)?.text).toBe(FIND_HINT)
    expect(withTaskHint(found, 'life/goal_list')).toBe(found)
  })

  it('evals on a test PC: a fresh main segment per scenario, with task sessions on or off', async () => {
    const rt = new TwoSessions(conversation, async function* () {
      yield* say('x')
    })
    const { api, send, state } = await boot(rt, { devReset: true })
    await send('hello')
    await until(async () => (await state()).messages.some((x) => x.text === 'Sure: hello'), 'answer')
    const first = rt.seen.at(-1)?.mcpServers[0]?.env?.DOOL2_TOOLSET
    const r = (await (
      await api('/api/eval/segment', { method: 'POST', body: '{"taskSessions":false}' })
    ).json()) as { ok: boolean; before?: boolean; taskSessions: boolean }
    expect(r).toEqual({ ok: true, before: true, taskSessions: false })
    await send('again')
    await until(async () => (await state()).messages.some((x) => x.text === 'Sure: again'), 'answer 2')
    const second = rt.seen.at(-1)
    // A new segment, without the earlier one carried over, and the conversation has every tool again
    expect(second?.mcpServers[0]?.env?.DOOL2_TOOLSET).not.toBe(first)
    expect(second?.systemPrompt).not.toContain('Sure: hello')
    expect(rt.kind(second as TurnInput)).toBeUndefined()
    // Back to the build's default
    const back = (await (
      await api('/api/eval/segment', { method: 'POST', body: '{"taskSessions":null}' })
    ).json()) as { taskSessions: boolean }
    expect(back.taskSessions).toBe(TASK_SESSIONS_DEFAULT)
  })

  it('a replayed tape never answers the task tools: the task runs for real', async () => {
    const rt = new TwoSessions(conversation, async function* () {
      yield* say('done')
    })
    const {
      api,
      send,
      task: view,
    } = await boot(rt, {
      devReset: true,
      finishJudge: async () => '{"done":true,"why":"ok"}',
    })
    await api('/api/eval/tape', { method: 'POST', body: '{"mode":"replay","entries":[]}' })
    await send('book a train')
    await until(async () => (await view())?.status === 'done', 'task done')
    expect(textOf(rt.results.task_start?.[0] as Result)).toContain('task t1')
    await api('/api/eval/tape', { method: 'POST', body: '{"mode":"off"}' })
  })

  it('evals on a test PC: a task already running when the scenario begins, which never runs', async () => {
    const rt = new TwoSessions(conversation, async function* () {
      yield* say('the task ran')
    })
    const { api, send, state, task: view } = await boot(rt, { devReset: true })
    const seed = (body: unknown) => api('/api/eval/task', { method: 'POST', body: JSON.stringify(body) })
    expect((await seed({ title: 'Train' })).status).toBe(400)
    const r = (await (
      await seed({
        title: 'Train',
        goal: 'book a KTX to Busan on Friday evening, 2 people',
        done_when: ['a ticket number is read'],
        now: 'picking seats',
      })
    ).json()) as { ok: boolean; task: TaskView }
    expect(r.task).toMatchObject({ id: 't1', status: 'working', now: 'picking seats' })
    // The conversation is told it runs, and its card is in the segment the message goes to
    await send('how is the weather')
    await until(
      async () => (await state()).messages.some((x) => x.text === 'Sure: how is the weather'),
      'answer',
    )
    const conv = rt.seen.find((i) => rt.kind(i) === 'conversation')
    expect(`${conv?.aside ?? ''}${conv?.text ?? ''}`).toContain('t1 "Train" (working)')
    expect((await state()).messages.some((x) => x.role === 'tool' && x.text.includes('"kind":"task"'))).toBe(
      true,
    )
    // Steering it keeps the note for the record instead of running the task
    await send('make it 7 pm')
    await until(async () => (await state()).messages.some((x) => x.text === 'Passed on.'), 'steer')
    const got = (await (await api('/api/eval/task/t1')).json()) as { task: TaskView; told: string[] }
    expect(got.task.status).toBe('working')
    expect(got.told.join('\n')).toContain('make it 7 pm')
    expect(rt.seen.some((i) => rt.kind(i) === 'task')).toBe(false)
    // The next scenario's fresh segment ends it
    await api('/api/eval/segment', { method: 'POST', body: '{"taskSessions":true}' })
    expect((await view())?.status).toBe('stopped')
    expect((await api('/api/eval/task/t9')).status).toBe(404)
  })

  it("task_steer passes the user's own words, refuses words they never wrote, and marks what the AI added", async () => {
    const rt = new TwoSessions(conversation, async function* () {
      yield* say('the task ran')
    })
    const { api, send, state } = await boot(rt, { devReset: true })
    await api('/api/eval/task', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Train',
        goal: 'book a KTX to Busan on Friday evening, 2 people',
        done_when: ['a ticket number is read'],
      }),
    })
    await send('change it to 7')
    await until(async () => (await state()).messages.some((x) => x.text === 'Passed on.'), 'steer')
    const [refused, passed] = rt.results.task_steer ?? []
    // "7 am" is not what the user wrote: refused, with their words to copy
    expect(refused?.isError).toBe(true)
    expect(textOf(refused as Result)).toContain('"change it to 7"')
    expect(passed?.isError).toBeFalsy()
    const got = (await (await api('/api/eval/task/t1')).json()) as { told: string[] }
    const told = got.told.join('\n')
    // Only the second call reached the task: the user's words first, the addition after them as Dool2's own
    expect(told).not.toContain('7 am')
    expect(told).toContain(
      '"change it to 7" (Dool2\'s own addition, not the user\'s words: the Friday train)',
    )
    // The task's chat shows the person only their own words
    expect(told).toContain('"change it to 7" 전해 받았어요.')
    await api('/api/eval/segment', { method: 'POST', body: '{"taskSessions":true}' })
  })

  it('the eval segment switch is for test PCs only', async () => {
    const rt = new TwoSessions(conversation, conversation)
    const { api } = await boot(rt)
    expect((await api('/api/eval/segment', { method: 'POST', body: '{"taskSessions":true}' })).status).toBe(
      403,
    )
    expect((await api('/api/eval/task', { method: 'POST', body: '{}' })).status).toBe(403)
  })

  it('without the setting nothing changes: no session kind, no task tools', async () => {
    const rt = new TwoSessions(conversation, conversation)
    const { api, send, state } = await boot(rt)
    await api('/api/settings', { method: 'PATCH', body: '{"taskSessions":false}' })
    await send('hello')
    await until(async () => (await state()).messages.some((x) => x.text === 'Sure: hello'), 'answer')
    expect(rt.kind(rt.seen.at(-1) as TurnInput)).toBeUndefined()
    // A chat that talks and works: both parts of the instructions
    const sp = rt.seen.at(-1)?.systemPrompt ?? ''
    expect(sp).toContain('## Answer, look up, or hand over')
    expect(sp).toContain('## Do the work')
  })
})
