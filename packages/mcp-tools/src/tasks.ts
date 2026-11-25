// Task tools (ADR 0038): the conversation hands longer work to a task session and keeps talking. The daemon runs the
// task sessions; these tools only start, steer, stop and list them.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { BrowserClient } from './browser.js'

const id = z.string().max(40).describe('Task id from task_start or task_list (e.g. "t3")')

export function registerTaskTools(server: McpServer, client: BrowserClient) {
  const run = (name: string) => async (args: Record<string, unknown>) => {
    const r = await client(name, args)
    return { content: r.content, ...(r.isError ? { isError: true } : {}) }
  }
  server.registerTool(
    'task_start',
    {
      title: 'Hand work to a task',
      description:
        'Starts a task that works on its own while you keep talking with the user. Use it for anything that needs the ' +
        'browser or PC apps (booking, ordering, applying, filling in a form, comparing sites, signing in somewhere, ' +
        'sending a text) or several steps; answer one or two lookups yourself. Write the spec from the conversation so ' +
        'the task never has to ask again. Returns at once and the turn waits: say in one short sentence that you are on ' +
        'it. The user follows it on a card and its result reaches this conversation by itself; do not repeat it.',
      inputSchema: {
        title: z
          .string()
          .max(40)
          .describe('Short name on the card, in the user\'s language (e.g. "KTX to Busan")'),
        goal: z
          .string()
          .min(4)
          .max(1500)
          .describe("What to get done, in full: the request in the user's words plus what was settled since"),
        done_when: z
          .array(z.string().max(200))
          .min(1)
          .max(6)
          .describe(
            'Conditions that make it done, checkable on the result (e.g. "a booking number read on the completion ' +
              'screen", "3 insurers compared with the same coverage"). The result is checked against these',
          ),
        known: z
          .array(z.string().max(200))
          .max(12)
          .optional()
          .describe(
            'Values already known from the conversation, memory or lookups (date, people, budget, the site the user named, the service and price of a candidate the user picked: the task stays with it)',
          ),
        avoid: z
          .array(z.string().max(200))
          .max(8)
          .optional()
          .describe(
            'What must not happen, in the user\'s terms (e.g. "nothing over 100,000 won", "not a window seat")',
          ),
        browser: z
          .boolean()
          .optional()
          .describe(
            'false only if it needs neither web pages nor PC apps. Tasks that click, type, sign in or pay take turns with the browser',
          ),
        lookup: z
          .boolean()
          .optional()
          .describe(
            'true when it only reads pages (weather, a price, opening hours, news): it starts at once in its own tab, even while another task uses the browser',
          ),
      },
    },
    run('task_start'),
  )
  server.registerTool(
    'task_steer',
    {
      title: 'Tell a task something',
      description:
        'Passes the user\'s words to a task, exactly as they wrote them: a change ("make it 7"), an answer to its ' +
        'question or an extra condition. Use it when the user talks about a task already started instead of starting ' +
        'another. The task reads it at its next step together with its spec (a task for Friday evening reads "7" as ' +
        '7 pm), so do not fill in what the user left open.',
      inputSchema: {
        id,
        said: z
          .string()
          .min(1)
          .max(600)
          .describe(
            "The user's own words about the task, copied exactly (the part of their message that is about it). Not reworded, completed or translated",
          ),
        added: z
          .string()
          .max(300)
          .optional()
          .describe(
            'Only what the conversation already settled that the task needs to read those words (e.g. "the train is the one in the task, Friday"). The task sees it as yours, not the user\'s. Never a detail the user did not give',
          ),
      },
    },
    run('task_steer'),
  )
  server.registerTool(
    'task_stop',
    {
      title: 'Stop a task',
      description:
        'Stops a task when the user wants it stopped or cancelled. What it already did stays (an order placed is not undone).',
      inputSchema: { id },
    },
    run('task_stop'),
  )
  server.registerTool(
    'task_list',
    {
      title: 'Tasks',
      description:
        'What each task of this conversation is doing, what it waits on (the user, an approval, its turn for the ' +
        'browser) and what came out. Use it when the user asks how a task is going, or to find the id to steer or stop.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    run('task_list'),
  )
}
