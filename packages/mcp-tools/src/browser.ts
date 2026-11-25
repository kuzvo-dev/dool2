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
    "Opens a new tab in the Dool2 window of the user's Chrome and returns the page read as text. The user's usual logins apply. Use this first to find or do anything on the web. When answering from what you read on a page, add the source as a link ([site or screen name](that page address)) on that line or at the end of the answer.",
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
    'Reads the tab\'s current page as text. If you use it in the answer, add a source link at the end of that line ([screen name](page address)): the article or post itself, not a list page; for an agency\'s programs, grants and events its own site, press release or application page rather than an article; none for the user\'s own account pages (orders, balances). Clickable things are marked like [e12 button "Search"]. For long pages read only what you need: put text to look for in from (e.g. the page\'s "search results" heading, as written on the page) to start at that line, view: true for only what is on screen now, and if it was cut off, continue with the skip value given.',
    {
      tabId,
      maxChars: z.number().int().min(1000).max(40000).optional(),
      view: z
        .boolean()
        .optional()
        .describe('true = only the part visible on screen now (use after scrolling)'),
      from: z
        .string()
        .max(100)
        .optional()
        .describe('Start reading at the line containing this text, as written on the page (skips top menus)'),
      skip: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Skip this many characters from the start (to continue after a cut-off)'),
    },
    true,
  )
  tool(
    'click',
    'Click',
    "Clicks a marked (ref) button or link with a real mouse and returns what changed on the page (the whole page if it moved to another page). For boxes without a ref (shop or product cards in search results, etc.) put the on-screen text (shop name, etc.) exactly in text instead of ref, and that text is clicked. Buttons with words like pay, order, send or delete are blocked by Dool2 and redirected to an approval card (browser_checkout for payment, browser_request_approval for send/delete). After a payment is approved, buttons inside the payment provider's window are not blocked again.",
    {
      tabId,
      ref: ref.optional(),
      text: z
        .string()
        .max(80)
        .optional()
        .describe('When there is no ref: the on-screen text of what to click, exactly (e.g. a shop name)'),
      opens_checkout: z
        .boolean()
        .optional()
        .describe(
          'true if, from the screen, you judge this button only moves on to the payment screen (where the payment method and final amount are chosen), like [Order] in a cart or order sheet. It is clicked without approval; approval is asked only once, at the last button of the payment screen',
        ),
      final: z
        .boolean()
        .optional()
        .describe(
          'true if, from the screen, you judge this button actually spends money (or sends, deletes) or confirms something. Even if the button label has no such words, Dool2 will not click it and redirects to an approval card',
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          'true if it stopped because the surrounding text changed since reading or another element covers it, and after checking the text it reported you still judge the element is right (if covered, the element is clicked directly instead of with the mouse)',
        ),
    },
    false,
  )
  tool(
    'type',
    'Type',
    'Types text into a marked (ref) input (replacing what was there). With submit: true it also presses Enter. It cannot type into password fields. ' +
      'Title and body areas of blog or community post editors (placeholders like [input "Title"] or [input "Enter body text"]) also work: give them as ref and Dool2 clicks that spot and types (line breaks become new paragraphs, long bodies go in one call). ' +
      'Never tell the user to copy and paste because you cannot type: if the result says it is not visible on screen, look at the screen and try again.',
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
    'Does a sequence of actions on the screen you read (filling several fields, picking then clicking, etc.) in order, then reads the page once at the end. Actions are only click (ref or text), type (ref, text, submit), press (key), hover (ref), scroll (direction) and wait (ms). If it moves to another screen, a new tab or confirm dialog opens, or something blocks, it stops there and skips the rest. Buttons like pay, order, send or delete are blocked exactly as in browser_click.',
    {
      tabId,
      steps: z
        .array(
          z.object({
            do: z.enum(['click', 'type', 'press', 'hover', 'scroll', 'wait']).describe('Action'),
            ref: ref.optional().describe('click, type, hover: element ref'),
            text: z
              .string()
              .max(20000)
              .optional()
              .describe('type: text to enter / click: on-screen text to click when there is no ref'),
            submit: z.boolean().optional().describe('type: press Enter after typing'),
            key: z.string().max(20).optional().describe('press: key name (Enter, Tab, Escape …)'),
            direction: z.enum(['up', 'down']).optional().describe('scroll: direction'),
            ms: z.number().int().min(100).max(5000).optional().describe('wait: time to wait (ms)'),
          }),
        )
        .min(1)
        .max(12)
        .describe('Actions in order (up to 12)'),
      maxChars: z.number().int().min(1000).max(40000).optional(),
    },
    false,
  )
  tool(
    'route',
    'Take a remembered route',
    'Goes to a page by a route Dool2 took on this site before. Opening or moving to a site lists its routes as [r3] with the page they end on and the links pressed. Dool2 presses the same links itself, pausing like a person between them, without asking you at each click, and returns the final page. Prefer it over clicking the same menus one by one. If a link is not on the page any more, it stops there and returns that page; carry on yourself. Payment, send and delete buttons are gated exactly as in browser_click.',
    {
      tabId,
      route: z
        .string()
        .regex(/^r\d+$/)
        .describe('Route id from the list, e.g. r3'),
    },
    false,
  )
  tool(
    'select',
    'Pick from a list',
    'Reads or picks from a dropdown (product color/size options, select boxes, fields like "open options" or "please select"). Without choose it returns the list (with sold-out marks and the current pick); with choose set to an item\'s text (e.g. "M", "Black", as written on the page) it picks that and returns the changed page. Lists that scripts cannot open are opened by Dool2 with a real mouse. Never use it for payment method or installment lists (use choices on the approval card). ' +
      'Product options (color, size, volume): pick what the user said; if they did not say, use the clothing and shoe sizes and frequently picked colors in memory; only if memory has nothing, show the options that can be picked (not sold out) and ask once. When the user tells or picks a size, save it with memory_save (e.g. "clothing size M · shoes 260"). Never pick a sold-out option; say so.',
    {
      tabId,
      ref: ref.describe('Ref of the list field (e.g. e49 "open options", e51 select box "color")'),
      choose: z
        .string()
        .max(60)
        .optional()
        .describe(
          'Item text to pick (the option the user said, otherwise a remembered size or color). Empty = only view the list',
        ),
    },
    false,
  )
  tool(
    'upload',
    'Upload PC files',
    "Attaches files from the user's PC to a web page: photos in a blog post, uploading Shorts or videos, documents for civil petitions or insurance claims, changing a profile picture. " +
      'First find the files with file_find (photos: folder pictures, videos: movies, received documents: downloads or documents) and pass the paths as is in paths. For photos the user sent in chat (shown as a photo marker with name.jpg), pass that name (name.jpg) as is. ' +
      "For ref give the page's button like [Add photo], [Choose file] or [Upload video], or the file field: files go straight into the attached file field, or if there is none, into the file picker that opens when that button is clicked. Do not click that button with browser_click. " +
      "The user's files go out to that site, so the first time an approval card (file names, site) appears on the phone: ask in one or two sentences as the result says and end the reply; after approval Dool2 attaches them and tells you in the next message. The same files to the same site are not asked again for 30 minutes. " +
      'It only attaches: afterwards read the page to confirm what was uploaded (preview, file names), then continue with posting or submitting. Never make the user move files themselves.',
    {
      tabId,
      ref: ref.describe(
        'Ref of the upload button or file field (e.g. e31 button "Add photo", e40 input "Attachment")',
      ),
      paths: z
        .array(z.string().max(500))
        .min(1)
        .max(20)
        .describe(
          'File paths to upload (exactly as file_find gave them, e.g. ["~/Pictures/Jeju sea.jpg"]). Several in one call',
        ),
      what: z
        .string()
        .max(120)
        .optional()
        .describe(
          'One line for the approval card, in the user\'s language (e.g. "3 photos for the Jeju trip post on Naver Blog")',
        ),
    },
    false,
  )
  tool(
    'scroll',
    'Scroll',
    'Scrolls one screen up or down and returns what is visible on screen now. browser_read reads the whole page without scrolling, so use this only to follow what is visible on screen.',
    {
      tabId,
      direction: z.enum(['up', 'down']),
      ref: ref
        .optional()
        .describe('Scrolls this element (or the list pane or modal containing it). Empty = the page'),
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
  tool('back', 'Back', 'Presses back in the tab and returns the page read as text.', { tabId }, true)
  tool(
    'wait',
    'Wait for a change',
    'Waits until the screen changes (at most ms; default 3 s, max 10 s) and reports what changed (text or elements, frame navigation, address change, new tab, blocked popup, site alert). Use when a payment window or verification result appears late after a click. Judge whether it worked by reading with browser_read.',
    { tabId, ms: z.number().int().min(100).max(10_000).optional() },
    true,
  )
  tool(
    'tabs',
    'Dool2 tab list',
    'Shows all Dool2 tabs: tab number, title and address, which tab opened which new window, whether it is a popup, recently closed new windows, new windows Chrome blocked (popup blocker), and tabs closed during cleanup. Use when a payment or login window appeared late or a tab disappeared.',
    { tabId: tabId.optional().describe('To see only new windows blocked in this tab') },
    true,
  )
  tool(
    'login',
    'Fill login from the Dool2 vault',
    "If the site is saved in the user's Dool2 vault, Dool2 fills the ID and password fields itself. The values are never shown. After filling, click the login button with browser_click. If after clicking the screen says the login failed (e.g. a wrong-password message; you judge), call again with failed: true to report it, so new values can be collected with a card. If the vault has no entry, first try the simple login the user used on that site (a remembered method, or Kakao, Naver, Google and so on already signed in in the browser), and if that fails too, show a login card with browser_request_login. If the password is unknown or wrong, the user can choose to reset it from that card.",
    {
      tabId,
      passwordRef: ref.optional().describe('Ref of the password field (e.g. e7). Omit with failed'),
      usernameRef: ref.optional().describe('Ref of the ID field. Omit if the ID is already filled'),
      failed: z
        .boolean()
        .optional()
        .describe(
          'true when you logged in with the vault values but the screen says it failed (you judge from the screen)',
        ),
      reason: z
        .string()
        .max(80)
        .optional()
        .describe('With failed: what the screen said, as written (e.g. "The password does not match")'),
    },
    false,
  )
  tool(
    'request_login',
    'Show login card',
    "Use on a login page when the site is not in the Dool2 vault (when browser_login says it is not in the vault). Shows a login card on the user's phone. The ID and password the user enters are stored only in the vault and never come to you. After calling, say briefly that they can put their ID and password in the card and end this reply. The card also has 'Find account' and 'New here? Sign up' buttons, so do not ask about those separately, and never sign up on your own. For robot checks: picture puzzles use browser_request_tap, text ones browser_request_code (kind: captcha); authentication app approvals use browser_wait_auth; SMS verification codes use browser_request_code.",
    {
      tabId,
      site: z.string().max(60).describe('Site name shown to the user, as the user knows it (e.g. "Costco")'),
    },
    false,
  )
  tool(
    'fill_profile',
    'Fill booker/buyer fields from my info',
    'Dool2 itself fills booker and buyer fields (name, English name, email, mobile, date of birth, address, passport, car number) on payment and booking screens and in simple authentication windows with the user\'s "my info". You only point at fields; you never see the values (the result has masked values). Use this first instead of asking the user for name or contact details; if an item is missing the result says so, then show a card with browser_request_profile. ' +
      'In a simple authentication window (identity verification on Gov24, Hometax, etc. through an app such as Kakao, Naver, Toss or PASS), fill name, date of birth and mobile with this, click the authentication app from my info given in the result, click through to [request verification], then wait with browser_wait_auth (never ask about the app in chat).',
    {
      tabId,
      fields: z
        .array(
          z.object({
            ref: ref.describe('Ref of the input to fill (e.g. e12)'),
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
                "My info item that fits the field shape: separate English last/first name → name_en_last, name_en_first; one field → name_en_full; phone with a separate country code picker → phone_local; with a separate 010 picker → phone_rest (last 8 digits); split in three → phone_head, phone_mid, phone_last; digits only → phone_digits, birth_digits; 6-digit birth date → birth6; passport fields (ESTA, flights, overseas lodging) → passport_no, passport_issued, passport_expiry, sex, birth_city (if missing, browser_request_profile; never ask for a passport photo in a PC folder); car tasks (inspection, recalls, car tax, insurance) → car_no; resident number back digits → rrn_back (filled if saved, otherwise received once on the phone's secure keypad; never hand it to the user to type)",
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
    "Use after sending a simple authentication request (KakaoTalk, Naver, Toss, PASS, etc.). Public records that need the user's own data (health checkup eligibility, insurance claims, refunds, certificates) and logins on public sites go this way before asking the user anything: open the agency's site, fill the fields with browser_fill_profile, request the verification, then this; the user only approves on the phone. Right before calling, write one line in the user's language like \"I sent the verification request to KakaoTalk (the chosen app). Approve it there, then tap the done button on the card.\" (it shows in the progress card right away). It shows a notification and a card with a verified-done button on the user's phone, and Dool2 watches the screen for up to 3 minutes without holding the conversation: after calling, end this reply. Do not click anything while waiting (some sites close the verification window if you click before approval). When the screen changes (address, confirm dialog, verification window closed) or the user taps the card, the screen comes to you as a new message; judge from the screen whether it worked and continue: click a [verification complete] or [OK] button if there is one, and call again only if the screen says it is not done yet. With ref, that button is clicked once the moment the user taps the card. Do not hand off with browser_handoff and wait for the user to finish (the verification expires meanwhile).",
    {
      tabId,
      ref: ref
        .optional()
        .describe('Ref of the [verification complete] or [OK] button to click after approval (omit if none)'),
      message: z
        .string()
        .max(80)
        .optional()
        .describe(
          'Text for the phone notification, in the user\'s language (e.g. "Please approve the Gov24 verification in KakaoTalk")',
        ),
    },
    false,
  )
  tool(
    'request_code',
    'Get a value on the phone and fill it in (verification code, resident number back digits, CAPTCHA)',
    "For values Dool2 does not know on identity verification and payment screens: a card on the user's phone receives the value and Dool2 types it straight into that field (ref). You never see it; never ask for it in chat or tell the user to type it on the PC. " +
      'kind (see its description) covers verification codes (after filling name, date of birth and mobile with browser_fill_profile and clicking [get verification code]), resident number back digits, payment password keypads (two calls, see key_refs or box) and CAPTCHA text (two calls, see pick; never read and type it yourself). ' +
      'After calling, end this reply; when the notification that the value was entered arrives, click [OK] or [verify] and continue.',
    {
      tabId,
      ref: ref.optional().describe('Ref of the input for the code (not needed for an image keypad pin)'),
      label: z
        .string()
        .max(40)
        .optional()
        .describe('Field name shown on the card, in the user\'s language (e.g. "6-digit verification code")'),
      kind: z
        .enum(['code', 'rrn_back', 'captcha', 'pin'])
        .optional()
        .describe(
          "code = SMS or KakaoTalk verification code (default, not saved) · rrn_back = resident registration number back digits (saved in the vault, filled next time with rrn_back in browser_fill_profile) · captcha = CAPTCHA or anti-bot text (with image) · pin = payment password keypad: the user enters it on the phone's secure keypad and Dool2 clicks the buttons; never hand it to a person",
        ),
      keys: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'For pin: after looking at the cropped button images, the button ref for each digit ({"0":"e20005","1":"e20003",…})',
        ),
      key_refs: z
        .array(ref)
        .max(16)
        .optional()
        .describe(
          'For pin, first: all keypad button refs. Each button comes back cropped; look at them and call again with keys',
        ),
      box: z
        .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
        .optional()
        .describe(
          'For pin when the keypad is an image without button refs: the box around the whole number keypad on the browser_screenshot screen (0-1000). Give only box first to get the crop, then call again with the same box and keys_at pointing at the digits in that image',
        ),
      keys_at: z
        .record(z.string(), z.array(z.number()).length(2))
        .optional()
        .describe(
          'Centers of the 0-9 buttons in the keypad image cropped with box ({"0":[x,y],…}, 0-1000 relative to the image)',
        ),
      length: z.number().int().min(4).max(8).optional().describe('Number of pin digits (default 6)'),
      pick: z
        .number()
        .int()
        .min(1)
        .max(6)
        .optional()
        .describe(
          'For captcha: call first without it and a few images cropped around the field come back; call again with the number of the one where the CAPTCHA is clearest (that image shows on the card)',
        ),
    },
    false,
  )
  tool(
    'request_tap',
    'Solve a picture robot check by tapping',
    'Solves robot checks that are answered by tapping a picture (tap where this picture is on the map, select all squares with traffic lights, etc.) through a card on the user\'s phone. Give the spot of the robot check picture (ref, or if it has none, a box marked on the browser_screenshot screen); only that area is cropped and shown on the phone with the instruction (say), and Dool2 taps the places the user tapped at the same positions on the PC screen, in order. Put the question text (e.g. "Tap the location of this picture on the map") in say exactly as written on the screen. If the question picture sits outside the box, mark the box so it is included. Never guess the answer and tap yourself. Use this instead of browser_handoff. After calling, end this reply; when the notification that it was tapped arrives, read the screen again and click [OK] or [Submit] to continue (if another puzzle appears, call again).',
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
        .describe(
          'Box on the browser_screenshot screen that contains the question text, picture and map (top-left of the screen 0, right and bottom edges 1000). Be generous',
        ),
      say: z.string().max(80).describe('Question text shown on the card (exactly as written on the screen)'),
      taps: z
        .number()
        .int()
        .min(1)
        .max(9)
        .optional()
        .describe('Number of taps allowed (default 1; for selecting several squares, up to that many)'),
    },
    false,
  )
  tool(
    'request_profile',
    'Show my info card',
    'Use when booker or buyer fields need filling but an item is missing from my info (when browser_fill_profile says it is missing). Also show this card with car_no or passport_* when a car number (periodic inspection, recalls, car tax, insurance) or passport (ESTA, overseas flights) is needed but missing (never ask in chat). Also show it with address when where the user lives is needed (nearby search, departure time, district office, community center) but my info has no address (never ask for the neighborhood in chat; once entered it is not asked again; ask only when a different place is the starting point). Do the parts that work without the address first (reading and assessing received photos or documents, general info, candidates based on Seoul) and put them in the answer, then show the card. It shows a my info card on the phone that the user fills once. The values are stored only in the PC vault and you get masked values only. Never ask for name, email or phone number in chat. After showing the card, finish any research that works without that info and end with the results in the answer.',
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
        .describe(
          "When collecting auth_app: the authentication app names shown in that site's simple authentication window (exactly as on screen, e.g. the Korean names for KakaoTalk, Naver, Toss). The user only picks one",
        ),
      reason: z
        .string()
        .max(120)
        .optional()
        .describe(
          'One line on why it is needed, in the user\'s language (e.g. "To fill the booker fields for Le Dortoir")',
        ),
    },
    false,
  )
  tool(
    'new_password',
    'Create a new password',
    'Use to fill the "new password" field on sign-up or password recovery/change screens. Dool2 creates a strong password that fits the field\'s length rules and types it into that field (and the confirm field). You never receive the password (the result has no value). It is saved in the vault after Dool2 sees the screen confirming the sign-up or change. If the user did not choose to sign up or change the password on that site, Dool2 asks on the phone first and types nothing (then end the reply). Give the ID (email) as username, or my info email is used. Never use it for the password field of a login screen (an existing account). ' +
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
    'Approval card for actions that do not spend money: use for buttons that need approval, like send, delete, apply (including cancel, return, plan change, termination) or personal data consent (when browser_click or browser_dialog says it will not proceed without approval). Never use it for payment (the last button that spends money): payment goes only through browser_checkout (the payment card). When the user approves on the phone after seeing the screenshot and details, Dool2 clicks only that button itself. For [OK] in a site confirm dialog, use dialog: true instead of ref. If there are fields to choose (recipient, application type, pickup method, etc.), do not pick them yourself: put their refs in choices so the user picks on the card. After calling, end this reply; when the approval notification arrives, read the screen again to confirm it is done.',
    {
      tabId,
      ref: ref.optional().describe('Ref of the button to click (omit for a confirm dialog)'),
      dialog: z
        .boolean()
        .optional()
        .describe('true to get approval for [OK] in the open site confirm dialog'),
      what: z.string().max(200).describe('What, in the user\'s language (e.g. "Return order: apples 1 kg")'),
      where: z.string().max(100).describe('Where (site or shop name, e.g. "Dool2 test shop")'),
      amount: z
        .string()
        .max(60)
        .optional()
        .describe('How much (exactly as written on the page, with its currency, e.g. "₩9,900")'),
      cancel: z
        .string()
        .max(200)
        .optional()
        .describe(
          "Cancellation or refund terms (if unknown, say there is no notice, in the user's language)",
        ),
      choices: z
        .array(ref)
        .max(8)
        .optional()
        .describe(
          'Refs of fields the user picks while approving (pickup method, application type radios, etc., e.g. ["e31","e32"]). Payment methods go in browser_checkout choices',
        ),
      choiceTitle: z
        .string()
        .max(20)
        .optional()
        .describe("Title for the choices, in the user's language (e.g. pickup method)"),
      chose: z
        .array(z.string().max(60))
        .max(8)
        .optional()
        .describe(
          'What Dool2 picked on the screen by itself, in the user\'s language (e.g. ["Reason: changed my mind","Agree to all terms","Pickup at the door"]). Listed so the user can see and change them on the approval card. Different from choices, which the user picks',
        ),
      ship_to: z
        .string()
        .max(120)
        .optional()
        .describe(
          'Address that goes into the application, like a return pickup or exchange delivery address (e.g. "Home · Sinbong-dong, Suji-gu, Yongin …, at the door"). For payment delivery addresses use ship_to in browser_checkout',
        ),
      ship_options: z
        .array(z.string().max(120))
        .max(5)
        .optional()
        .describe(
          'Other addresses saved on the site (shown under [change address]). If the user picks one on the approval card, Dool2 changes it and then clicks. For payment use ship_options in browser_checkout',
        ),
      count: z
        .number()
        .int()
        .min(2)
        .max(20)
        .optional()
        .describe(
          'Count when doing the same action several times in a row (e.g. deleting 6 events, sending 5 emails). List them all in what and get approval once with the first button. Once approved, the rest are clicked on the same site without further approval requests (within 10 minutes). Never use for payment',
        ),
    },
    false,
  )
  tool(
    'checkout',
    'Payment card',
    "The only way to get payment approved. Use before clicking the last pay button on the payment screen (where the payment method and final amount are chosen). Do not stop on the payment screen to ask; set the delivery address, payment method and coupons, get to the last button, then call this. For any payment (shopping, groceries, delivery, lodging, flights, tickets), read the payment screen and fill the fields below; one payment card appears on the phone, where the user picks the delivery address and payment method and approves once (this is the only approval). [Order] or [Buy] buttons before the payment screen are passed with browser_click (opens_checkout: true), not this. Fill in values exactly as written on the screen; never make them up. If the same product or room was found cheaper on another site earlier in this conversation, add it as one info line (the price and how much cheaper), but do not delay the payment to search anew; if the final price (with coupons and shipping) is unknown, say so. After calling, do not repeat the card's contents in text; say just one or two lines (what for how much, anything to check) and end the reply. When the approval notification arrives, finish the same payment all the way through the payment window that opens after Dool2 clicks (choosing a card, next, payment password keypad via browser_request_code kind: pin), then read the order (booking) number on the completion screen and call browser_order_done.",
    {
      tabId,
      ref: ref.describe('Ref of the last button (pay, complete booking, etc.)'),
      title: z
        .string()
        .max(60)
        .describe(
          'Shop or product bundle name, as on the screen (e.g. "Hoho Sotbap - Suji branch", "Grand Hyatt Jeju · Deluxe King")',
        ),
      where: z.string().max(60).describe('Site or service name (e.g. "Coupang", "Kurly")'),
      total: z
        .string()
        .max(60)
        .describe('Final payment amount (as on screen, with its currency, e.g. "₩17,500")'),
      goods: z
        .array(
          z.object({
            name: z.string().max(80),
            option: z.string().max(80).optional().describe('Option, size, color, room or seat'),
            qty: z
              .string()
              .max(20)
              .optional()
              .describe('Quantity, as on screen (e.g. "1 item", "2 nights", "2 adults")'),
            price: z.string().max(30).optional(),
            image: z
              .string()
              .max(800)
              .optional()
              .describe('Product photo address (https, exactly as on screen or in a tool result)'),
          }),
        )
        .max(20)
        .describe('Product lines'),
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
        .describe(
          'Amount lines (item total, shipping/delivery fee, discounts, points). The final amount goes in total',
        ),
      info: z
        .array(z.object({ label: z.string().max(16), value: z.string().max(160) }))
        .max(8)
        .optional()
        .describe(
          'Info lines (expected arrival, date and time of use, booker/passengers, requests, seats, etc.)',
        ),
      ship_to: z
        .string()
        .max(120)
        .optional()
        .describe('For shipping or delivery: the currently selected delivery address'),
      ship_options: z
        .array(z.string().max(120))
        .max(5)
        .optional()
        .describe('Other delivery addresses saved on the site (read by opening the change-address view)'),
      choices: z
        .array(ref)
        .max(8)
        .optional()
        .describe(
          'Refs of the payment method (or payment mode like pay now / pay on site) choices. Expand methods that are hidden behind a toggle first. Leave out methods the screen says do not work now (e.g. "Internet Explorer only", "app only", "under maintenance"): the payment would fail even if the user picked them',
        ),
      choiceTitle: z.string().max(20).optional(),
      chose: z
        .array(z.string().max(60))
        .max(8)
        .optional()
        .describe(
          "What Dool2 picked on the screen by itself before paying, in the user's language (coupon applied, no travel insurance, agreed to all terms, no points). The user sees and can change them on the card; payment methods the user picks go in choices",
        ),
      cancel: z
        .string()
        .max(200)
        .optional()
        .describe('Cancellation, refund and exchange policy (as on screen)'),
      after: z
        .string()
        .max(120)
        .optional()
        .describe(
          'What happens after approval, as read from the screen, in the user\'s language (e.g. if the chosen method moves to a payment window like Naver Pay, Kakao Pay or Toss: "The payment password for the Naver Pay window is entered on your phone keypad"; for pay-on-delivery: "The order goes in as soon as you tap"). So the user knows what tapping will do',
        ),
      final_here: z
        .boolean()
        .optional()
        .describe(
          "true when there is no separate payment screen and this screen's button spends money directly (the card appears either way)",
        ),
    },
    false,
  )
  tool(
    'order_done',
    'Report order complete',
    'Use when an approved payment is finished: if you read the order number on the order (booking) completion screen, call with order_no. Dool2 releases the payment lock (the paying tab and payment window) and marks the payment approval as complete with the order number. Then show the result with show_result and record it with know_save. If the payment did not go through (declined, timed out, error), call with failed: true and reason, check whether money was taken, then try another way. After a success, suggest the helpful follow-ups briefly, all at once, and do them when the user agrees: adding it to the calendar if it has a date (bookings, shows, trips), a reminder the day before a free cancellation or return deadline (goal_create), saving the order number and confirmation to the Library (library_save).',
    {
      tabId,
      order_no: z
        .string()
        .max(60)
        .optional()
        .describe('Order or booking number (exactly as on the completion screen). Required unless failed'),
      summary: z
        .string()
        .max(200)
        .optional()
        .describe('What for how much, in the user\'s language (e.g. "Apples 1 kg ₩9,900 · arriving 11/22")'),
      failed: z.boolean().optional().describe('true if the payment could not be completed'),
      reason: z.string().max(200).optional().describe('With failed: the reason the screen gave'),
    },
    false,
  )
  tool(
    'dialog',
    'Answer a site dialog',
    'Use when reading the page says a site confirm dialog is open; handle it before anything else. Clicks [OK] (accept: true) if it matches the user\'s request, otherwise [Cancel] (accept: false), in the dialog the site opened (e.g. "Go to your cart?") and returns the changed page. A site alert (💬 in the page read) is only something the site told you (e.g. the password is wrong): read it and decide what to do next. For prompt dialogs, put the text in text. [OK] that would pay, order, send or delete is blocked by Dool2 and needs approval.',
    {
      tabId,
      accept: z.boolean().describe('true for [OK], false for [Cancel]'),
      text: z.string().max(500).optional().describe('Text to enter, for prompt dialogs'),
    },
    false,
  )
  tool(
    'handoff',
    'Hand off to the user',
    'Emergency only (only with emergency: true): lets the user open the PC screen from the phone and operate it directly. Users do not want PC screen hand-offs. Everything a person must do goes through phone cards: name, contact, date of birth and resident number back digits via browser_fill_profile; verification codes, payment password keypads and certificate passwords via browser_request_code; robot checks via browser_request_tap (pictures) or browser_request_code (kind: captcha, text); authentication app approvals via browser_wait_auth; IDs and passwords via browser_request_login; payments via browser_checkout; send, delete and consent via browser_request_approval. Use this only for fields none of those can handle and only a person can fill (e.g. entering a new card number for the first time because no card is saved). The first call on a given screen does not hand off; it reads the screen again and returns it (do it yourself if you can; call again only if truly needed). It brings the Dool2 tab in front of the user and tells them what to do. After calling, end this reply.',
    {
      tabId,
      reason: z
        .string()
        .max(200)
        .describe(
          'Request shown to the user, in the user\'s language (e.g. "No card is saved. Just enter the new card number and Dool2 will do the rest")',
        ),
      emergency: z
        .boolean()
        .optional()
        .describe(
          'true only in a real emergency that phone cards (request_code, request_tap, checkout, fill_profile) cannot handle. Without it nothing is handed off',
        ),
    },
    false,
  )
  tool(
    'close',
    'Close tab',
    'Closes a Dool2 tab. Usually not needed: Dool2 tidies its tabs by itself (keeps the few most recent, closes idle ones), so do not spend a step closing tabs at the end of a task. Close one only when it gets in the way, like a duplicate of the same page. Never close the tab or payment window of a payment in progress before its completion screen.',
    { tabId },
    false,
  )
}
