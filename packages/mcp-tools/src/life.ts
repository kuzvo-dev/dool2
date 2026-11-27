// Dool2 life tools: goals and scheduled runs, Library, memory, feed. The Dool2 daemon does the actual storing.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { BrowserClient } from './browser.js'
import { GOAL_CATEGORIES } from './region/kr/goals.js'

const time = z
  .string()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/)
  .describe('Korea time HH:MM (e.g. "07:30")')

/** "When" fields (shared by goal_create and goal_update) */
const whenFields = {
  schedule: z
    .enum(['daily', 'weekly', 'monthly', 'once', 'every'])
    .optional()
    .describe('every = every N minutes. Omit for goals without a set time'),
  time: time.optional(),
  days: z.array(z.number().int().min(0).max(6)).optional().describe('weekly: 0 = Sun … 6 = Sat'),
  day: z.number().int().min(1).max(31).optional().describe('monthly: 31 = the last day'),
  at: z.string().optional().describe('once: ISO time with +09:00'),
  minutes: z.number().int().min(1).optional().describe('every: 15 or more; 1 or more with check_tool'),
  check_tool: z
    .string()
    .max(120)
    .optional()
    .describe(
      'Watches of things that vanish fast: a lookup service tool (e.g. "catchtable_search") the daemon runs without you; you are woken only when its result changes',
    ),
  check_input: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Input for check_tool, as you would call it'),
  until: z
    .string()
    .max(120)
    .optional()
    .describe(
      'When it ends: a date "2026-12-31" or a condition in the user\'s language ("once a ticket is grabbed"). Required for watches',
    ),
  notify: z
    .enum(['always', 'when_found'])
    .optional()
    .describe('when_found: only when the condition is met (watches); always is the default'),
  tell_at: z
    .string()
    .optional()
    .describe('HH:MM to delay only the phone notification ("do it overnight, tell me at 7")'),
}

/**
 * The same fields for goal_update, described in a word: goal_create (always listed next to it) explains each one, and
 * the long descriptions were sent twice on every request
 */
const whenUpdate = Object.fromEntries(
  Object.entries(whenFields).map(([k, f]) => [
    k,
    f.describe(
      k === 'until' || k === 'tell_at'
        ? `As in goal_create; "" clears it`
        : k === 'time'
          ? 'As in goal_create; to change only the time, give just this and the rest stays'
          : 'As in goal_create',
    ),
  ]),
) as typeof whenFields

export function registerLifeTools(server: McpServer, client: BrowserClient) {
  const call = (tool: string) => async (args: Record<string, unknown>) => {
    const r = await client(tool, args)
    return { content: r.content, ...(r.isError ? { isError: true } : {}) }
  }
  server.registerTool(
    'goal_create',
    {
      title: 'Create a goal or scheduled task',
      description:
        'Creates a reminder, a scheduled task or a long-term goal when the user wants Dool2 to do something on its own at set times; create it, don\'t ask "Shall I set that up?". Examples: "call the dentist at 10 tomorrow" → once · "heartworm pill on the 1st" → monthly day 1 · "card bill on the last day" → monthly day 31 · "tell me when a cancelled ticket shows up" → every + notify when_found + until, with check_tool when a lookup tool can see it · "warn me if shopping goes over 300,000 won this month" → daily + when_found + until the month\'s end. Check goal_list first for one that does the same. Write text in the user\'s language.',
      inputSchema: {
        title: z.string().max(60).describe('Short name (e.g. "Morning briefing")'),
        prompt: z
          .string()
          .max(1000)
          .describe('What Dool2 does at that time, as a request to Dool2, conditions included'),
        ...whenFields,
        category: z.enum(GOAL_CATEGORIES).optional().describe('Long-term goals only'),
        plan: z.array(z.string().max(120)).max(12).optional().describe('Goals: 3-6 steps'),
        target: z.enum(['chat', 'feed']).optional().describe('Where the result goes (default chat)'),
        preview: z
          .boolean()
          .optional()
          .describe('true: run once now (briefings and digests, so the user sees the shape)'),
      },
    },
    call('goal_create'),
  )
  server.registerTool(
    'goal_list',
    {
      title: 'View goals and schedules',
      description:
        'Shows goals and scheduled tasks with their next runs and past results. Check it before saying a schedule exists or relying on one (the user may have deleted it).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    call('goal_list'),
  )
  server.registerTool(
    'goal_update',
    {
      title: 'Update a goal',
      description:
        'Changes a goal or schedule: plan steps, finished steps (done, from 0), progress (log), what it does (prompt), when, until or notify. Give only what changes. When its end condition is met, delete it (goal_delete).',
      inputSchema: {
        id: z.string().max(40).describe('id from goal_list (the first 8 characters work too)'),
        title: z.string().max(60).optional(),
        prompt: z.string().max(1000).optional().describe('When rewriting what Dool2 should do at that time'),
        ...whenUpdate,
        plan: z.array(z.string().max(120)).max(12).optional(),
        done: z.array(z.number().int().min(0)).optional(),
        log: z.string().max(300).optional().describe('Progress in a sentence or two'),
      },
    },
    call('goal_update'),
  )
  server.registerTool(
    'goal_delete',
    {
      title: 'Delete a goal or schedule',
      description: 'Deletes a goal or reminder the user wants to stop.',
      inputSchema: { id: z.string().max(40).describe('id from goal_list (the first 8 characters work too)') },
    },
    call('goal_delete'),
  )
  server.registerTool(
    'library_save',
    {
      title: 'Save to the Library',
      description:
        'Saves something the user may reuse to the Library: notes and comparison tables, links, products with price, places. Use after a comparison or list worth keeping, or on "save this"; say so in a few words.',
      inputSchema: {
        kind: z.enum(['note', 'link', 'product', 'place', 'file']),
        title: z.string().max(80),
        body: z.string().max(4000).describe('Content (Markdown lists and bold allowed)'),
        url: z.string().max(500).optional(),
        price: z.string().max(40).optional().describe('Product price (e.g. "₩15,900")'),
      },
    },
    call('library_save'),
  )
  server.registerTool(
    'library_find',
    {
      title: 'Look in the Library',
      description:
        'Looks up what the user saved in the Library ("the one I saved", "what\'s in my Library") instead of guessing. For things said in chat, use conversation_search.',
      inputSchema: {
        query: z
          .string()
          .max(100)
          .optional()
          .describe('1-3 words in the language the items were saved in. Empty = most recent'),
        kind: z
          .enum(['note', 'link', 'product', 'place', 'file'])
          .optional()
          .describe('file = photos and files'),
        limit: z.number().int().min(1).max(20).optional(),
        skip: z.number().int().min(0).optional().describe('The "skip: N" the result gave, to continue'),
      },
      annotations: { readOnlyHint: true },
    },
    call('library_find'),
  )
  server.registerTool(
    'memory_save',
    {
      title: 'Remember',
      description:
        "Remembers a fact about the user that saves asking again (how to address them, home, office, family, likes, services used, habits), as soon as you hear it. One sentence in the user's language. Save quietly, without announcing it. Never passwords, card or resident numbers.",
      inputSchema: {
        text: z.string().max(200).describe('E.g. "Commutes by SRT from Dongtan Station"'),
        origin: z
          .enum(['said', 'account', 'web'])
          .describe(
            "said = the user told you · account = the user's own signed-in pages. Web pages and others' mail are not memory (know_save, origin web)",
          ),
      },
    },
    call('memory_save'),
  )
  server.registerTool(
    'know_save',
    {
      title: 'Record what you learned',
      description:
        'Records in one line a fact seen on the user\'s own signed-in pages (fact) or something Dool2 did or confirmed (done: an application, payment, order, booking, sign-up), so the next request needs no new verification. Add source and basis; for things done and expiries add next and next_what, and the proactive check follows up then (no goal for the same time). The same title is replaced. E.g. {kind: "fact", title: "Total salary, tax year 2025", value: "about 77.5M won", origin: "account", source: "Hometax", basis: "tax year 2025"}. Never resident, account or card numbers, passwords, or other people\'s information.',
      inputSchema: {
        kind: z
          .enum(['fact', 'done'])
          .describe('fact = a fact seen · done = something Dool2 did or confirmed'),
        title: z.string().max(80).describe('What (e.g. "Total salary, tax year 2025")'),
        value: z.string().max(200).describe('E.g. "Applied, announced 11/24"'),
        source: z.string().max(40).optional().describe('Where it was seen'),
        origin: z
          .enum(['said', 'account', 'web'])
          .describe(
            "account = the user's own signed-in pages · said = the user told you, or Dool2 did it · web = other pages and others' mail (never added to your instructions)",
          ),
        url: z.string().max(500).optional(),
        basis: z.string().max(40).optional().describe('As-of point (e.g. "tax year 2025")'),
        next: z.string().max(30).optional().describe('When to follow up (YYYY-MM-DD[THH:MM])'),
        next_what: z.string().max(80).optional().describe('What to check then'),
        state: z.enum(['open', 'done']).optional(),
      },
    },
    call('know_save'),
  )
  server.registerTool(
    'know_find',
    {
      title: 'Find what you learned',
      description:
        'Searches facts Dool2 learned and the log of things done. Check it before verifying again (income, taxes, benefits, insurance, "did I apply?"). Judge from the date and basis whether it is still good; if so, answer with that date and source, and look again before applying or paying.',
      inputSchema: {
        query: z
          .string()
          .max(60)
          .optional()
          .describe('Words in the language they were saved in. Empty = most recent'),
        kind: z.enum(['fact', 'done']).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    call('know_find'),
  )
  server.registerTool(
    'know_update',
    {
      title: 'Update the log of things done',
      description:
        'Updates a known fact or a thing done: state "done" after a cancellation, refund, delivery or announcement (kept, not deleted), a new next, or a changed value.',
      inputSchema: {
        id: z.string().max(40).optional().describe('id from the know_find result'),
        title: z.string().max(80).optional().describe('Part of the title, if the id is unknown'),
        value: z.string().max(200).optional(),
        state: z.enum(['open', 'done']).optional(),
        next: z.string().max(30).optional().describe('"" = no more follow-ups'),
        next_what: z.string().max(80).optional(),
      },
    },
    call('know_update'),
  )
  server.registerTool(
    'memory_forget',
    {
      title: 'Forget',
      description: 'Deletes a memory the user asks you to forget, or one that is wrong.',
      inputSchema: { text: z.string().max(200).describe('Part of the memory to delete, or its id') },
    },
    call('memory_forget'),
  )
  server.registerTool(
    'recipe_forget',
    {
      title: 'Forget steps',
      description:
        'Deletes steps Dool2 remembered for a kind of request (the [k…] lines that ride on a message, ADR 0044), when the user asks not to do it that way again or the steps are wrong.',
      inputSchema: {
        id: z.string().max(20).describe('Recipe id from the note, e.g. "k3"'),
      },
    },
    call('recipe_forget'),
  )
  server.registerTool(
    'idea_suggest',
    {
      title: 'Post personalized ideas',
      description:
        "Puts 3-6 things worth doing for the user now at the top of the Ideas tab. Based on memory, goals, connected services and recent chats, pick only concrete tasks Dool2 can actually do. Write them in the user's language.",
      inputSchema: {
        ideas: z
          .array(
            z.object({
              text: z
                .string()
                .max(120)
                .describe(
                  'Request sent as is when tapped (e.g. "Find SRT seats to Busan for this Friday evening")',
                ),
              why: z
                .string()
                .max(120)
                .describe(
                  'One line on why this is good now (e.g. "You have been going to Busan every weekend")',
                ),
            }),
          )
          .min(1)
          .max(6),
      },
    },
    call('idea_suggest'),
  )
  server.registerTool(
    'photo_view',
    {
      title: 'View a sent photo',
      description:
        "Views a photo the user sent (the message ends with a photo marker and file name) before answering: receipts, screenshots, products. Don't copy card or resident numbers from it.",
      inputSchema: {
        name: z.string().max(80).describe('Photo file name (e.g. 2026-11-16T01-30-00-000Z.jpg)'),
      },
      annotations: { readOnlyHint: true },
    },
    call('photo_view'),
  )
  server.registerTool(
    'connect_ask',
    {
      title: 'Show a service connect card',
      description:
        "Shows a service's connect card when the user asks to connect it or the next step needs their login (booking, ordering, their own history). Do what works without login first. The user signs in on the card (never in chat); a note arrives when done, then continue. The result says what is left on the card, and the turn waits.",
      inputSchema: {
        service: z.string().max(60).describe('Card id or service name (e.g. "coupang")'),
        afterwards: z
          .string()
          .max(200)
          .optional()
          .describe(
            'What you do right after it is connected, when the user asked for something that needs it (e.g. "read tomorrow\'s calendar"). Leave it out when the user only asked to connect or switch accounts: then Dool2 just says it is connected',
          ),
        another: z
          .boolean()
          .optional()
          .describe(
            'true when the user wants a different account than the one connected or signed in now ("switch accounts", "use my other account"): no automatic sign-in with the saved account, the card asks for the other one',
          ),
      },
    },
    call('connect_ask'),
  )
  server.registerTool(
    'profile_view',
    {
      title: 'View my info',
      description:
        "Views the user's saved info (name, mobile, email, birth year, address, authentication app) as masked values. Check it before asking about age, where they live or eligibility.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    call('profile_view'),
  )
  server.registerTool(
    'pay_method_list',
    {
      title: 'View my payment methods',
      description:
        'Lists the payment methods the user registered (card company, nickname, last 4 digits; the first is the main one). Check it before asking which card they use.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    call('pay_method_list'),
  )
  server.registerTool(
    'ai_account_view',
    {
      title: 'View which AI Dool2 runs on and its API key',
      description:
        'Shows which AI Dool2 runs on: subscriptions signed in, and for pay-as-you-go the company, model and last 4 characters of the API key. Use it when the user asks about their AI, plan or API key, or wants to change it; the result says where they change it (never in chat).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    call('ai_account_view'),
  )
  server.registerTool(
    'ai_use',
    {
      title: 'Switch which AI Dool2 runs on',
      description:
        'Switches the AI Dool2 runs on to another one connected on this PC, when the user asks ("use Codex from now on", "switch back to Claude"). The next message runs on it in a fresh session with the recent chat carried over; this answer and running tasks stay on the current AI. Only a connected AI is taken: the result says which ones are and where the others get connected. ai_account_view shows what is connected.',
      inputSchema: {
        agent: z
          .enum(['claude', 'codex', 'opencode'])
          .describe('claude = Claude Code, codex = Codex, opencode = the pay-as-you-go API key'),
      },
    },
    call('ai_use'),
  )
  server.registerTool(
    'vault_find',
    {
      title: 'View logins saved in the vault',
      description:
        'Shows the sites with a login saved in the Dool2 vault (site, masked ID, last used). Passwords never come back.',
      inputSchema: {
        site: z.string().max(100).optional().describe('Service name or address. Empty = all'),
      },
      annotations: { readOnlyHint: true },
    },
    call('vault_find'),
  )
  server.registerTool(
    'show_cards',
    {
      title: 'Attach cards to the answer',
      description:
        'Attaches candidates chosen by their photo (products, stays, restaurants, shows) as photo cards below the answer; tapping pick sends the choice. 2-8 cards in recommended order, image, link and price exactly as the tool result gave them. For an order with several options, badge the first as recommended; when the user picks, add it and go on to payment approval. Then say only why and how they differ ("the cards below").',
      inputSchema: {
        cards: z
          .array(
            z.object({
              title: z.string().max(80),
              image: z.string().max(800).optional(),
              price: z.string().max(40).optional().describe('E.g. "₩112,260 per night"'),
              note: z.string().max(60).optional().describe('E.g. "★4.8 (1,203) · arrives tomorrow"'),
              url: z.string().max(800).optional(),
              badge: z.string().max(12).optional().describe('E.g. "Lowest price"'),
            }),
          )
          .min(1)
          .max(10),
        shape: z.enum(['square', 'portrait']).optional().describe('portrait for posters and book covers'),
      },
    },
    call('show_cards'),
  )
  // Result blocks (docs/design/system/components/ChatBlocks). One result block per answer: if called several times,
  // only the last one is attached
  const blockAction = z.object({
    label: z.string().max(16).describe('A verb (e.g. "Add to calendar")'),
    ask: z.string().max(300).optional().describe("Request sent to Dool2 on tap, in the user's words"),
    url: z.string().max(800).optional().describe('Address to open instead of ask'),
  })
  server.registerTool(
    'show_list',
    {
      title: 'Attach list rows to the answer',
      description:
        'Attaches a list below the answer when photos are not the reason to choose (orders, emails, events, deadlines, documents, notices, listings), instead of a text list. lead picks the look (date needs date). pick one: the user picks one row (show times, slots, branches, plans, more than 5 companies), with no quick replies. pick multi: several at once (cart items); on false for uncertain ones with the reason in sub; amount on every row shows a total. Benefits and notices: qualifies or not in state, deadline in date. action is one button for the whole list; money, contact and deletion still get approval. Then say only reasons and next steps ("the list below").',
      inputSchema: {
        title: z.string().max(40).optional().describe('Header line'),
        from: z.string().max(24).optional().describe('Source or count (e.g. "46 items")'),
        lead: z.enum(['img', 'date', 'file', 'logo', 'none']).optional(),
        pick: z.enum(['one', 'multi']).optional(),
        rows: z
          .array(
            z.object({
              title: z.string().max(60),
              sub: z.string().max(60).optional(),
              value: z.string().max(20).optional().describe('Bold value on the right (e.g. "₩15,960")'),
              valueNote: z.string().max(24).optional(),
              state: z.string().max(12).optional().describe('Status (e.g. "Shipping")'),
              tone: z.enum(['done', 'wait', 'stop']).optional(),
              image: z.string().max(800).optional(),
              date: z.string().max(10).optional().describe('YYYY-MM-DD'),
              file: z.string().max(5).optional().describe('E.g. "PDF"'),
              url: z.string().max(800).optional(),
              on: z.boolean().optional(),
              amount: z.number().optional().describe('Won, quantity included'),
            }),
          )
          .min(1)
          .max(30),
        action: blockAction.optional(),
      },
    },
    call('show_list'),
  )
  server.registerTool(
    'show_result',
    {
      title: 'Attach one result card to the answer',
      description:
        'Attaches one result card below the answer when the answer is one value: proof of completion with its number (done: only values read on the completion screen), a total (bill, refund), a delivery or application stage, a deadline. big is the one when or how much, facts 3-6 lines (code for numbers), steps the stages and current one, due a deadline countdown, up to 2 buttons. Then one or two sentences.',
      inputSchema: {
        title: z.string().max(40).optional().describe('Header line (e.g. "Booking confirmed")'),
        from: z.string().max(24).optional().describe('Source'),
        done: z.boolean().optional(),
        big: z.string().max(40).describe('E.g. "11/21 (Sat) 19:00", "₩1,284,300"'),
        bigNote: z.string().max(24).optional(),
        facts: z
          .array(
            z.object({
              label: z.string().max(14),
              value: z.string().max(40),
              code: z.boolean().optional(),
            }),
          )
          .max(6)
          .optional(),
        steps: z
          .object({
            names: z.array(z.string().max(10)).min(2).max(6),
            now: z.number().int().min(0).describe('From 0'),
          })
          .optional(),
        due: z.string().max(10).optional().describe('YYYY-MM-DD'),
        dueLabel: z.string().max(8).optional(),
        actions: z.array(blockAction).max(2).optional(),
      },
    },
    call('show_result'),
  )
  server.registerTool(
    'show_route',
    {
      title: 'Attach a route card to the answer',
      description:
        'Attaches a directions result as a route card below the answer: one conclusion line (big), a line-colored bar (share of minutes per leg), and leg rows (line, boarding stop → getting-off stop, last train or bus). ' +
        'For questions about public transit routes, transfers or last trains, find routes with a directions tool (kakao_map_transit, etc.) and put in the one route you chose. ' +
        'big is the conclusion the user acts on right away (e.g. "Leave Gangnam Station by 23:25", "1 h 16 min"); bigNote is transfers and fare. ' +
        "legs in boarding order: line (Line 2, Express M7731, walk), from and to (stations, stops), minutes (minutes for that leg), last (last departure at that leg's boarding stop, HH:MM), note (direction, exit). " +
        'In facts, 1-3 lines of fallbacks or other routes if this one is missed (e.g. if missed → "M7731 from Hapjeong, until 00:21 at Gangnam"). One button: the directions address (url). ' +
        "Once attached, do not repeat the legs in the answer text; give only the one-line conclusion and the fallbacks. Write card text in the user's language; keep station and line names as the user knows them.",
      inputSchema: {
        title: z
          .string()
          .max(40)
          .optional()
          .describe('Header line (e.g. "Gangnam Station → Daehwa Station")'),
        from: z.string().max(24).optional().describe('Source (e.g. "Kakao Map")'),
        big: z.string().max(40).describe('One conclusion (e.g. "Leave Gangnam Station by 23:25")'),
        bigNote: z
          .string()
          .max(30)
          .optional()
          .describe('Small text (e.g. "1 h 16 min · 1 transfer · ₩2,150")'),
        legs: z
          .array(
            z.object({
              mode: z
                .enum(['subway', 'bus', 'train', 'walk', 'etc'])
                .optional()
                .describe('Mode (if omitted, guessed from the line name)'),
              line: z.string().max(24).describe('Line (e.g. "Line 2", "Express M7731", "Walk")'),
              from: z.string().max(30),
              to: z.string().max(30),
              minutes: z.number().int().min(1).max(600).optional(),
              last: z.string().max(8).optional().describe('Last departure at the boarding stop, HH:MM'),
              note: z.string().max(30).optional().describe('Direction or exit (e.g. "toward Daehwa")'),
            }),
          )
          .min(1)
          .max(8),
        facts: z
          .array(z.object({ label: z.string().max(14), value: z.string().max(60) }))
          .max(4)
          .optional(),
        actions: z.array(blockAction).max(2).optional(),
      },
    },
    call('show_route'),
  )
  server.registerTool(
    'show_draft',
    {
      title: 'Attach a draft to send',
      description:
        'Attaches text that will be sent word for word (text, KakaoTalk, email, petition, review, post) below the answer; write a usable one right away from what you know, with blanks like [date] for facts the user did not give. The user taps copy or send; sending asks approval then. Reviews: 3-5 natural sentences, 5 stars, neutral answers to required questions. Then one or two sentences.',
      inputSchema: {
        to: z.string().max(30).optional().describe('Recipient (e.g. "Landlord Mr. Kim")'),
        via: z.enum(['sms', 'kakao', 'mail', 'post', 'other']).describe('post = a petition, review or post'),
        subject: z.string().max(80).optional().describe('mail only'),
        text: z.string().max(2000),
      },
    },
    call('show_draft'),
  )
  server.registerTool(
    'phone_sms',
    {
      title: 'Send a text (from my phone number)',
      description:
        "Sends a text (SMS) from the user's phone number after they approve it on the phone. Give the contact name as saved; the phone finds the number, so don't ask for it. The result says what is left on the phone and the turn waits; the outcome arrives later. KakaoTalk goes through kakao_send.",
      inputSchema: {
        to: z.string().max(40).describe('Contact name as saved, or a number. One person per call'),
        text: z.string().max(1000).describe('Exactly what is sent; no facts the user did not give'),
      },
    },
    call('phone_sms'),
  )
  server.registerTool(
    'feed_post',
    {
      title: 'Post to the feed',
      description:
        "Posts news worth knowing but not worth saying in chat as a short post in the feed (feed instructions, goal check-in results, etc.). Write it in the user's language.",
      inputSchema: {
        title: z.string().max(80),
        body: z.string().max(1500).describe('The key points in 3-5 lines. Only confirmed facts'),
      },
    },
    call('feed_post'),
  )
  server.registerTool(
    'feed_tell',
    {
      title: 'Share a proactive heads-up',
      description:
        'Tells the user something new worth knowing now that they did not ask about, confirmed on connected services (a delivery, an upcoming booking, a mail needing a reply, a result, a payment or expiry, an anniversary). It goes to the top of the feed with a phone notification. No guesses, ads or general knowledge; up to 3 per check; the same key is never posted twice. ask: what Dool2 does if the user taps the button (it only suggests, never pays or sends).',
      inputSchema: {
        title: z.string().min(1).max(80).describe("One line in Dool2's voice"),
        body: z.string().max(600).optional().describe('One or two more sentences'),
        from: z.string().max(60).optional().describe('Where you learned it'),
        key: z
          .string()
          .min(1)
          .max(120)
          .describe('service-target-status (e.g. "coupang-order12345-arriving")'),
        ask: z.string().max(300).optional().describe('Request sent to Dool2 on tap. Empty for a notice'),
        ask_label: z.string().max(12).optional(),
      },
    },
    call('feed_tell'),
  )
  server.registerTool(
    'feed_find',
    {
      title: 'View the feed and what Dool2 did',
      description:
        'Views the feed as the user sees it (finished tasks, scheduled results, news, Library saves, heads-ups), with counts per kind, for "what did Dool2 do this week?" or a past heads-up, instead of guessing. Kept 90 days, in pages (before). For things said in chat, use conversation_search.',
      inputSchema: {
        query: z.string().max(100).optional().describe('1-3 words. Empty = most recent'),
        kinds: z
          .array(z.enum(['done', 'routine', 'post', 'saved', 'goal', 'connected', 'suggest']))
          .optional()
          .describe('suggest = heads-ups, routine = scheduled results'),
        days: z.number().int().min(1).max(90).optional().describe('Only the last N days'),
        before: z.string().max(80).optional().describe('The "before: …" value from the previous result'),
        limit: z.number().int().min(1).max(30).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    call('feed_find'),
  )
  server.registerTool(
    'conversation_search',
    {
      title: 'Search past conversations',
      description:
        'Searches earlier conversations when the user brings up something said before that is not in this conversation ("the vacuum we looked at last week"), instead of guessing. Excerpts come back with date and speaker. If nothing matches, try other words once, then say you don\'t remember.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(100)
          .describe('1-3 key words in the language of that conversation, not sentences'),
        limit: z.number().int().min(1).max(20).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    call('conversation_search'),
  )
}
