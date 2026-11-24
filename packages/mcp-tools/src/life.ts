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
    .describe(
      'daily = every day, weekly = on weekdays (several allowed), monthly = on a day of the month, once = one time, every = every N minutes. Omit for goals without a set time',
    ),
  time: time.optional().describe('For daily, weekly, monthly: Korea time HH:MM (e.g. "09:00")'),
  days: z
    .array(z.number().int().min(0).max(6))
    .optional()
    .describe('For weekly: weekdays (0 = Sun … 6 = Sat, e.g. Mon, Wed, Fri = [1,3,5])'),
  day: z
    .number()
    .int()
    .min(1)
    .max(31)
    .optional()
    .describe('For monthly: day 1-31. Use 31 for the last day (months without that day use their last day)'),
  at: z
    .string()
    .optional()
    .describe('For once: ISO time (with Korea time +09:00, e.g. "2026-11-20T10:00:00+09:00")'),
  minutes: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('For every: interval in minutes. 15 or more; 1 or more only with check_tool (a quick check)'),
  check_tool: z
    .string()
    .max(120)
    .optional()
    .describe(
      'Quick check for watches of things that vanish fast (cancelled tickets, open tables, restocks, price drops): a lookup service tool (e.g. "catchtable_search") the daemon runs at each set time without you. You are woken only when its result changes, so every 1 minute is fine. Use with schedule every + notify when_found + until. Only lookup tools; it never books or pays',
    ),
  check_input: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Input for check_tool, exactly as you would call it (date, people, area …)'),
  until: z
    .string()
    .max(120)
    .optional()
    .describe(
      'When it ends: a date "2026-12-31" (runs through that day, then turns itself off) or a condition, written in the user\'s language, like "once a cancelled ticket is grabbed" (turns off when Dool2 reports it was met). Required for watches and time-limited tasks. Empty = until deleted',
    ),
  notify: z
    .enum(['always', 'when_found'])
    .optional()
    .describe(
      'always = notify every time (default; briefings, regular reminders) · when_found = notify only when the condition is met, otherwise stay quiet (no feed or phone notification): watches like "if it goes over", "when it shows up", "when it is posted"',
    ),
  tell_at: z
    .string()
    .optional()
    .describe(
      'Korea time HH:MM to delay only the phone notification to. The task runs at its set time and the result goes into the chat right away, but the phone notification comes at this time (e.g. "do it while I sleep and tell me in the morning" → once at 3 AM + tell_at "07:00"). In goal_update, "" clears it',
    ),
}

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
        'Creates one when the user describes something Dool2 should do on its own at set times (reminders, morning briefings, weekly summaries, watching prices or cancelled tickets) or a long-term goal (exercise, saving, studying). ' +
        'Reminders are made with this too. Examples: "remind me to call the dentist at 10 tomorrow" → once · "remind me about the heartworm pill on the 1st of every month" → monthly day 1 (do not run daily and check the date) · ' +
        '"check my card bill on the last day of each month" → monthly day 31 · "Mon, Wed, Fri at 7" → weekly days [1,3,5] · ' +
        '"tell me when a cancelled ticket shows up" → every + notify "when_found" + until (show or departure date), with check_tool + check_input when a service lookup tool can see it (then every 1-5 minutes is fine) · "warn me if my shopping this month goes over 300,000 won" → daily + notify "when_found" + until the last day of that month · ' +
        '"every day until December 31" → until "2026-12-31" · ' +
        '"tell me when the engine oil is due next" → write the last change date in prompt, monthly + when_found (when it is due) + until "when the user says it was changed" · ' +
        '"tell me when the notice with no date yet is posted" → daily + when_found + until "when the notice is posted and reported". ' +
        'For goals give category and plan (3-6 steps) together, and the check-in time as schedule. ' +
        'Before creating a watch, look up what is there now and show it in the answer: for news or posts a list (show_list, with the original link on each row; if there is little from today, widen to this week); for recruitments or conditions one or two lines on the current situation (when the last round was, expected announcements, whether the user qualifies based on my info) with source links. Never end with just "there was nothing". Places the user asked to watch as well (e.g. district office notices) go into the watch prompt without asking. ' +
        'Tell the user the schedule the result reports (when it runs, when it ends, when it notifies) as is, to confirm. If the result says something is missing, ask the user or fill it with goal_update. If the time is already past, do not create it; ask for another time. ' +
        "Write title, prompt, plan and until conditions in the user's language.",
      inputSchema: {
        title: z
          .string()
          .max(60)
          .describe(
            'Short name (e.g. "Morning briefing", "Monthly phone bill check", "Exercise 3 times a week")',
          ),
        prompt: z
          .string()
          .max(1000)
          .describe(
            'What Dool2 should do at that time, written as a request to Dool2 (e.g. "Briefly sum up today\'s weather, my schedule and incoming parcels", "Check this month\'s shopping total on Coupang and Naver and tell me if it is over 300,000 won"). Conditions go here',
          ),
        ...whenFields,
        category: z
          .enum(GOAL_CATEGORIES)
          .optional()
          .describe(
            'Only for long-term goals. Values in order mean: health, relationships, money, work, interests, productivity, other',
          ),
        plan: z.array(z.string().max(120)).max(12).optional().describe('Plan steps for the goal'),
        target: z
          .enum(['chat', 'feed'])
          .optional()
          .describe('Whether to say the result in the chat (default) or post it to the feed'),
        preview: z
          .boolean()
          .optional()
          .describe(
            'Whether to run it once right now after creating it. true for tasks where the shape of the result matters, like briefings, summaries and digests (the user checks it right away instead of waiting for the first run). Omit for simple reminders and watches',
          ),
      },
    },
    call('goal_create'),
  )
  server.registerTool(
    'goal_list',
    {
      title: 'View goals and schedules',
      description:
        'Shows the goals and scheduled tasks, their next run times and past results. Use for "what reminders did I set?". Also check with this that a schedule still exists before saying it "already exists" or relying on it (the user may have deleted it on screen).',
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
        "Rewrites a goal's plan steps (plan), marks finished steps (done: step numbers, from 0), or records progress (log). " +
        'Also changes a reminder\'s or watch\'s task (prompt), when (schedule and its fields; to change only the time, give just time and the rest stays), end (until; empty string "" clears it) and notifying (notify). When the goal_create result says something is missing, fill it with this. ' +
        'When the user says the end condition was met (e.g. "I changed the engine oil"), delete it with goal_delete.',
      inputSchema: {
        id: z.string().max(40).describe('id from goal_list (the first 8 characters work too)'),
        title: z.string().max(60).optional(),
        prompt: z.string().max(1000).optional().describe('When rewriting what Dool2 should do at that time'),
        ...whenFields,
        plan: z.array(z.string().max(120)).max(12).optional(),
        done: z.array(z.number().int().min(0)).optional(),
        log: z
          .string()
          .max(300)
          .optional()
          .describe("One or two sentences on progress learned in this check-in, in the user's language"),
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
        'Saves results the user may reuse to the Library: organized notes and comparison tables (note), links found (link), products (product, with price), places (place). ' +
        'Use after comparing several products, making a schedule or list, or when the user says "save this". Write title and body in the user\'s language.',
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
        'Looks up what the user saved in the Library. When the user mentions saved things ("show me the ○○ I saved", "what\'s in my Library", "the ones I bookmarked", "what I saved earlier or last time"), ' +
        'search with this first instead of guessing or saying you cannot see it. ' +
        "Returns the same fields the user sees in the app's Library (kind, title, note, link, price, date saved). For things seen in chat, use conversation_search.",
      inputSchema: {
        query: z
          .string()
          .max(100)
          .optional()
          .describe(
            '1-3 words to search, in the language the items were saved in (e.g. "Seongsu", "tangerines", "Busan trip"). Searches titles, notes and links. Empty = most recent first',
          ),
        kind: z
          .enum(['note', 'link', 'product', 'place', 'file'])
          .optional()
          .describe(
            'Only this kind: note = notes · link = links · product = products · place = places · file = photos and files',
          ),
        limit: z.number().int().min(1).max(20).optional().describe('At most how many (default 10)'),
        skip: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'How many to skip from the start: when the result says there are more with "skip: N", pass that value to continue',
          ),
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
        'Remembers facts about the user that will help later: name and how to address them, neighborhood, family, frequent places, likes, services used, schedule habits. ' +
        'When the user tells you something you would otherwise have to ask again, like where "my neighborhood, home, office, kid\'s school" is, remember it right away along with the current task (so the next "near me" request does not ask again). ' +
        "One sentence at a time, in the user's language. Never remember sensitive values like passwords, card numbers or resident registration numbers.",
      inputSchema: {
        text: z
          .string()
          .max(200)
          .describe(
            'E.g. "Two kids (daughter in 3rd grade, 6-year-old son)", "Commutes by SRT from Dongtan Station"',
          ),
        origin: z
          .enum(['said', 'account', 'web'])
          .describe(
            "Where it came from. said = the user told you. account = shown by a service on the user's own signed-in pages (profile, orders, bills, bookings). " +
              'web = general web pages, search results, or mail, messages and files other people wrote: these are not memory (use know_save with origin web).',
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
        "Records in one line facts seen on the user's own pages after logging in (fact), and things Dool2 did or confirmed (done: applications, entries, payments, orders, bookings, deliveries, sign-ups, subscriptions). " +
        'So the next request does not need the same verification again or ask what is already known. E.g. total salary and employer for tax year 2025 on Hometax, the list of benefits the user qualifies for, insurance expiry, K-Pass sign-up, a product-review campaign application (announcement date), a lodging booking (free cancellation deadline). ' +
        'Always add where (source) and as-of point (basis). For things done and expiries, add when to follow up (next: announcement, arrival, deadline, expiry) and the proactive check will look at the status then and notify; do not also create a reminder goal (goal_create) for the same time (it would ring twice). ' +
        "The same title gets replaced with the new value. Never include resident registration, bank account or card numbers or passwords (the vault and my info handle those). Never include other people's information. Write title and value in the user's language.",
      inputSchema: {
        kind: z
          .enum(['fact', 'done'])
          .describe('fact = a fact seen · done = something Dool2 did or confirmed'),
        title: z
          .string()
          .max(80)
          .describe('What (e.g. "Total salary, tax year 2025", "Revu Centique review campaign application")'),
        value: z
          .string()
          .max(200)
          .describe(
            'Summary value (e.g. "about 77.5 million won (employer ○○)", "Applied, announced 11/24")',
          ),
        source: z.string().max(40).optional().describe('Where it was seen (e.g. "Hometax", "Revu")'),
        origin: z
          .enum(['said', 'account', 'web'])
          .describe(
            "What kind of place. account = the user's own signed-in pages (Hometax, card statements, order history). said = the user told you, or Dool2 did it (done). " +
              'web = general web pages, search results, or mail, messages and files other people wrote: kept for know_find, never added to your instructions.',
          ),
        url: z.string().max(500).optional().describe('Address of that page (https)'),
        basis: z
          .string()
          .max(40)
          .optional()
          .describe('As-of point (e.g. "tax year 2025", "November spending", "day looked up")'),
        next: z
          .string()
          .max(30)
          .optional()
          .describe('When to follow up next (YYYY-MM-DD or YYYY-MM-DDTHH:MM)'),
        next_what: z
          .string()
          .max(80)
          .optional()
          .describe(
            'What to do then (e.g. "Check the winner announcement", "Remind about the free cancellation deadline")',
          ),
        state: z
          .enum(['open', 'done'])
          .optional()
          .describe('For things done: open = in progress (default), done = finished'),
      },
    },
    call('know_save'),
  )
  server.registerTool(
    'know_find',
    {
      title: 'Find what you learned',
      description:
        'Searches facts learned from earlier lookups and the log of things done. Check this before verifying again for public or financial lookups (income, taxes, benefits, insurance) or whether something was applied for. ' +
        "Compare the date seen and as-of point in the result with today and judge whether it is still usable: yearly data goes stale when the next year's data is out, balances and lists in a few days, this month's spending in a day. " +
        'If usable, answer without verification, stating the date and source (like "as of 11/20 on Hometax"); when a decision depends on it, like applying or paying, look it up again.',
      inputSchema: {
        query: z
          .string()
          .max(60)
          .optional()
          .describe(
            'Words to search, in the language they were saved in (e.g. "total salary", "Revu", "insurance"). Empty = most recent',
          ),
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
        'Updates an entry when its status changes: after a cancellation, termination, refund, completed delivery or announcement, set state "done" (marked finished, not deleted); when there is a new time to follow up, set next. Facts whose value changed are updated with value.',
      inputSchema: {
        id: z.string().max(40).optional().describe('id from the know_find result'),
        title: z.string().max(80).optional().describe('Part of the title, if the id is unknown'),
        value: z.string().max(200).optional(),
        state: z.enum(['open', 'done']).optional(),
        next: z
          .string()
          .max(30)
          .optional()
          .describe('When to follow up next. Empty ("") = no more follow-ups'),
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
        "When the user's message ends with a photo marker in brackets with a file name (like [photo: filename.jpg], with the label in the user's language), view that photo. Use to read and organize receipts, screenshots and product photos.",
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
        'Use when the user says something like "connect Coupang", or when the next step of the task really needs a login (booking, ordering, viewing their own history). ' +
        'For things that work without login, like searching, comparing or checking availability, do them on that service first and show candidates; show the card once the user picks. ' +
        "Shows that service's connect card in the chat. When the user enters the ID and password on the card, the Dool2 daemon logs in for them in Chrome on the PC, " +
        'and a notification arrives in the chat when done. Never ask for or accept IDs or passwords in chat. Briefly say they can connect it in the card and end the reply; when the notification arrives, continue the task that stopped.',
      inputSchema: {
        service: z
          .string()
          .max(60)
          .describe('Connect card id or service name (e.g. "coupang", "Coupang", "KT")'),
      },
    },
    call('connect_ask'),
  )
  server.registerTool(
    'profile_view',
    {
      title: 'View my info',
      description:
        'Views the my info the user entered (name, mobile, email, date of birth, address, simple authentication app, etc.) as masked values. The date of birth shows the year, so you can check age and eligibility (youth, 65 or older, etc.). ' +
        'When the user\'s conditions matter ("am I eligible?", "can I get this?", "does this apply to me?"), check this first before asking for birth year or where they live. Ask only for missing items. To put values into fields, use browser_fill_profile.',
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
        'Views the payment methods (cards, mobile payment) the user registered in the phone settings, in order. The top one is the main payment method. ' +
        'When the cards or payment methods the user has matter ("which card gets the best deal?", "cheapest including card discounts", "how much with my card?"), ' +
        'check this first before asking which card they use. Only masked values come back, like card company, nickname and last 4 digits (no card number, expiry or CVC). ' +
        'If none is registered, it returns how to register one.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    call('pay_method_list'),
  )
  server.registerTool(
    'vault_find',
    {
      title: 'View logins saved in the vault',
      description:
        'Shows the sites with a login (ID and password) saved in the Dool2 vault. For "is the password for this site saved?", "what\'s in the vault?", ' +
        '"did I save my Coupang login?", check with this instead of guessing. Only the site, masked ID and last used date come back. Passwords never come back. ' +
        'If there is none, it returns the way to a connect card (connect_ask) or a login card.',
      inputSchema: {
        site: z
          .string()
          .max(100)
          .optional()
          .describe(
            'Service name or address to check (e.g. "Coupang", "coupang", "www.yes24.com"). For the site you were just on, its address. Empty = all saved sites',
          ),
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
        'When showing candidates to choose from, like products, lodging, restaurants or shows, attaches them below the answer as photo cards (swipe sideways; tapping opens the page; tapping the pick button sends the choice to the chat). ' +
        'Use the photo (image), address (link) and price from the service tool result as is. Never include made-up addresses or photos. 2-8 cards, in recommended order. ' +
        'Once attached, do not list the same items or table again in the answer text; say only why you picked them and how they differ, in 2-4 sentences. The cards show below the answer text, so refer to them as "the cards below". Write card text in the user\'s language. ' +
        "For an order with several to choose from (delivery menus, household goods, gifts), badge the first card as recommended (in the user's language) and say why in a line or two; when the user picks, add that one and go on to payment approval.",
      inputSchema: {
        cards: z
          .array(
            z.object({
              title: z.string().max(80).describe('Name (e.g. "Cuisinart Steam Air Fryer Oven CSO-500KR")'),
              image: z
                .string()
                .max(800)
                .optional()
                .describe('Photo address (https, the image from the tool result as is)'),
              price: z
                .string()
                .max(40)
                .optional()
                .describe('Price line (e.g. "₩350,100", "₩112,260 per night")'),
              note: z
                .string()
                .max(60)
                .optional()
                .describe('Short info (e.g. "★4.8 (1,203) · arrives tomorrow")'),
              url: z
                .string()
                .max(800)
                .optional()
                .describe('Address to open on tap (https, the link from the tool result as is)'),
              badge: z
                .string()
                .max(12)
                .optional()
                .describe('Eye-catching label (e.g. "Lowest price", "Recommended")'),
            }),
          )
          .min(1)
          .max(10),
        shape: z
          .enum(['square', 'portrait'])
          .optional()
          .describe(
            'Photo shape: portrait for movie posters, book covers and show posters; square for everything else (products, lodging, restaurants)',
          ),
      },
    },
    call('show_cards'),
  )
  // Result blocks (docs/design/system/components/ChatBlocks). One result block per answer: if called several times,
  // only the last one is attached
  const blockAction = z.object({
    label: z
      .string()
      .max(16)
      .describe(
        'Button label, as a verb, in the user\'s language (e.g. "Add to calendar", "Add to cart", "View booking")',
      ),
    ask: z
      .string()
      .max(300)
      .optional()
      .describe(
        'Request sent to Dool2 in the user\'s words when tapped (e.g. "Add these 3 events to my calendar")',
      ),
    url: z
      .string()
      .max(800)
      .optional()
      .describe('Address to open instead of ask (https, as in the tool result)'),
  })
  server.registerTool(
    'show_list',
    {
      title: 'Attach list rows to the answer',
      description:
        'Attaches a list as rows below the answer when photos are not the reason to choose (listings, orders, emails, events, deadlines, documents, announcements, application history). ' +
        'When photos are the reason to choose (products, lodging, restaurants, posters), use show_cards. When each row\'s status matters, like open now or seats left, use this list (state, tone). Use it instead of writing out lists longer than 2 lines. The list shows below the answer text, so refer to it as "the list below". ' +
        'Choose the look with the leading item (lead): date = date (events, deadlines; date field required) · file = file (received documents, created files) · img = small photo · logo = service logo · none. ' +
        'With pick: one, tapping a row sends that choice to the chat (pick one). When the user must pick one candidate whose rows have details (show times, free slots, listings, branches, plans), use pick: one whatever the count, instead of a text list, table or quick replies, and add no quick replies: time in title, seats left and terms in sub, price in value, sold out as state with tone stop. Also use it for picks among more than 5 (all banks, card companies or airlines). ' +
        'pick: multi is for choosing several at once (adding groceries to a cart, gift candidates, documents to get): leave on empty for items Dool2 picked (checked by default), set on: false for uncertain ones and give the reason in sub. ' +
        'If every row has amount (won), the button shows the total, like "Add 3 · ₩25,860". The button (action) is one action for the whole list (e.g. "Add to calendar"). ' +
        'Money, contacting people and deleting are never done directly by the button: tapping sends a request, and approval is asked then. Never include made-up values. ' +
        "Once attached, do not repeat the same list in the answer text; give only the reasons and next steps in 2-4 sentences. Write all row text in the user's language. " +
        'Benefits, events, support programs and notices: name in title, agency and who can join in sub, whether the user qualifies in state ("eligible", "not eligible" or "needs checking", in the reply language; tone done, stop or wait), deadline in date (lead: date) and the official page in url.',
      inputSchema: {
        title: z
          .string()
          .max(40)
          .optional()
          .describe(
            'Header line (e.g. "Gongdeok Elementary · 2026 school year", "Kurly · arrives before 7 AM tomorrow")',
          ),
        from: z
          .string()
          .max(24)
          .optional()
          .describe('Small text at the right of the header: source or count (e.g. "46 items", "Hometax")'),
        lead: z.enum(['img', 'date', 'file', 'logo', 'none']).optional(),
        pick: z.enum(['one', 'multi']).optional(),
        rows: z
          .array(
            z.object({
              title: z.string().max(60),
              sub: z
                .string()
                .max(60)
                .optional()
                .describe('Small line (e.g. "21 min ago · in-person deal in Mapo", "2 items · 1 last year")'),
              value: z
                .string()
                .max(20)
                .optional()
                .describe('Bold value on the right (e.g. "₩30,000", "₩15,960")'),
              valueNote: z
                .string()
                .max(24)
                .optional()
                .describe('Small text under the value (e.g. "₩7,980 × 2")'),
              state: z
                .string()
                .max(12)
                .optional()
                .describe('Status text on the right (e.g. "Received", "Shipping", "around 1/15")'),
              tone: z
                .enum(['done', 'wait', 'stop'])
                .optional()
                .describe('Status color: done = finished · wait = waiting or deadline · stop = stopped'),
              image: z.string().max(800).optional().describe('Small photo (https, as in the tool result)'),
              date: z.string().max(10).optional().describe('YYYY-MM-DD (when lead is date)'),
              file: z.string().max(5).optional().describe('File type (e.g. "PDF")'),
              url: z.string().max(800).optional().describe('Address to open when the row is tapped (https)'),
              on: z.boolean().optional().describe('pick multi: false leaves it unchecked'),
              amount: z
                .number()
                .optional()
                .describe('pick multi: amount for the total (won, quantity already multiplied)'),
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
        'Attaches a result whose answer is a single value as one card below the answer: proof of completion (booking, order or application done, with its number), totals (card bill, charges, refund), ' +
        'delivery, application or review stages, deadlines. The big value (big) is one when or how much. Info lines (facts) 3-6; numbers use code. ' +
        'Stages (steps) are stage names and the current stage number (from 0). With a deadline (due), a D-day countdown shows in yellow. ' +
        'For completed tasks (done), include only values confirmed by reading the completion screen again; never make up numbers or amounts. Up to 2 buttons (the last is the main one). ' +
        "Once attached, do not repeat the same values in the answer text; just one or two sentences. Write card text in the user's language.",
      inputSchema: {
        title: z
          .string()
          .max(40)
          .optional()
          .describe(
            'Header line (e.g. "Booking confirmed", "Coupang · folding stroller", "Shinhan Card · December bill")',
          ),
        from: z
          .string()
          .max(24)
          .optional()
          .describe('Source at the right of the header (e.g. "CatchTable", "CJ Logistics")'),
        done: z.boolean().optional().describe('true for a completed task (check mark in the header)'),
        big: z
          .string()
          .max(40)
          .describe('One big value (e.g. "11/21 (Sat) 19:00", "₩1,284,300", "today 14:00-16:00")'),
        bigNote: z
          .string()
          .max(24)
          .optional()
          .describe('Small text next to the big value (e.g. "4 people · private room", "expected arrival")'),
        facts: z
          .array(
            z.object({
              label: z.string().max(14),
              value: z.string().max(40),
              code: z.boolean().optional().describe('true for numbers (monospace font)'),
            }),
          )
          .max(6)
          .optional(),
        steps: z
          .object({
            names: z
              .array(z.string().max(10))
              .min(2)
              .max(6)
              .describe('E.g. ["Ordered","Shipped","In transit","Delivered"]'),
            now: z.number().int().min(0).describe('Current stage number (from 0)'),
          })
          .optional(),
        due: z.string().max(10).optional().describe('Deadline YYYY-MM-DD'),
        dueLabel: z.string().max(8).optional().describe('Deadline tag word (e.g. "Payment", "Deadline")'),
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
        'Attaches text that will be used word for word (text message, KakaoTalk, email, civil petition, review, post) below the answer. The user taps copy or send. ' +
        'Tapping send puts a request to send the draft exactly as written into the chat, and approval is asked right before sending then (this tool does not send). ' +
        'Do not include facts the user did not say; leave blanks like [date]. Once attached, do not repeat the text in the answer; just one or two sentences. ' +
        'Reviews: write naturally in 3 to 5 sentences (about 150 Korean characters) with the product name, features and when it is used. Give 5 stars, and fill required questions like thickness, size or taste with a neutral answer (average, just right, satisfied) without asking the user.',
      inputSchema: {
        to: z
          .string()
          .max(30)
          .optional()
          .describe('Recipient (e.g. "Landlord Mr. Kim", "OO district office petition desk")'),
        via: z
          .enum(['sms', 'kakao', 'mail', 'post', 'other'])
          .describe('How it is sent: text message, KakaoTalk, email, posting (petition, review), other'),
        subject: z.string().max(80).optional().describe('Email subject (when via is mail)'),
        text: z.string().max(2000).describe('The text to send, exactly as it will be sent'),
      },
    },
    call('show_draft'),
  )
  server.registerTool(
    'phone_sms',
    {
      title: 'Send a text (from my phone number)',
      description:
        'Sends a text message (SMS) from the user\'s phone number. Use for "text Mom that I\'ll be late", or when send was tapped on show_draft (via: sms). ' +
        'An approval card appears on the phone; when the user approves after seeing the recipient and text, the phone app sends it itself (no other app is opened). ' +
        'Pass the recipient as the contact name as is and the phone finds the number in contacts: even if you do not know the number, do not ask; call with the name. ' +
        'After calling, say in one sentence to check the phone and end the reply. The result (sent, or why it failed) arrives afterwards. ' +
        'KakaoTalk messages go through kakao_send, not this tool.',
      inputSchema: {
        to: z
          .string()
          .max(40)
          .describe(
            "Recipient: contact name exactly as saved (e.g. Mom, Minsu Kim, Team Lead Kim, in the user's language) or phone number (010-1234-5678). For several people, call once per person",
          ),
        text: z
          .string()
          .max(1000)
          .describe('The text to send, exactly (never include facts the user did not say)'),
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
        'Like a secretary, tells the user something worth knowing now that they did not ask about. It goes to the top of the feed and a phone notification is sent too. ' +
        'Only new things confirmed directly on connected services (deliveries and expected arrivals, upcoming bookings and events, emails needing a reply, records or result announcements, upcoming payments or expiries, remembered anniversaries, etc.). ' +
        'Never post guesses, ads or general knowledge. The same item is not posted again if key is the same. Up to 3 per check. ' +
        "If Dool2 can follow up with something, put in ask the request sent when the user taps the do-it button (paying and sending are never done here; only suggested via ask). Write it in the user's language.",
      inputSchema: {
        title: z
          .string()
          .min(1)
          .max(80)
          .describe(
            'One-line notice in Dool2\'s voice (e.g. "The running shoes you ordered yesterday arrive tomorrow morning")',
          ),
        body: z
          .string()
          .max(600)
          .optional()
          .describe('One or two more sentences (e.g. "They will leave it at the door")'),
        from: z
          .string()
          .max(60)
          .optional()
          .describe('Where you learned it (e.g. "From your Coupang order history")'),
        key: z
          .string()
          .min(1)
          .max(120)
          .describe(
            'Key so the same item is not announced again: service-target-status (e.g. "coupang-order12345-arriving")',
          ),
        ask: z
          .string()
          .max(300)
          .optional()
          .describe(
            'Request sent to Dool2 when the do-it button is tapped (e.g. "Pick a birthday gift for Mom around 30,000 won"). Empty if it is only a notice',
          ),
        ask_label: z.string().max(12).optional().describe('Label of the do-it button (e.g. "Pick one")'),
      },
    },
    call('feed_tell'),
  )
  server.registerTool(
    'feed_find',
    {
      title: 'View the feed and what Dool2 did',
      description:
        'Views what is in the feed (tasks Dool2 finished, results of scheduled runs, morning news, things saved to the Library, proactive heads-ups) exactly as the user sees it in the feed. ' +
        'For things like "what did Dool2 do this week?", "what was the result of the reminder I set yesterday?", "the parcel you told me about last time", check with this first instead of guessing. ' +
        'Counts per kind within the period come with it. Items are kept up to 90 days; many items come in pages (continue with before). For things said in chat, use conversation_search.',
      inputSchema: {
        query: z
          .string()
          .max(100)
          .optional()
          .describe(
            '1-3 words to search, in the language the items are written in (e.g. "parcel", "dentist"). Searches title, text and source. Empty = most recent first',
          ),
        kinds: z
          .array(z.enum(['done', 'routine', 'post', 'saved', 'goal', 'connected', 'suggest']))
          .optional()
          .describe(
            'Only these kinds: done = finished tasks · routine = scheduled run results · post = news · saved = Library · goal = goals · connected = connections · suggest = proactive heads-ups',
          ),
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe('Only the last N days (e.g. this week 7, this month 30). Empty = all 90 days kept'),
        before: z
          .string()
          .max(80)
          .optional()
          .describe(
            'Continue: the "before: …" value from the previous result, as is (with the same filters)',
          ),
        limit: z.number().int().min(1).max(30).optional().describe('How many per call (default 15)'),
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
        'Searches earlier conversations with the user. When the user brings up something said before ("what was that vacuum we looked at last week?", "the restaurant you mentioned then") ' +
        'and it is not in your current memory (summary of earlier chat, recent messages), search with this first instead of guessing. ' +
        'Short excerpts come back with the date (Korea time) and who said it. If nothing matches, try once more with different words.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(100)
          .describe(
            '1-3 key words, in the language the conversation was in (e.g. "vacuum", "Busan SRT", "gukbap place"). Key words, not sentences',
          ),
        limit: z.number().int().min(1).max(20).optional().describe('At most how many (default 10)'),
      },
      annotations: { readOnlyHint: true },
    },
    call('conversation_search'),
  )
}
