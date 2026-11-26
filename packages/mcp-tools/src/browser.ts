// Browser tools. The AI does web work in the Dool2 tabs of the user's Chrome.
// This server makes no decisions: it forwards to the Dool2 daemon (/api/tools/browser), and the daemon blocks risky actions.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
}

/** Asks the daemon to run a tool */
export type BrowserClient = (tool: string, args: Record<string, unknown>) => Promise<ToolResult>

/** The daemon passes its address and token in environment variables when it starts this server */
export function daemonClient(env: NodeJS.ProcessEnv = process.env, kind = 'browser'): BrowserClient {
  return async (tool, args) => {
    const api = env.DOOL2_API
    const token = env.DOOL2_TOOL_TOKEN
    if (!api || !token) return fail('Not connected to the Dool2 daemon')
    try {
      const res = await fetch(`${api}/api/tools/${kind}/${encodeURIComponent(tool)}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          // Which chat (segment) this server works for, so approvals and phone cards go back to it (ADR 0038)
          ...(env.DOOL2_TOOLSET ? { 'x-dool2-toolset': env.DOOL2_TOOLSET } : {}),
        },
        body: JSON.stringify(args),
        // Waiting for an authentication app approval waits up to 3 minutes (a 90 s cutoff timed out while the user was approving)
        signal: AbortSignal.timeout(tool === 'wait_auth' ? 200_000 : 90_000),
      })
      if (!res.ok) return fail(`The Dool2 daemon refused the request (${res.status})`)
      return (await res.json()) as ToolResult
    } catch (e) {
      return fail(`Could not reach the Dool2 daemon: ${(e as Error).message}`)
    }
  }
}

/** Where a value can be looked up before asking the person (browser_request_profile's looked) */
export const LOOKED = [
  'profile_view',
  'vault_find',
  'conversation_search',
  'know_find',
  'mail',
  'connected_services',
  'task_spec',
] as const

const fail = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] })

const tabId = z.number().int().describe('Tab number (the tab N reported by browser_open)')
const ref = z
  .string()
  .regex(/^e\d+$/)
  .describe('Element ref shown when the page was read (e.g. e12)')

export function registerBrowserTools(server: McpServer, client: BrowserClient) {
  const tool = (
    name: string,
    title: string,
    description: string,
    // biome-ignore lint/suspicious/noExplicitAny: zod input shape of the MCP SDK
    inputSchema: Record<string, any>,
    readOnly: boolean,
  ) =>
    server.registerTool(
      `browser_${name}`,
      { title, description, inputSchema, annotations: { readOnlyHint: readOnly, openWorldHint: true } },
      async (args: Record<string, unknown>) => {
        const r = await client(name, args)
        return { content: r.content, ...(r.isError ? { isError: true } : {}) }
      },
    )

  tool(
    'open',
    'Open new tab',
    "Opens a new tab in the Dool2 window of the user's Chrome (their logins apply) and returns the page as text. Start web work here; without a page's exact address, open the site's home page and use its menu or search. Cite what you read as a link ([site](page address)).",
    { url: z.string().describe('Address to open (e.g. https://www.naver.com)') },
    true,
  )
  tool(
    'navigate',
    'Go to address',
    'Goes to another address in an already open Dool2 tab and returns the page read as text.',
    { tabId, url: z.string() },
    true,
  )
  tool(
    'read',
    'Read page',
    `Reads the tab's page as text; clickable things are marked like [e12 button "Search"]. Long pages: from starts at a line containing that text, view: true reads only what is on screen, skip continues after a cut. When you use it in the answer, link the source: the article or post itself (not a list page), an agency's own page for its programs; none for the user's own account pages. E.g. {tabId: 3, from: "Search results"}`,
    {
      tabId,
      maxChars: z.number().int().min(1).max(40000).optional(),
      view: z.boolean().optional(),
      from: z.string().max(100).optional().describe('Text as written on the page, e.g. a heading'),
      skip: z.number().int().min(0).optional().describe('The skip value a cut-off result gave'),
    },
    true,
  )
  tool(
    'click',
    'Click',
    "Clicks a marked (ref) button or link with a real mouse and returns what changed. Without a ref, put the on-screen text exactly in text. Pay, order, send and delete buttons are stopped by Dool2 and sent to an approval card (browser_checkout, browser_request_approval); inside an approved payment's window they are not stopped again.",
    {
      tabId,
      ref: ref.optional(),
      text: z.string().max(80).optional().describe('No ref: the on-screen text, exactly'),
      opens_checkout: z
        .boolean()
        .optional()
        .describe(
          'true if it only moves on to the payment screen ([Order] in a cart); approval comes once, at the last pay button',
        ),
      final: z
        .boolean()
        .optional()
        .describe(
          'true if it spends money, sends, deletes or confirms, whatever its label (goes to approval)',
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          'true after it stopped (text changed or covered) and you checked it is still the right element',
        ),
    },
    false,
  )
  tool(
    'type',
    'Type',
    'Types into a marked (ref) input, replacing what was there; submit: true presses Enter. Works in post editors too (title and body boxes; line breaks become paragraphs). Not for password fields. Never ask the user to copy and paste: if it is not visible, look and try again.',
    { tabId, ref, text: z.string().max(20000), submit: z.boolean().optional() },
    false,
  )
  tool(
    'press',
    'Press key',
    'Presses keys like Enter, Tab, Escape, ArrowDown, PageDown.',
    { tabId, key: z.string().max(20) },
    false,
  )
  tool(
    'hover',
    'Hover',
    'Only moves the mouse over a marked (ref) spot and returns the changed page. Use to see menus (categories, etc.) or tooltips that open on hover.',
    { tabId, ref },
    true,
  )
  tool(
    'steps',
    'Several actions at once',
    'Does several actions on the screen you read in order (fill fields, pick then click), then reads the page once. It stops at a new screen, tab, dialog or block and skips the rest. Pay, order, send and delete are stopped as in browser_click. E.g. steps: [{do:"type",ref:"e5",text:"Busan"},{do:"click",ref:"e9"}]',
    {
      tabId,
      steps: z
        .array(
          z.object({
            do: z.enum(['click', 'type', 'press', 'hover', 'scroll', 'wait']),
            ref: ref.optional(),
            text: z
              .string()
              .max(20000)
              .optional()
              .describe('type: the text · click without ref: on-screen text'),
            submit: z.boolean().optional(),
            key: z.string().max(20).optional().describe('press: Enter, Tab, Escape …'),
            direction: z.enum(['up', 'down']).optional(),
            ms: z.number().int().min(0).max(5000).optional().describe('wait: ms'),
          }),
        )
        .min(1)
        .max(12),
      maxChars: z.number().int().min(1).max(40000).optional(),
    },
    false,
  )
  tool(
    'route',
    'Take a remembered route',
    "Goes to a page by a route Dool2 took on this site before (opening the site lists them as [r3]): Dool2 presses the same links and types into the same fields itself at a person's pace and returns the last page. A route that types (it lists its inputs, e.g. a search box) takes this request's words in inputs. If a link or field is gone it stops there; carry on yourself. Gated as in browser_click.",
    {
      tabId,
      route: z
        .string()
        .regex(/^r\d+$/)
        .describe('E.g. r3'),
      inputs: z
        .array(z.string().max(100))
        .max(4)
        .optional()
        .describe(
          'What to type this time, in the order of the route\'s inputs (e.g. ["wool coat"] for a search box)',
        ),
    },
    false,
  )
  tool(
    'select',
    'Pick from a list',
    'Reads or picks from a dropdown or option list (size, color, select boxes). Without choose it lists the options with sold-out marks; with choose it picks that text. Pick what the user said, else a size or color from memory, else ask once with the options that are not sold out; never a sold-out one. Say a size the user gave in your answer so it is remembered. Not for payment methods (approval card choices).',
    {
      tabId,
      ref: ref.describe('The list field'),
      choose: z.string().max(60).optional().describe('Option text as on the page. Empty = only list them'),
    },
    false,
  )
  tool(
    'upload',
    'Upload PC files',
    "Attaches PC files to a web page (blog photos, videos, documents for petitions or claims). Find them with file_find and pass the paths as given (a photo sent in chat: its name.jpg). ref is the page's upload button or file field; don't click it yourself. The first time, an approval card (files, site) goes to the phone and the turn waits; Dool2 attaches them after approval. Read the page afterwards to confirm, then go on.",
    {
      tabId,
      ref: ref.describe('The upload button or file field'),
      paths: z.array(z.string().max(500)).min(1).max(20).describe('Paths as file_find gave them'),
      what: z.string().max(120).optional().describe('One line for the approval card'),
    },
    false,
  )
  tool(
    'scroll',
    'Scroll',
    'Scrolls one screen and returns what is visible now. browser_read reads the whole page already; use this only to follow what is on screen.',
    {
      tabId,
      direction: z.enum(['up', 'down']),
      ref: ref.optional().describe('Scroll this pane. Empty = the page'),
    },
    true,
  )
  tool(
    'screenshot',
    'Screenshot',
    'Views the visible part of the tab as an image. Use only when reading text cannot tell you (pictures, maps, table layout).',
    { tabId },
    true,
  )
  tool(
    'save_pdf',
    'Save the page as a PDF',
    'Keeps the page as a PDF file the way Chrome prints it, without a print window or a printer: certificates, statements, receipts and tickets that open in a viewer. Point it at the tab that shows the document (a viewer often opens its own tab or pop-up: browser_tabs). It goes to the Doori folder in Documents and the library. Never ask the user to print or save it on the PC.',
    {
      tabId,
      name: z
        .string()
        .max(80)
        .optional()
        .describe("File name without .pdf, in the user's language (what it is and the date)"),
    },
    true,
  )
  tool('back', 'Back', 'Presses back in the tab and returns the page read as text.', { tabId }, true)
  tool(
    'wait',
    'Wait for a change',
    'Waits until the screen changes (default 3 s, at most 10 s) and reports what changed (text, address, new tab, blocked popup, site alert), when a payment window or a result appears late.',
    { tabId, ms: z.number().int().min(100).max(10_000).optional() },
    true,
  )
  tool(
    'tabs',
    'Dool2 tab list',
    'Lists the Dool2 tabs (number, title, address, which opened which, popups, blocked or recently closed windows), when a payment or login window appeared late or a tab disappeared.',
    { tabId: tabId.optional().describe('To see only new windows blocked in this tab') },
    true,
  )
  tool(
    'login',
    'Fill login from the Dool2 vault',
    'Fills the ID and password from the Dool2 vault on a login screen (you never see them), then press the login button with browser_click. If the screen then says it failed, call again with failed: true so new values are collected. If the vault has none, first try the simple login the user used on that site (Kakao, Naver, Google already signed in), then browser_request_login.',
    {
      tabId,
      passwordRef: ref.optional(),
      usernameRef: ref.optional().describe('Omit if the ID is already filled'),
      failed: z.boolean().optional(),
      reason: z.string().max(80).optional().describe('With failed: what the screen said'),
    },
    false,
  )
  tool(
    'request_login',
    'Show login card',
    "Shows a login card on the phone when the site is not in the vault. The ID and password go only to the vault. The result says what is left on the card, and the turn waits. The card has find-account and sign-up buttons, so don't ask about those, and never sign up on your own.",
    {
      tabId,
      site: z.string().max(60).describe('Site name as the user knows it'),
    },
    false,
  )
  tool(
    'fill_profile',
    'Fill booker/buyer fields from my info',
    "Fills booker and buyer fields (name, English name, email, mobile, birth date, address, passport, car number, resident number back digits) from the user's saved info; you point at fields and never see values. Use it instead of asking. A missing item: browser_request_profile. In a simple authentication window, fill name, birth date and mobile, pick the app the result names, request it, then browser_wait_auth.",
    {
      tabId,
      fields: z
        .array(
          z.object({
            ref,
            key: z
              .enum([
                'name',
                'name_en_last',
                'name_en_first',
                'name_en_full',
                'email',
                'phone',
                'phone_digits',
                'phone_local',
                'phone_rest',
                'phone_head',
                'phone_mid',
                'phone_last',
                'rrn_back',
                'birth',
                'birth_digits',
                'birth6',
                'zip',
                'address',
                'address_detail',
                'passport_no',
                'passport_issued',
                'passport_expiry',
                'sex',
                'birth_city',
                'car_no',
              ])
              .describe(
                'The item that fits the field shape: phone_local after a country picker, phone_rest after a 010 picker, phone_head/mid/last when split in three, birth6 for 6 digits; rrn_back comes from the phone keypad if not saved',
              ),
          }),
        )
        .min(1)
        .max(20),
    },
    false,
  )
  tool(
    'wait_auth',
    'Wait for authentication app approval',
    'Use after sending a simple authentication request (KakaoTalk, Naver, Toss, PASS). Public records that need the user\'s own data and logins on public sites go this way before asking the user anything: fill with browser_fill_profile, request it, then this. Right before, write one line on what to approve where. The phone gets a card; Dool2 watches the screen up to 3 minutes while the turn waits; don\'t click meanwhile. The changed screen comes back as a new message; judge it and press [OK] if there is one. E.g. {tabId: 2, ref: "e40"}',
    {
      tabId,
      ref: ref.optional().describe('[OK] button to press once the user taps the card'),
      message: z.string().max(200).optional().describe('Phone notification text'),
    },
    false,
  )
  tool(
    'request_code',
    'Get a value on the phone and fill it in (verification code, resident number back digits, CAPTCHA)',
    'Gets a value only the person has (a verification code, resident number back digits, a payment password, CAPTCHA text) on a phone card and types it straight into the field; you never see it, and never ask for it in chat. Press what Dool2 can (pop-ups, choosing a method) first. pin and captcha take two calls (see their fields). The turn waits for the card; when the value is in, press [OK] and go on.',
    {
      tabId,
      ref: ref.optional().describe('The input (not for an image keypad)'),
      label: z.string().max(40).optional().describe('Field name on the card'),
      kind: z
        .enum(['code', 'rrn_back', 'captcha', 'pin', 'text'])
        .optional()
        .describe(
          'code (default, digits) · rrn_back (saved to the vault) · captcha (text robot check) · pin (payment keypad) · text (words only the person knows that a form asks for, such as a family member\'s name or the registration place; any letters; the label says what is asked, e.g. "father\'s name")',
        ),
      keys: z
        .record(z.string(), z.string())
        .optional()
        .describe('pin, second call: digit → button ref, from the cropped images'),
      key_refs: z.array(ref).max(16).optional().describe('pin, first call: all keypad button refs'),
      box: z
        .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
        .optional()
        .describe(
          'pin keypad as an image: its box on the screenshot (0-1000); first box alone, then with keys_at',
        ),
      keys_at: z
        .record(z.string(), z.array(z.number()).length(2))
        .optional()
        .describe('Centers of 0-9 in the cropped image (0-1000)'),
      length: z.number().int().min(4).max(8).optional(),
      pick: z
        .number()
        .int()
        .min(1)
        .max(6)
        .optional()
        .describe('captcha, second call: the number of the clearest crop'),
    },
    false,
  )
  tool(
    'request_tap',
    'Solve a picture robot check by tapping',
    "Solves a picture robot check (tap the spot, pick the squares) through a phone card: give the picture's ref or its box on the screenshot, and the question exactly as written in say; Dool2 taps where the user tapped. Never guess the answer yourself. The turn waits for the card; when it is tapped, read the screen and press [OK] or [Submit].",
    {
      tabId,
      ref: ref.optional().describe('Ref of the robot check picture box, if the page has one (otherwise box)'),
      box: z
        .object({
          x: z.number().min(0).max(1000),
          y: z.number().min(0).max(1000),
          w: z.number().min(10).max(1000),
          h: z.number().min(10).max(1000),
        })
        .optional()
        .describe('Box on the screenshot (0-1000) around question and picture, generously'),
      say: z.string().max(80).describe('The question as written'),
      taps: z.number().int().min(1).max(9).optional().describe('Taps allowed (default 1)'),
    },
    false,
  )
  tool(
    'request_profile',
    'Show my info card',
    "Shows a card on the phone to fill a missing item of the user's info once (when browser_fill_profile says it is missing, or a car number, passport or home address is needed); values stay in the PC vault. Never ask for these in chat. Finish what works without it first and put that in the answer.",
    {
      fields: z
        .array(
          z.enum([
            'name',
            'name_en_last',
            'name_en_first',
            'email',
            'phone',
            'birth',
            'zip',
            'address',
            'address_detail',
            'auth_app',
            'carrier',
            'passport_no',
            'passport_issued',
            'passport_expiry',
            'sex',
            'birth_city',
            'car_no',
          ]),
        )
        .max(10)
        .optional()
        .describe('Items to collect. Empty = all missing items'),
      options: z
        .array(z.string().max(20))
        .max(10)
        .optional()
        .describe('auth_app: the app names as on the screen'),
      reason: z.string().max(120).optional().describe('Why it is needed, one line'),
      looked: z
        .array(z.enum(LOOKED))
        .min(1)
        .describe('Where you already looked for these values before asking (profile_view first)'),
    },
    false,
  )
  tool(
    'new_password',
    'Create a new password',
    'Use to fill the "new password" field on sign-up or password recovery/change screens. Dool2 creates a strong password that fits the field\'s length rules and types it into that field (and the confirm field). You never receive the password (the result has no value). It is saved in the vault after Dool2 sees the screen confirming the sign-up or change. If the user did not choose to sign up or change the password on that site, Dool2 asks on the phone first and types nothing (the result says what is left; the turn waits). Give the ID (email) as username, or my info email is used. Never use it for the password field of a login screen (an existing account). ' +
      "Signing up: the ID is my info email, name and phone come from browser_fill_profile, agree only to required terms. Email verification: find and read the site's email with gmail_search; phone codes: browser_request_code; robot checks: browser_request_code (kind: captcha) for text, browser_request_tap for pictures. Read the screen again after signing up (the vault saves only after the completion screen). If the email is already registered, switch to logging in. " +
      "Resetting a password (hard to undo, so only after the user chose it): open the site's password recovery screen and enter the email to send the reset email; if Gmail is connected, read the link or code in it and open it, then use this with purpose: reset. If identity verification comes up, fill the fields with browser_fill_profile and get it with browser_wait_auth (app approval) or browser_request_code (text message code). If Gmail is not connected so the email cannot be read, show the Gmail connect card with connect_ask and continue once connected.",
    {
      tabId,
      password: ref.describe('Field for the new password'),
      confirm: ref.optional().describe('Password confirm field (if any)'),
      username: z
        .string()
        .max(120)
        .optional()
        .describe('ID used for the sign-up or change. Usually an email. Empty = my info email'),
      purpose: z
        .enum(['signup', 'reset'])
        .optional()
        .describe('signup = sign up (default) · reset = password recovery or change'),
    },
    false,
  )
  tool(
    'request_approval',
    'Request approval',
    'Approval card for actions that do not spend money: send, delete, apply, cancel, return, change a plan, consent (when browser_click or browser_dialog says it needs approval). Payment goes only through browser_checkout. After approval on the phone Dool2 clicks only that button. Fields the user should pick go in choices; what Dool2 picked itself in chose. Lay out what, where, amount and cancellation terms as written. The turn waits for the phone; when approved, read the screen to confirm.',
    {
      tabId,
      ref: ref.optional().describe('The button (omit with dialog)'),
      dialog: z.boolean().optional().describe("true for [OK] in the site's open confirm dialog"),
      what: z.string().max(200).describe('E.g. "Return order: apples 1 kg"'),
      where: z.string().max(100).describe('Site or shop'),
      amount: z.string().max(60).optional().describe('As written, with currency'),
      cancel: z
        .string()
        .max(200)
        .optional()
        .describe('Cancellation or refund terms, or that there is no notice'),
      choices: z.array(ref).max(8).optional().describe('Fields the user picks on the card'),
      choiceTitle: z.string().max(20).optional(),
      chose: z
        .array(z.string().max(60))
        .max(8)
        .optional()
        .describe('What Dool2 picked itself, so the user can change it'),
      ship_to: z.string().max(120).optional().describe('Pickup or exchange address in the application'),
      ship_options: z
        .array(z.string().max(120))
        .max(5)
        .optional()
        .describe('Other addresses saved on the site'),
      count: z
        .number()
        .int()
        .min(2)
        .max(20)
        .optional()
        .describe(
          'The same action N times in a row (list all in what); one approval covers them for 10 minutes',
        ),
    },
    false,
  )
  tool(
    'checkout',
    'Payment card',
    "The only way to get a payment approved: at the last pay button of the payment screen, after setting address, method and coupons (don't stop earlier to ask; [Order] before it is browser_click with opens_checkout). Fill the fields exactly as on the screen; one card on the phone lets the user pick address and method and approve once. If the same item was found cheaper on another site earlier in this conversation, add one info line. The turn then waits for the phone. After approval finish the same payment through its window (keypad: browser_request_code kind pin), read the order number, call browser_order_done.",
    {
      tabId,
      ref: ref.describe('The last pay button'),
      title: z.string().max(60).describe('Shop or product bundle, as on the screen'),
      where: z.string().max(60).describe('Site or service'),
      total: z.string().max(60).describe('Final amount, with currency'),
      goods: z
        .array(
          z.object({
            name: z.string().max(80),
            option: z.string().max(80).optional(),
            qty: z.string().max(20).optional().describe('E.g. "2 nights"'),
            price: z.string().max(30).optional(),
            image: z.string().max(800).optional(),
          }),
        )
        .max(20),
      lines: z
        .array(
          z.object({
            label: z.string().max(24),
            value: z.string().max(30),
            kind: z.enum(['discount', 'fee', 'point']).optional(),
          }),
        )
        .max(10)
        .optional()
        .describe('Item total, fees, discounts, points'),
      info: z
        .array(z.object({ label: z.string().max(16), value: z.string().max(160) }))
        .max(8)
        .optional()
        .describe('Arrival, date of use, passengers, seats …'),
      ship_to: z.string().max(120).optional().describe('The selected delivery address'),
      ship_options: z
        .array(z.string().max(120))
        .max(5)
        .optional()
        .describe('Other saved addresses (from the change-address view)'),
      choices: z
        .array(ref)
        .max(8)
        .optional()
        .describe(
          'Payment method options (expand hidden ones; leave out ones the screen says do not work now)',
        ),
      choiceTitle: z.string().max(20).optional(),
      chose: z
        .array(z.string().max(60))
        .max(8)
        .optional()
        .describe('What Dool2 picked itself (coupon, no insurance, terms)'),
      cancel: z.string().max(200).optional().describe('As on the screen'),
      after: z
        .string()
        .max(120)
        .optional()
        .describe('What happens after approval (e.g. "The payment password goes in on your phone keypad")'),
      final_here: z
        .boolean()
        .optional()
        .describe("true when this screen's button pays directly (no separate payment screen)"),
    },
    false,
  )
  tool(
    'order_done',
    'Report order complete',
    'Reports the end of an approved payment: with order_no once you read the order (booking) number on the completion screen, or failed: true with the reason (then check whether money was taken and try another way). Dool2 releases the payment lock. Then show the result and suggest the helpful follow-ups briefly, all at once (calendar, a reminder before a free cancellation deadline, saving the confirmation).',
    {
      tabId,
      order_no: z.string().max(60).optional().describe('As on the completion screen. Required unless failed'),
      summary: z.string().max(200).optional().describe('What for how much'),
      failed: z.boolean().optional(),
      reason: z.string().max(200).optional(),
    },
    false,
  )
  tool(
    'dialog',
    'Answer a site dialog',
    "Answers a site confirm dialog the page read says is open, before anything else: [OK] (accept: true) if it matches the user's request, otherwise [Cancel]. A site alert (💬) is only information. [OK] that pays, orders, sends or deletes needs approval.",
    {
      tabId,
      accept: z.boolean(),
      text: z.string().max(500).optional().describe('For prompt dialogs'),
    },
    false,
  )
  tool(
    'handoff',
    'Hand off to the user',
    'Emergency only (emergency: true): lets the user operate the PC screen from the phone. Everything a person must do goes through phone cards instead: browser_fill_profile, browser_request_code (codes, keypads, CAPTCHA text), browser_request_tap (picture checks), browser_wait_auth, browser_request_login, browser_checkout, browser_request_approval. Use it only for a field none of those can take (a new card number when none is saved). The first call on a screen only reads it again; after that, the result says what is left and the turn waits.',
    {
      tabId,
      reason: z.string().max(200).describe('What the user should do'),
      blocker: z
        .enum(['identity_check', 'captcha', 'payment_password', 'site_blocks_automation', 'other'])
        .describe('What blocks you'),
      tried: z.string().max(200).describe('What you already tried on this screen (tools, other paths)'),
      emergency: z.boolean().optional().describe('Without it nothing is handed off'),
    },
    false,
  )
  tool(
    'close',
    'Close tab',
    "Closes a Dool2 tab that gets in the way (a duplicate). Dool2 tidies tabs itself, so don't close them at the end of a task, and never close a payment in progress before its completion screen.",
    { tabId },
    false,
  )
}
