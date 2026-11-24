// Daemon-side runner for the Dool2 browser tools. The AI (MCP tool server) only asks; whether an action may happen is decided here.
// The extension is a hand that does not judge, so blocking risky clicks also happens here (docs/architecture.md 4.2, threat model T2·T3).
//
// The AI judges; the rules here are only safety rails (user decision 11-20):
// ① The final button that actually spends money (or sends or deletes) needs one approval every time — only buttons the AI
//    declared final (browser_checkout, request_approval, click's final) and buttons whose label has money/send/delete words
//    are blocked and turned into a payment card or approval card.
//    When the user approves, the daemon presses that one button (approvals.ts). One approval = one button.
// ② Never put one site's account into another site. ③ Vault values never go to the AI.
// After the payment button is pressed, the payment group (payment company window, new tabs) carries on until order complete (browser_order_done).

import { randomInt } from 'node:crypto'
import type { Lang } from '@dool2/i18n'
import type {
  ApprovalView,
  BrowserCommand,
  CheckoutGood,
  RemoteForm,
  RemoteFormValue,
  RemoteInfo,
} from '@dool2/protocol'
import {
  PAY_KINDS,
  type PayMethod,
  payMethodLabel,
  payMethodMatches,
  pickPayMethod,
} from '@dool2/protocol/pay-methods'
import { APPROVAL_TTL_MS, type ApprovalRecord, Approvals, MONEY_APPROVAL_TTL_MS } from './approvals.js'
import type { UploadFile } from './files.js'
import { browserText } from './locales/browser.js'
import { LoginRequests } from './logins.js'
import {
  maskValue,
  PROFILE_FIELDS,
  PROFILE_KEYS,
  type ProfileField,
  type ProfileKey,
  type ProfileStore,
  profileValue,
  sourceOf,
} from './profile.js'
import {
  ACCOUNT_DONE_WORDS,
  ACCOUNT_EXISTS_WORDS,
  APPROVAL_NEEDED,
  ASKED_RESET,
  ASKED_SIGNUP,
  BENEFIT_SUFFIX,
  BUTTON_OR_LINK_NAMED_REF,
  BUTTON_OR_LINK_REF,
  CARD_OPTION_WORDS,
  CARD_SUFFIX,
  CART_ADD_WORDS,
  CHECKOUT_AMOUNT,
  CHECKOUT_BOOKER,
  CHECKOUT_PAY_METHOD,
  CHECKOUT_TERMS,
  CHOICE_ROLE_PREFIX,
  CODE_HINT_WORDS,
  CONSENT_WORD,
  COOKIE_REJECT_NAMES,
  COOKIE_WORDS,
  DIALOG_CONTACT_WORDS,
  DIALOG_IRREVERSIBLE_WORDS,
  DIALOG_MONEY_WORDS,
  EXPANDED_REF,
  INSTALLMENT_WORDS,
  KEYPAD_CASE_KEY,
  KEYPAD_DONE,
  KEYPAD_LOWER,
  KEYPAD_SPECIAL_NAMES,
  KEYPAD_SYMBOLS_TO_LETTERS,
  KEYPAD_TO_LETTERS,
  KEYPAD_TO_SYMBOLS,
  KEYPAD_UPPER,
  LOOKUP_WORDS,
  NEAR_LABEL_REF,
  NEED_OPTION_WORDS,
  NOT_FOUND_WORDS,
  OPTION_FIELD_NAME,
  OPTION_FIRST_WORDS,
  ORDER_CONFIRMED,
  PASSWORD_FIELD_NAME,
  PAY_BUTTON_NAMES,
  PAY_METHOD_WORDS,
  PAY_NOW_WORDS,
  PAY_OPTION_NAMES,
  PRICE_SUFFIX,
  PROMO_CLOSE_NAMES,
  PROMO_KEEP_WORDS,
  PROMO_WORDS,
  payMethodTitle,
  RISK_CONTACT_WORDS,
  RISK_IRREVERSIBLE_WORDS,
  RISK_MONEY_WORDS,
  ROLE,
  SELECTED_REF,
  SENTENCE_END,
  SNAP_ROLES,
  SOLD_OUT_MARK,
  SOLD_OUT_WORDS,
  SUB_OPTION_WORDS,
  TOWN_SUFFIX,
  TOWN_WORD,
  tabTag,
  WORD_CHARS,
} from './region/kr/browser.js'
import { notAccepted, sendFiles, sizeText, type UploadReply } from './upload.js'

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
/** One payment keypad digit: the button ref to press, or a screen position (image keypad) */
export type PinKey = string | { x: number; y: number }
export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
  /** Structured result of a service tool (connector) (MCP structuredContent) */
  structuredContent?: Record<string, unknown>
}

export interface BrowserCaller {
  call(cmd: BrowserCommand, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

export const BROWSER_TOOLS = [
  'open',
  'navigate',
  'read',
  'click',
  'type',
  'press',
  'scroll',
  'screenshot',
  'back',
  'close',
  'handoff',
  'login',
  'request_login',
  'fill_profile',
  'request_profile',
  'request_code',
  'request_tap',
  'wait_auth',
  'new_password',
  'select',
  'request_approval',
  'checkout',
  'dialog',
  'steps',
  'hover',
  'order_done',
  'wait',
  'tabs',
  'upload',
] as const
export type BrowserTool = (typeof BROWSER_TOOLS)[number]

export type RiskKind = 'money' | 'contact' | 'irreversible'
export interface Risk {
  kind: RiskKind
  /** Why it looked risky (button label or URL) */
  reason: string
}

// Risk judged by the button label. Any match counts as risky (it stays risky even if the AI says "this is just a lookup")
const RISK_WORDS: [RiskKind, RegExp][] = [
  ['money', RISK_MONEY_WORDS],
  [
    // Approval only for sending to people and for applications/submissions that hand over personal data (user 11-20: posting reviews and the like is part of the task, no approval)
    'contact',
    RISK_CONTACT_WORDS,
  ],
  ['irreversible', RISK_IRREVERSIBLE_WORDS],
]

// Checkout-step URL (used only as a hint: to put payment methods on the payment card or add a guidance line. It does not block buttons)
// (measured 11-20 Gmarket: blocking buttons broadly by URL also blocked adding a shipping address, Enter in address search and [Next] in the payment company window, stopping six times)
const PAY_URL =
  /\/(?:checkout|payment|payments|pay|order\/?(?:sheet|form|confirm)|orderform|ordersheet)(?:[/?#.]|$)|(?:^|\.)(?:pay\.naver\.com|kakaopay\.com|tosspayments\.com|toss\.im|inicis\.com|nicepay\.co\.kr|kcp\.co\.kr|danal\.co\.kr|payco\.com|paypal\.com)/i

// Checkout screen marks. Product and detail pages often show 'payment method' guidance or a folded 'payment info' button too (measured: 11st, Gmarket,
// Musinsa, Jeju Air, Trip.com), so it counts as a checkout screen only when two or more different groups show together. Text inside button names is not counted.
// This is only a hint too: whether to show the payment card or press a button is decided by the AI looking at the screen
const CHECKOUT_MARKS: [string, RegExp][] = [
  ['payment method', CHECKOUT_PAY_METHOD],
  ['booker details', CHECKOUT_BOOKER],
  ['payment amount', CHECKOUT_AMOUNT],
  ['terms consent', CHECKOUT_TERMS],
]

/** If the page looks like a checkout screen (where payment method and booker details are entered), the marks seen (hint). A checkout-step URL also counts */
export function checkoutScreen(text: string, url: string): string | undefined {
  try {
    const u = new URL(url)
    if (PAY_URL.test(u.pathname) || PAY_URL.test(u.hostname)) return 'checkout URL'
  } catch {}
  const seen = new Set<string>()
  for (const raw of text.split('\n')) {
    if (/\[e\d+ /.test(raw)) continue // text inside button and field names does not count
    const line = raw.replace(/^[#\s>*-]+/, '').trim()
    if (!line || line.length > 60) continue
    if (SENTENCE_END.test(line)) continue
    for (const [name, re] of CHECKOUT_MARKS) if (re.test(line)) seen.add(name)
  }
  return seen.size >= 2 ? [...seen].join('·') : undefined
}

// Words that look like a confirmed booking or order (hint: while paying, tells the AI to read the order number and finish with browser_order_done)
const CONFIRMED = ORDER_CONFIRMED

/** The confirming words if this is a payment-confirmed screen */
export function confirmedScreen(text: string): string | undefined {
  return CONFIRMED.exec(text)?.[0]
}

/** How long to remember a payment flow (a tab a pay-tier service tool handed to the AI) */
export const PAY_FLOW_TTL_MS = 60 * 60_000

/**
 * How long to remember a payment group (from pressing the approved payment button to order complete): 1 hour, same as the payment approval card.
 * Holding tabs and pressing once after changing the shipping address use the same time (before, approval 60 min, paying 15 min and tab 10 min differed, so it came loose midway)
 */
export const PAY_SESSION_TTL_MS = MONEY_APPROVAL_TTL_MS

/**
 * Risk judged by the button label (money, contact, irreversible). This is the only rule: no broad blocking by URL or screen.
 * Other final buttons are declared by the AI (browser_checkout, browser_request_approval, click's final)
 */
export function classifyRisk(label: string): Risk | undefined {
  // Radios and checkboxes only choose, they do not confirm (an approval used to be asked separately for a 'pay deposit' radio)
  if (CHOICE_ROLE_PREFIX.test(label)) return undefined
  // Words for looking at past items (order details, payment history, booking lookup) are removed first ("reorder from order history" is still blocked)
  const acting = label.replace(LOOKUP, ' ').replace(CART_ADD, ' ')
  for (const [kind, re] of RISK_WORDS) {
    const m = re.exec(acting)
    if (m) return { kind, reason: `"${m[0]}"` }
  }
  return undefined
}

// Button names that spend money right now by themselves: they cannot be buttons that only 'move on' to the checkout screen (opens_checkout) (safety rail)
const PAY_NOW = PAY_NOW_WORDS

/** Whether the name spends money right now (a button that cannot be passed with opens_checkout) */
export function payNow(name: string): boolean {
  return PAY_NOW.test(name.replace(/\s+/g, ' ').trim())
}

// Words for viewing past orders, payments and bookings: they do not spend or send
const LOOKUP = LOOKUP_WORDS

// Adding to a cart or order sheet: no money is spent (measured: Yogiyo's 'add to order sheet' was treated as payment and asked for approval)
const CART_ADD = CART_ADD_WORDS

/** Whether the ref is inside a frame on the page (payment company window etc.): the extension gives frame fields big numbers (e10001~) or frame ids (f3:e12) */
export function frameRef(ref: string): boolean {
  return /^e\d{5,}$/.test(ref) || /^f\d+:/.test(ref)
}

// Risk judged by the text of a site confirm dialog: "Book now?", "Proceed with the order?", "Delete?"
const DIALOG_RISK: [RiskKind, RegExp][] = [
  ['money', DIALOG_MONEY_WORDS],
  ['contact', DIALOG_CONTACT_WORDS],
  ['irreversible', DIALOG_IRREVERSIBLE_WORDS],
]

/** Whether pressing [OK] in a confirm dialog does something risky (judged by the dialog text only, no broad blocking by URL) */
export function classifyDialogRisk(message: string, lang: Lang = 'ko'): Risk | undefined {
  for (const [kind, re] of DIALOG_RISK) {
    const m = re.exec(message)
    if (m) return { kind, reason: browserText(lang).dialogReason(m[0].trim()) }
  }
  return undefined
}

/**
 * First words of a result stopped by the approval gate (service tools recognize "a stop a connector cannot pass" by these words).
 * The text lives in region/kr: connectors.ts and apps/extension/scripts/e2e.mjs match it exactly.
 */
export const GATE_STOP = APPROVAL_NEEDED

const RISK_TEXT: Record<RiskKind, string> = {
  money: 'something that spends money',
  contact: 'something that sends or posts to other people',
  irreversible: 'something that cannot be undone',
}

/** Error when the AI tries to move a tab that is in the middle of paying */
const PAYING_TAB_MOVE =
  'This tab is paying. It is not moved to another URL until the payment finishes (order complete screen). If the screen is blank, the payment window may have opened in a new window or a frame on the page: find it with browser_read or browser_screenshot and finish the payment (payment PIN and verification go through phone cards). Do other things in a new tab with browser_open.'

interface PageInfo {
  url: string
  refs: Map<string, { role: string; name: string }>
  /** If this is a checkout screen (where payment method and booker details are entered), the marks seen */
  checkout?: string
  /** If this is a confirmed booking or order screen, the words seen */
  confirmed?: string
  /** Radios and checkboxes currently selected */
  selected?: Set<string>
  /** Expanded button refs (Yanolja: only the chosen payment method row has its benefits expanded) */
  expanded?: Set<string>
  /** Unnamed button or radio → the text right after it (Coupang checkout: an unnamed [e8] button, then the line 'Coupay money: 0 won') */
  near?: Map<string, string>
  /** Order in which refs appear in the page text (to find lists under a payment method) */
  pos?: Map<string, number>
}

/** Payment group: the tabs treated as one payment from pressing the approved payment button until order complete (browser_order_done) */
export interface PaySession {
  /** Approval id of this payment (finished together with the order number at order complete) */
  approvalId: string
  /** Tab where the payment button was pressed (the store's order sheet) */
  tabId: number
  /** Tabs of this payment: the pressed tab + payment windows and new tabs it opened */
  tabs: Set<number>
  /** Store site group (siteKey). If the pressed tab moves to another site (payment company), it is treated as the payment company window */
  site: string
  /** Label of the pressed button */
  label: string
  startedAt: number
}

/** The extension's tab list command (opener and URL per tab). Added to the extension separately: an unknown extension errors → empty list */
const TABS_CMD = 'tabs' as BrowserCommand

/** Text attached to an unnamed button or radio: the rest of the same line, else the next line (up to ':', not another ref line) */
export function nearLabels(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of text.matchAll(NEAR_LABEL_REF)) {
    const rest = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 200).split('\n')
    const line = (rest[0] ?? '').trim() || (rest[1] ?? '').trim()
    if (!line || line.startsWith('[')) continue
    const label = (line.split(/[:：]/)[0] ?? '').trim().slice(0, 30)
    if (label) out.set(m[1] as string, label)
  }
  return out
}

function pageInfo(url: string, text: string): PageInfo {
  const checkout = checkoutScreen(text, url)
  const confirmed = confirmedScreen(text)
  const selected = new Set([...text.matchAll(SELECTED_REF)].map((m) => m[1] as string))
  const expanded = new Set([...text.matchAll(EXPANDED_REF)].map((m) => m[1] as string))
  const near = nearLabels(text)
  const pos = new Map([...text.matchAll(/\[(e\d+) /g)].map((m) => [m[1] as string, m.index ?? 0]))
  return {
    ...(pos.size ? { pos } : {}),
    url,
    refs: parseRefs(text),
    ...(near.size ? { near } : {}),
    ...(checkout ? { checkout } : {}),
    ...(confirmed ? { confirmed } : {}),
    ...(selected.size ? { selected } : {}),
    ...(expanded.size ? { expanded } : {}),
  }
}

/** Maximum actions in one go */
export const MAX_STEPS = 12

/** Current tab state returned by extension commands */
interface BrowserState {
  url?: string
  dialog?: SiteDialog
}
interface ActResult {
  note: string
  url?: string
  dialog?: SiteDialog
  newTabId?: number
}
const state = (r: BrowserState | undefined): { url?: string; dialog?: SiteDialog } => ({
  ...(typeof r?.url === 'string' ? { url: r.url } : {}),
  ...(r?.dialog ? { dialog: r.dialog } : {}),
})

/** Site dialog (as the extension reported it) */
export interface SiteDialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
  url: string
  defaultPrompt?: string
}

interface Snapshot {
  tabId: number
  url: string
  title: string
  text: string
  truncated: boolean
  captcha: boolean
  /** Characters left above and below the screen when read with view */
  around?: { above: number; below: number }
  /** Characters skipped from the start with from or skip */
  skipped?: number
  fromMissing?: boolean
  /** Length of the main page text (text also carries frame text and Dool2 notes; continued reading skips only this much) */
  mainLength?: number
  /** Open confirm dialog (confirm or prompt). The page waits until one is chosen */
  dialog?: SiteDialog
  /** Dialogs the extension closed right away (alert, leave-page confirm) */
  dialogNotes?: SiteDialog[]
}

/** Collects refs like [e12 <role> "<name>"] from snapshot text */
export function parseRefs(text: string): Map<string, { role: string; name: string }> {
  const refs = new Map<string, { role: string; name: string }>()
  // The extension turns double quotes inside names into single quotes
  const roles = SNAP_ROLES
  const re = new RegExp(`\\[(e\\d+) (${roles})(?: "([^"]*)")?[^\\]]*\\]`, 'g')
  for (const m of text.matchAll(re)) {
    refs.set(m[1] as string, { role: (m[2] ?? '').trim(), name: m[3] ?? '' })
  }
  return refs
}

// Reject button of a cookie consent banner. The banner covers the page and blocks clicks
// (measured 2026-11-18: the dark layer of a Hotels.com cookie banner covered [Book] so an approved click did nothing).
// It is not pressed: the read result mentions it in one 'covering window' line so the AI closes it (coverLine)
const COOKIE_REJECT = COOKIE_REJECT_NAMES
const COOKIE_WORD = COOKIE_WORDS

/**
 * Ref (e12) of the reject button when a cookie consent banner is open.
 * Only when cookie wording is right before the button (within 600 characters) — 'reject all' on other screens is not pressed.
 * Banners without a reject button (accept only) are left alone
 */
export function cookieReject(text: string): string | undefined {
  const re = BUTTON_OR_LINK_REF
  for (const m of text.matchAll(re)) {
    if (!COOKIE_REJECT.test((m[2] ?? '').replace(/\s+/g, ' ').trim())) continue
    const before = text.slice(Math.max(0, (m.index ?? 0) - 600), m.index)
    if (COOKIE_WORD.test(before)) return m[1]
  }
  return undefined
}

// Close buttons of ad, app install, newsletter and urgency popups (they cover the page and hide the task)
// (measured 2026-11-18: an urgency popup like 'almost done booking' covered buttons during a hotel booking)
const PROMO_CLOSE = PROMO_CLOSE_NAMES
// Only when that window is an ad, app install, subscription or urgency popup (real task windows are left alone)
const PROMO_WORD = PROMO_WORDS
// Even an ad window is left alone when these words are also there (real steps such as payment, login, identity verification, consent)
const PROMO_KEEP = PROMO_KEEP_WORDS

/**
 * Ref (e12) of the close button of an ad, app install or urgency popup. Also only reported, not pressed (coverLine).
 * Only when ad or urgency words are near the close button (500 characters before) and no real-step words such as payment or login.
 * Cookie banners are handled by cookieReject
 */
export function promoClose(text: string): string | undefined {
  const re = BUTTON_OR_LINK_REF
  for (const m of text.matchAll(re)) {
    const name = (m[2] ?? '').replace(/\s+/g, ' ').trim()
    if (!PROMO_CLOSE.test(name)) continue
    const near = text.slice(Math.max(0, (m.index ?? 0) - 500), (m.index ?? 0) + 60)
    if (PROMO_KEEP.test(near)) continue
    if (PROMO_WORD.test(near) && !COOKIE_WORD.test(near)) return m[1]
  }
  return undefined
}

/** Find the same control: the same ref if unchanged, else the only control with the same role and label */
export function sameControl(
  refs: Map<string, { role: string; name: string }>,
  ref: string,
  role: string,
  name: string,
): string | undefined {
  const at = refs.get(ref)
  if (at && at.role === role && at.name === name) return ref
  const same = [...refs].filter(([, v]) => v.role === role && v.name === name)
  return same.length === 1 ? same[0]?.[0] : undefined
}

// Final button whose name changes with the payment method ("pay with Naver Pay" ↔ "pay with card")
const PAY_METHOD = PAY_METHOD_WORDS

// Names of controls that choose a payment method (radios, buttons)
const PAY_OPTION = PAY_OPTION_NAMES

// Buttons that choose a payment method: only when the whole name is a payment method (not buttons that pay, like 'pay with Kakao Pay').
// Names with only a benefit note after them are payment methods too (measured Yanolja: "Kakao Pay benefits", "NOL money 2% points", "other payment method benefits")
const PAY_BUTTON = PAY_BUTTON_NAMES

/** Payment method name shown on the approval card: the trailing benefit note is removed ("Kakao Pay benefits" → "Kakao Pay") */
export function payOptionName(label: string): string {
  return label.replace(BENEFIT_SUFFIX, '').trim() || label
}

/** Name of a payment method control (for an unnamed control, the text right after it) */
export function optionLabel(info: Pick<PageInfo, 'refs' | 'near'>, ref: string): string {
  const v = info.refs.get(ref)
  return (v?.name || info.near?.get(ref) || '').trim()
}

/** Whether it is a control choosing a payment method: radios and options when the name has a payment method in it, buttons when the whole name is one */
export function isPayOption(role: string, label: string): boolean {
  if (!label || label.length > 30) return false
  if (role === ROLE.radio || role === ROLE.option) return PAY_OPTION.test(label)
  return role === ROLE.button && PAY_BUTTON.test(label)
}

/** Name used to compare payment methods (ignores spaces and trailing benefit notes: "SmilePayEasyPay" = "SmilePay EasyPay") */
function payKey(label: string): string {
  return payOptionName(label).replace(/\s+/g, '')
}

/**
 * Payment method controls on the checkout screen (put on the approval card even if the AI passes no choices).
 * When the same payment method appears twice, as a radio and a button next to it, only one is kept — the choosing control (radio)
 * (measured 11-20 Gmarket: the "general payment benefits" radio and button both showed on the card as "general payment" and confused people)
 */
export function payOptions(info: Pick<PageInfo, 'refs' | 'near'>): string[] {
  const byName = new Map<string, string>()
  for (const [k, v] of info.refs) {
    const label = optionLabel(info, k)
    if (!isPayOption(v.role, label)) continue
    const key = payKey(label)
    const had = byName.get(key)
    if (had === undefined) byName.set(key, k)
    else if (info.refs.get(had)?.role !== ROLE.radio && v.role === ROLE.radio) byName.set(key, k)
  }
  return [...byName.values()].slice(0, 8)
}

/**
 * Payment methods to put on the approval card: the ones the AI passed + every payment method on the checkout screen (AI's order first).
 * So that other methods on the screen are not lost when the AI passes only a few (measured Yanolja: 'other payment methods' was missing,
 * so general payment and other pays could not be chosen). When the choices are not payment methods (such as when to pay), only the AI's ones
 */
export function approvalChoices(
  info: Pick<PageInfo, 'refs' | 'near' | 'checkout'>,
  asked: string[] | undefined,
  title: string | undefined,
): string[] {
  const auto = info.checkout && (!title || payMethodTitle(title)) ? payOptions(info) : []
  if (!asked?.length) return auto.length >= 2 ? auto : []
  const out = [...asked]
  const name = (r: string) => payKey(optionLabel(info, r))
  const names = new Set(out.map(name))
  for (const r of auto)
    if (!out.includes(r) && !names.has(name(r))) {
      out.push(r)
      names.add(name(r))
    }
  return out.slice(0, 8)
}

// Detailed payment choices in a checkout dropdown (saved cards, installment months, banks)
const SUB_OPTION = SUB_OPTION_WORDS

/** Names the group by the dropdown's options. undefined for lists unrelated to payment (delivery memo etc.) */
export function subChoiceTitle(options: string[], lang: Lang = 'ko'): string | undefined {
  if (options.length < 2 || !options.some((o) => SUB_OPTION.test(o))) return undefined
  const m = browserText(lang)
  if (options.some((o) => INSTALLMENT_WORDS.test(o))) return m.subInstallment
  if (options.some((o) => CARD_OPTION_WORDS.test(o))) return m.subCard
  return m.subBank
}

/** Find the same choosing control: named controls via sameControl, unnamed ones by the same text right after them */
export function sameChoice(
  info: Pick<PageInfo, 'refs' | 'near'>,
  c: { ref: string; role: string; name: string; near?: string },
): string | undefined {
  if (c.name || !c.near) return sameControl(info.refs, c.ref, c.role, c.name)
  const at = info.refs.get(c.ref)
  if (at && at.role === c.role && !at.name && info.near?.get(c.ref) === c.near) return c.ref
  const same = [...info.refs].filter(([k, v]) => v.role === c.role && !v.name && info.near?.get(k) === c.near)
  return same.length === 1 ? same[0]?.[0] : undefined
}

/** Whether it is the same final button with only the payment method name different */
export function sameFinal(a: string, b: string): boolean {
  const strip = (x: string) => x.replace(PAY_METHOD, '').replace(/\s+/g, ' ').trim()
  return a !== b && strip(a) !== '' && strip(a) === strip(b)
}

/** Finds the current site's login in the vault (values never leave the daemon) */
export interface VaultLookup {
  findForOrigin(origin: string): Promise<{ id: string; username: string; password: string } | undefined>
  markUsed(id: string): Promise<void>
  /** Removes it when the value from the login card was wrong and login failed */
  remove?(id: string): Promise<boolean>
  /** Saves a new password in the vault (signup, password change). The AI never gets the value */
  savePassword?(origin: string, username: string, password: string): Promise<void>
}

/**
 * Strong password for signup or password change (at least one upper, lower, digit and symbol). Never given to the AI.
 * Only symbols almost every Korean site accepts (some block '&' and quotes)
 */
export function makePassword(length = 16): string {
  const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const L = 'abcdefghijkmnpqrstuvwxyz'
  const D = '23456789'
  const S = '!@#$%^*'
  const all = U + L + D + S
  const pick = (set: string) => set[randomInt(set.length)] as string
  const chars = [pick(U), pick(L), pick(D), pick(S)]
  while (chars.length < Math.max(8, length)) chars.push(pick(all))
  // Shuffle positions (so the first four are not always one of each kind)
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j] as string, chars[i] as string]
  }
  return chars.join('')
}

/** Symbol names on secure keypads (screen reader labels: Shinhan Card etc.) */
export const KEYPAD_SPECIAL: Record<string, string[]> = KEYPAD_SPECIAL_NAMES

/** Password typed with a secure keypad: lowercase and digits + one symbol (uppercase needs shift, so left out) */
export function makeKeypadPassword(length = 12): string {
  const L = 'abcdefghijkmnpqrstuvwxyz'
  const D = '23456789'
  const S = '!@'
  const pick = (set: string) => set[randomInt(set.length)] as string
  const chars = [pick(L), pick(L), pick(D), pick(D), pick(S)]
  while (chars.length < Math.max(8, length)) chars.push(pick(L + D))
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j] as string, chars[i] as string]
  }
  return chars.join('')
}

/** Candidate button names for that character on the keypad */
export function keypadLabels(ch: string): string[] {
  if (/^\d$/.test(ch)) return [ch]
  if (/^[a-z]$/.test(ch)) return [`${KEYPAD_LOWER} ${ch}`, ch]
  if (/^[A-Z]$/.test(ch)) return [`${KEYPAD_UPPER} ${ch}`, ch]
  return [...(KEYPAD_SPECIAL[ch] ?? []), ch]
}

export async function keypadType(
  browser: BrowserCaller,
  tabId: number,
  fieldRef: string,
  pw: string,
): Promise<boolean> {
  const snap = async () => {
    const r = (await browser.call('snapshot', { tabId, maxChars: 60_000 }, 20_000)) as {
      text?: string
    }
    return [...parseRefs(r?.text ?? '')].filter(([, v]) => v.role === ROLE.button)
  }
  const press = (ref: string) =>
    browser.call('click', { tabId, ref, once: true, force: true, quick: true }, 15_000).then(
      () => true,
      () => false,
    )
  // Press the field to open the keypad
  await press(fieldRef)
  await new Promise((r) => setTimeout(r, 400))
  let keys = await snap()
  const find = (names: string[]) => keys.find(([, v]) => names.includes(v.name))?.[0]
  const isKeypad = () =>
    keys.filter(([, v]) => /^\d$/.test(v.name)).length >= 10 &&
    keys.some(([, v]) => KEYPAD_CASE_KEY.test(v.name))
  // If the symbol row is open, switch back to the letter row first
  if (!isKeypad()) {
    const back = find(KEYPAD_TO_LETTERS)
    if (!back || !(await press(back))) return false
    await new Promise((r) => setTimeout(r, 250))
    keys = await snap()
    if (!isKeypad()) return false
  }
  let layer: 'letters' | 'special' = 'letters'
  for (const ch of pw) {
    const need = /[a-z0-9]/i.test(ch) ? 'letters' : 'special'
    if (need !== layer) {
      const toggle = need === 'special' ? find(KEYPAD_TO_SYMBOLS) : find(KEYPAD_SYMBOLS_TO_LETTERS)
      if (!toggle || !(await press(toggle))) return false
      await new Promise((r) => setTimeout(r, 250))
      keys = await snap()
      layer = need
    }
    const ref = find(keypadLabels(ch))
    if (!ref || !(await press(ref))) return false
    await new Promise((r) => setTimeout(r, 120))
  }
  const done = find(KEYPAD_DONE)
  if (done) await press(done)
  return true
}

/**
 * Puts the vault value into a password field. If text put in at once gets cut (secure keypad field), presses the on-screen keypad buttons.
 * Returns how it was entered ('fill' | 'keypad' | 'short': neither worked)
 */
export async function fillPassword(
  browser: BrowserCaller,
  a: { tabId: number; ref: string; value: string; origin: string },
): Promise<'fill' | 'keypad' | 'short'> {
  const put = (await browser.call('fill', { ...a, password: true })) as { length?: number } | undefined
  if (typeof put?.length !== 'number' || put.length === a.value.length) return 'fill'
  return (await keypadType(browser, a.tabId, a.ref, a.value)) ? 'keypad' : 'short'
}

/** Finds the option the user named in a list: same text, else the only one starting with or containing that text */
export function matchOption(options: string[], want: string): string | undefined {
  const n = (x: string) => x.replace(/\s+/g, ' ').trim().toLowerCase()
  const w = n(want)
  if (!w) return undefined
  const exact = options.find((o) => n(o) === w)
  if (exact) return exact
  // Strip sold-out marks and prices ("M (sold out)", "option01 89,000 won")
  const core = (o: string) => n(o).replace(SOLD_OUT_MARK, '').replace(PRICE_SUFFIX, '')
  const same = options.filter((o) => core(o) === w)
  if (same.length === 1) return same[0]
  // Numeric sizes (260, 95, 32) only on an exact match ("26" must not become "260")
  if (/^\d+(\.\d+)?$/.test(w)) return undefined
  const starts = options.filter((o) => core(o).startsWith(w))
  if (starts.length === 1) return starts[0]
  const has = options.filter((o) =>
    new RegExp(`(^|[^${WORD_CHARS}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^${WORD_CHARS}])`).test(
      core(o),
    ),
  )
  return has.length === 1 ? has[0] : undefined
}

/** Signal that a product option must be chosen first (site dialogs, guidance text) */
export const NEED_OPTION = NEED_OPTION_WORDS

/** What looks like an option field on screen (select boxes, buttons and inputs like "open options", "size", "please choose") */
export function optionFields(refs: Map<string, { role: string; name: string }>): string[] {
  const out: string[] = []
  for (const [ref, c] of refs) {
    const name = c.name.trim()
    if (
      c.role === ROLE.select ||
      ((c.role === ROLE.button || c.role === ROLE.input) && OPTION_FIELD_NAME.test(name))
    )
      out.push(`[${ref} ${c.role} "${name.slice(0, 30)}"]`)
    if (out.length >= 6) break
  }
  return out
}

/** Site group (member.ssg.com, www.ssg.com → ssg.com; www.aladin.co.kr → aladin.co.kr) */
export function siteKey(hostOrUrl: string): string {
  let host = hostOrUrl.trim().toLowerCase()
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = new URL(host).hostname
  } catch {}
  host = host.replace(/^\.+|\.+$/g, '')
  if (/^[\d.]+$/.test(host) || host === 'localhost') return host
  const parts = host.split('.')
  const second = parts.slice(-2).join('.')
  const n = /^(co|or|go|ne|ac|re|pe|com|net|org)\.[a-z]{2}$/.test(second) ? 3 : 2
  return parts.slice(-n).join('.')
}

const DONE_RE = ACCOUNT_DONE_WORDS
const EXISTS_RE = ACCOUNT_EXISTS_WORDS

/** Result the screen shows after a new password was entered: done or account already exists (text already on the first screen does not count) */
export function accountOutcome(
  now: { url: string; title: string; text: string },
  base: { url: string; title: string; text: string },
): 'done' | 'exists' | undefined {
  const moved = now.url.split('#')[0] !== base.url.split('#')[0]
  // Counted by occurrences: even if the signup page already says "already a member?", a new "this email is already registered" adds one more
  const count = (re: RegExp, t: string) => t.match(new RegExp(re.source, 'gi'))?.length ?? 0
  if (count(DONE_RE, now.title) > count(DONE_RE, base.title)) return 'done'
  if (count(EXISTS_RE, now.text) > count(EXISTS_RE, base.text)) return 'exists'
  if (count(DONE_RE, now.text) > 0 && (moved || count(DONE_RE, now.text) > count(DONE_RE, base.text)))
    return 'done'
  return undefined
}

/**
 * Whether the user's words asked for that task (signup, password change). /signup or /join inside a URL does not count
 * (measured: "open …/signup and fill the fields" was taken as a signup request and not asked about)
 */
export function askedForAccount(text: string, purpose: 'signup' | 'reset'): boolean {
  const said = text.replace(
    /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)+(?::\d+)?\/\S*|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\S*/gi,
    ' ',
  )
  return purpose === 'reset' ? ASKED_RESET.test(said) : ASKED_SIGNUP.test(said)
}

/** Password waiting for signup or change to finish before going into the vault */
interface PendingPassword {
  key: string
  origin: string
  username: string
  password: string
  purpose: 'signup' | 'reset'
  at: number
  base?: { url: string; title: string; text: string }
}

/** How long a tab handed to the person can be used from the phone's remote screen */
export const REMOTE_TTL_MS = 30 * 60_000

/**
 * Official verification window sites where personal info (name, mobile, birth date) may be entered: many sites open identity
 * check and certificate windows as frames from these addresses
 * (financial certificate = KFTC yeskey; joint certificate and mobile identity check = certificate authorities and credit bureaus). Passwords are never entered
 */
export const AUTH_FRAME_SITES = [
  'yeskey.or.kr',
  'yessign.or.kr',
  'kftc.or.kr',
  'signkorea.com',
  'crosscert.com',
  'tradesign.net',
  'kica.or.kr',
  'niceid.co.kr',
  'nice.co.kr',
  'kmcert.com',
  'kcb.co.kr',
  'okname.co.kr',
  'sci.co.kr',
  'siren24.com',
]

export class BrowserTools {
  private pages = new Map<number, PageInfo>()
  /** Screens where a hand-off was sent back once (tab:URL) — handed off only the second time */
  private handoffChecked = new Set<string>()
  /** Sites (origin) received through a login card that have not logged in successfully yet. On failure the vault entry is removed and the card asked again */
  private unverified = new Set<string>()
  /** Login attempts filled from the vault (tab → site and entry) — the next read checks success or failure */
  private loginTries = new Map<number, { origin: string; entryId: string }>()
  /** Tabs handed to the person → when. Only these tabs can be seen and pressed from the phone's remote screen */
  private handedOff = new Map<number, number>()
  /** Site confirm dialog open per tab (as of the last read) */
  private dialogs = new Map<number, SiteDialog>()
  /** Approval request for [OK] in a confirm dialog → that dialog's text (checked right before pressing that it is the same dialog) */
  private dialogApprovals = new Map<string, string>()
  /** Payment flow tab → {pay-tier tool name, start time}. Tabs a pay-tier service tool handed to the AI */
  private payFlows = new Map<number, { tool: string; at: number }>()
  /** Service site of a payment flow (still a payment flow when the AI reopens the same site in a new tab) */
  private paySites = new Map<string, { tool: string; at: number }>()
  /** Sites with pay-tier service tools: tabs opened without the tool are payment flows too */
  private payServiceSites = new Set<string>()
  setPayServiceSites(sites: string[]) {
    this.payServiceSites = new Set(sites.map((x) => x.toLowerCase()))
  }

  /** Language for text people read (approval cards, phone notices). index.ts can set it from userLang(settings) */
  userLang: () => Lang = () => 'ko'
  readonly approvals: Approvals
  readonly logins: LoginRequests

  constructor(
    private readonly browser: BrowserCaller,
    private readonly vault?: VaultLookup,
    /** Whether Dool2 presses the final button after approval (approve) or the user always presses it (self) */
    private readonly finalStep: () => 'approve' | 'self' = () => 'approve',
    approvals?: Approvals,
    logins?: LoginRequests,
  ) {
    this.approvals = approvals ?? new Approvals()
    this.logins = logins ?? new LoginRequests()
  }

  /** Site of the URL the tab was last read at (when the work log groups steps by site). undefined if unknown */
  tabHost(tabId: number): string | undefined {
    try {
      return new URL(this.pages.get(tabId)?.url ?? '').host || undefined
    } catch {
      return undefined
    }
  }

  /** The tab Dool2 handled last (the phone's "view Dool2's screen" watches it live) */
  private _lastTabId?: number
  get lastTabId(): number | undefined {
    return this._lastTabId
  }
  set lastTabId(id: number | undefined) {
    const changed = id !== this._lastTabId
    this._lastTabId = id
    if (changed && id !== undefined) this.onActiveTab?.(id)
  }
  /** When the tab Dool2 works in changes (shows the working screen in the phone chat) */
  onActiveTab?: (tabId: number) => void
  /**
   * A service tool works in this tab from now on: let the phone see the screen and tell it right away.
   * Tells it even when the same tab is reused (each service keeps using one tab, and the phone has to know each time work starts to show the screen)
   */
  watchTab(tabId: number) {
    this.allowRemote(tabId)
    this._lastTabId = tabId
    this.onActiveTab?.(tabId)
  }
  /**
   * Where to ask once more when the vault has no entry for the URL: if the tab took over a connection, the account put into that service
   * (when the login screen is another address of the same site, like login.site). The caller checks that it is the same site
   */
  siteLogin?: (
    tabId: number,
    origin: string,
  ) => Promise<{ id: string; username: string; password: string } | undefined>
  /** My info (booker and orderer fields). The AI sees only masked values */
  profile?: ProfileStore
  /** Shows the my-info card (phone). Once saved, the daemon tells that chat to carry on */
  requestProfile?: (fields: ProfileField[], reason: string, options?: string[]) => string | undefined
  /** Sends a notification to the user's phone (waiting for an authenticator app approval, etc.) */
  notifyUser?: (title: string, body: string) => void
  /**
   * Waiting for an authenticator approval off the turn: called when browser_wait_auth starts. Returns where to send
   * the screen once it changes (or the user taps the card) and a signal that ends the watch (the user stopped).
   * undefined: wait inside the tool call as before
   */
  afterAuth?: () => { deliver: (text: string) => void; signal: AbortSignal } | undefined
  /** Waits for an authenticator app approval with a phone card: pressing [I've verified] resolves answer. cancel closes the card */
  askAuthDone?: (
    host: string,
    label: string,
    hint: string,
  ) => { answer: Promise<string | undefined>; cancel: () => void }
  /** Shows the verification code card (phone). The daemon puts the received code in that field and tells the chat to carry on */
  requestCode?: (
    tabId: number,
    field: string,
    label: string,
    hint: string,
    host: string,
    kind?: 'code' | 'rrn_back' | 'captcha',
    ref?: string,
    /** CAPTCHA image (jpeg base64) */
    image?: string,
  ) => string | undefined
  /** Tap-to-solve image card (phone). The daemon taps the same spot inside rect where the user tapped the image (0~1000) */
  requestTap?: (
    tabId: number,
    say: string,
    host: string,
    image: string,
    rect: { x: number; y: number; w: number; h: number },
    taps: number,
  ) => string | undefined
  /** Payment PIN keypad card (phone secure keypad). The daemon presses the keys buttons in order for the digits received */
  requestPin?: (
    tabId: number,
    label: string,
    host: string,
    keys: Record<string, PinKey>,
    length: number,
  ) => string | undefined
  /** If the URL's site has a service tool (connector), that service and its tool names (ADR 0018) */
  siteConnector?: (url: string) => Promise<{ id: string; name: string; tools: string[] } | undefined>
  /** Login fields were filled from the vault (so logging in during work without a connect card is also kept as a connection) */
  onVaultLogin?: (tabId: number, url: string) => void
  /** Where an image keypad was cropped and shown (until the AI points at the digit spots and calls again) */
  private pinShots = new Map<number, { rect: { x: number; y: number; w: number; h: number }; at: number }>()
  /** An account went into the vault after signup or password change (the daemon marks that service as connected) */
  onAccountSaved?: (url: string) => void
  /** Service id if Dool2 can log in to this site again without a card (vault account, a social login used before) */
  reloginFor?: (origin: string) => Promise<string | undefined>
  /** Site whose tips were given per tab (not repeated when moving within the same site) */
  private guided = new Map<number, string>()
  /** Last payment method chosen per site (default for the next approval card) */
  private lastChoice = new Map<string, string>()
  /** My payment methods (ADR 0023, top one is the main method). The one the site accepts becomes the approval card default */
  payMethods?: () => PayMethod[]
  /** When the last chosen payment method changes (the daemon keeps it in settings) */
  onChoice?: (host: string, label: string) => void
  /** Last choice per site and group (card, installment) ("www.coupang.com|<installment>" → "<lump sum>"). Card numbers only as the masked text on screen */
  private lastSub = new Map<string, string>()
  /** When the last chosen saved card or installment changes (the daemon keeps it in settings) */
  onSubChoice?: (key: string, label: string) => void
  loadSubChoices(map: Record<string, string>) {
    for (const [k, v] of Object.entries(map)) this.lastSub.set(k, v)
  }
  /** When settings forget that site's payment method (card and installment memory too) */
  forgetChoice(host: string) {
    this.lastChoice.delete(host)
    for (const k of [...this.lastSub.keys()]) if (k.startsWith(`${host}|`)) this.lastSub.delete(k)
  }
  /** Loads the last payment method per site kept in settings */
  loadChoices(map: Record<string, string>) {
    for (const [k, v] of Object.entries(map)) this.lastChoice.set(k, v)
  }
  private rememberChoice(url: string, label: string) {
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {}
    if (!host) return
    this.lastChoice.set(host, label)
    this.onChoice?.(host, label)
  }
  /** Sites where the user chose signup or password change (siteKey → expiry). Without it, no new password is made; ask first */
  private signupOk = new Map<string, number>()
  /** New passwords waiting for signup or change to finish (put in the vault once the screen shows it finished) */
  private pendingPw: PendingPassword[] = []
  /**
   * Choosing where to deliver: the address on screen, other saved addresses, and the my-info address.
   * If the address on screen differs from my-info (house, building or unit numbers missing), add a warning and offer the my-info address right away.
   * The AI sees the my-info address only masked, so it cannot tell they differ (measured Yogiyo: the neighborhood search spot became the delivery address)
   */
  private async shipChoices(shipTo: string, others: string[]) {
    const labels = [shipTo, ...others]
    let shipWarn: string | undefined
    const p = this.profile ? await this.profile.get().catch(() => undefined) : undefined
    const home = [p?.address, p?.address_detail].filter(Boolean).join(' ').trim()
    if (home) {
      const nums = (t: string) => t.match(/\d+/g) ?? []
      // Neighborhood name (e.g. 'Sinbong-1-ro' → 'Sinbong', 'Sinbong-dong' → 'Sinbong'): road and lot addresses are the same place even with different numbers
      const towns = (t: string) =>
        new Set(
          (t.match(TOWN_WORD) ?? []).map((w) => w.replace(TOWN_SUFFIX, '')).filter((w) => w.length >= 2),
        )
      const detail = nums(p?.address_detail ?? '')
      const has = (t: string) => {
        const got = new Set(nums(t))
        if (nums(home).every((n) => got.has(n))) return true
        // Same building and unit numbers in the same neighborhood mean the same home (measured 11-20: a lot address and its road address were flagged as different)
        const mine = towns(p?.address ?? '')
        return detail.length > 0 && detail.every((n) => got.has(n)) && [...towns(t)].some((w) => mine.has(w))
      }
      if (!has(shipTo)) {
        const m = browserText(this.userLang())
        shipWarn = m.shipWarn
        if (!labels.slice(1).some(has)) labels.splice(1, 0, m.myAddress(home))
      }
    }
    return {
      shipOptions: labels.map((label, i) => ({ id: `a${i}`, label: label.slice(0, 140) })),
      ...(shipWarn ? { shipWarn } : {}),
    }
  }
  /** Pressing an approved payment after changing the shipping address: that button once per tab (1 hour, same as payment approval) */
  private paidPass = new Map<number, { label: string; until: number; approvalId: string }>()
  /** Uses it once if this is the approved final button (that approval id, else undefined) */
  private usePass(tabId: number, name: string): string | undefined {
    const p = this.paidPass.get(tabId)
    if (!p) return undefined
    if (p.until < Date.now()) {
      this.paidPass.delete(tabId)
      return undefined
    }
    if (name !== p.label && !sameFinal(name, p.label)) return undefined
    this.paidPass.delete(tabId)
    return p.approvalId
  }
  /** The user chose signup or password change for this site (phone card, chat) */
  allowSignup(hostOrUrl: string, ms = 60 * 60_000) {
    const key = siteKey(hostOrUrl)
    if (key) this.signupOk.set(key, Date.now() + ms)
  }
  private disallowSignup(key: string) {
    this.signupOk.delete(key)
  }
  private signupAllowed(key: string) {
    const t = this.signupOk.get(key)
    return t !== undefined && t > Date.now()
  }
  /**
   * Asks the user before signup or password change. 'ok' = already asked for it (chat), 'asked' = a choice card is on the phone.
   * Once chosen, the daemon tells that chat to carry on
   */
  askSignup?: (
    site: string,
    key: string,
    purpose: 'signup' | 'reset',
    /** The field did not accept the password Dool2 made: be sure to ask the user to set one themselves */
    needOwn?: boolean,
  ) => 'ok' | 'asked' | undefined
  /** Sites that did not accept the generated password (next time the user sets it on the phone) */
  private pwNeedOwn = new Set<string>()
  /**
   * Checks PC files to upload to a website (browser_upload). The daemon supplies the same fence as the file tools (Desktop, Documents,
   * Downloads, Pictures, Videos; no hidden folders, certificates or keys). Without it, no uploads
   */
  uploadFiles?: (paths: string[]) => Promise<{ files: UploadFile[] } | { error: string }>
  /** Upload approval request → files to upload (once approved, the daemon puts them in that field) */
  private uploadAsks = new Map<string, UploadFile[]>()
  /** Files uploaded after approval: "site|real path" → not asked again until then (retry, same photo in another field) */
  private uploadPass = new Map<string, number>()

  /** New password the user set themselves (per site, removed after one use). The AI never gets the value */
  private ownPw = new Map<string, string>()
  setOwnPassword(key: string, pw: string) {
    this.ownPw.set(key, pw)
  }

  async run(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (typeof args.tabId === 'number') this.allowRemote(args.tabId)
    try {
      // If a new tab is a window opened by a paying tab (payment window), add it to that payment group (a late payment window is the same payment)
      if (typeof args.tabId === 'number' && !this.pages.has(args.tabId)) await this.adoptTab(args.tabId)
      const r = await this.dispatch(tool, args)
      // Only tabs handled without error become "the tab Dool2 is looking at" (a tool called with a wrong id must not make the live view show the wrong tab)
      if (!r.isError && typeof args.tabId === 'number') this.lastTabId = args.tabId
      return r
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: (e as Error).message }] }
    }
  }

  private async dispatch(tool: string, a: Record<string, unknown>): Promise<ToolResult> {
    const tabId = Number(a.tabId)
    switch (tool as BrowserTool) {
      case 'open': {
        const r = (await this.browser.call('open', { url: a.url }, 40_000)) as { tabId: number }
        this.lastTabId = r.tabId
        this.allowRemote(r.tabId)
        return this.notFoundHint(
          String(a.url ?? ''),
          await this.read(r.tabId, undefined, 'Opened a new tab.'),
        )
      }
      case 'navigate': {
        // A paying tab is not moved (measured 11-20 Gmarket: after approval, the tab showing the card payment window was moved to order history and the payment broke)
        if (this.isPaying(tabId)) throw new Error(PAYING_TAB_MOVE)
        await this.browser.call('navigate', { tabId, url: a.url }, 40_000)
        return this.notFoundHint(String(a.url ?? ''), await this.read(tabId, undefined, 'Opened the URL.'))
      }
      case 'read':
        return this.read(tabId, a.maxChars, undefined, {
          ...(a.view === true ? { view: true } : {}),
          ...(typeof a.from === 'string' && a.from.trim() ? { from: a.from.trim() } : {}),
          ...(Number(a.skip) > 0 ? { skip: Math.floor(Number(a.skip)) } : {}),
        })
      case 'click': {
        // Buttons inside a frame on the page (a small window from another address): frames change late. If unchanged right after the click, wait briefly and read again
        // (measured 11-20 Gmarket adding an address: the form appeared, but reading right away concluded 'no input window' and handed off to the person)
        const inFrame = frameRef(String(a.ref ?? ''))
        const frameSig = () =>
          [...(this.pages.get(tabId)?.refs ?? new Map()).entries()]
            .filter(([k]) => frameRef(k))
            .map(([k, v]) => `${k}:${v.role}:${v.name}`)
            .join('|')
        const before = inFrame ? frameSig() : ''
        const r = await this.act(tabId, { ...a, do: 'click' })
        if (r.newTabId)
          return this.read(r.newTabId, undefined, `${r.note} A new tab opened, so I read that tab.`)
        const out = await this.read(tabId, undefined, r.note)
        if (!inFrame || frameSig() !== before) return out
        await new Promise((res) => setTimeout(res, 1_500))
        return this.read(
          tabId,
          undefined,
          `${r.note} (waited briefly for the frame on the page to change and read again)`,
        )
      }
      case 'type':
        return this.read(tabId, undefined, (await this.act(tabId, { ...a, do: 'type' })).note)
      case 'press':
        return this.read(tabId, undefined, (await this.act(tabId, { ...a, do: 'press' })).note)
      case 'hover':
        return this.read(tabId, undefined, (await this.act(tabId, { ...a, do: 'hover' })).note)
      case 'steps':
        return this.steps(tabId, a)
      case 'scroll': {
        const r = (await this.browser.call('scroll', {
          tabId,
          direction: a.direction === 'up' ? 'up' : 'down',
          ...(typeof a.ref === 'string' ? { ref: a.ref } : {}),
        })) as { scroll?: { target: string; before: number; after: number; max: number; atEnd: boolean } }
        const sc = r?.scroll
        const where = sc
          ? ` (${sc.target === 'box' ? 'that box' : 'page'} ${sc.before}→${sc.after}px / end ${sc.max}px${sc.atEnd ? ', reached the end' : ''}${sc.before === sc.after ? ', did not move' : ''})`
          : ''
        // Like a person looking after scrolling, read and return only the visible part (one screen, so it is short)
        return this.read(tabId, undefined, `Scrolled.${where}`, { view: true })
      }
      case 'wait':
        return this.waitChange(tabId, a)
      case 'tabs':
        return this.tabList(a)
      case 'screenshot': {
        const r = (await this.browser.call('screenshot', { tabId })) as {
          data: string
          mime: string
          url: string
          title: string
        }
        return {
          content: [
            { type: 'text', text: `${tabTag(tabId)} ${r.title} — ${r.url}` },
            { type: 'image', data: r.data, mimeType: r.mime },
          ],
        }
      }
      case 'back': {
        if (this.isPaying(tabId)) throw new Error(PAYING_TAB_MOVE)
        await this.browser.call('back', { tabId })
        return this.read(tabId, undefined, 'Went back.')
      }
      case 'close': {
        await this.browser.call('close', { tabId })
        this.pages.delete(tabId)
        return { content: [{ type: 'text', text: `Closed tab ${tabId}.` }] }
      }
      case 'login': {
        // Dool2 vault (ADR 0011): the AI only points at the fields; the daemon checks the URL and hands the values straight to the extension
        const page = this.pages.get(tabId)
        if (a.failed === true) return this.loginFailed(tabId, String(a.reason ?? ''))
        if (!page) throw new Error('Read the login page first')
        const pw = page.refs.get(String(a.passwordRef ?? ''))
        if (pw?.role !== ROLE.password)
          throw new Error('passwordRef must be a password field ref on the page')
        const userRef = a.usernameRef ? String(a.usernameRef) : undefined
        if (
          userRef &&
          !([ROLE.input, ROLE.searchBox] as string[]).includes(page.refs.get(userRef)?.role ?? '')
        )
          throw new Error('usernameRef must be the ID input field ref')
        let origin: string
        try {
          origin = new URL(page.url).origin
        } catch {
          throw new Error('The page URL is unknown')
        }
        const entry = (await this.vault?.findForOrigin(origin)) ?? (await this.siteLogin?.(tabId, origin))
        if (!entry)
          throw new Error(
            `This site (${origin}) is not in the Dool2 vault. Show the user a login card with browser_request_login and end this reply.`,
          )
        // The extension checks the URL again too (if it moved to another page meanwhile, nothing is filled)
        if (userRef) await this.browser.call('fill', { tabId, ref: userRef, value: entry.username, origin })
        const put = (await this.browser.call('fill', {
          tabId,
          ref: String(a.passwordRef),
          value: entry.password,
          origin,
          password: true,
        })) as { length?: number } | undefined
        // If it is a secure keypad field that blocks key input, press the on-screen keypad buttons (the value never goes to the AI)
        // (measured 11-21 Shinhan Card: signup worked with the keypad, but the login screen did not take the vault password, so login was blocked)
        let keypad = false
        if (typeof put?.length === 'number' && put.length !== entry.password.length)
          keypad = await this.keypadType(tabId, String(a.passwordRef), entry.password)
        await this.vault?.markUsed(entry.id)
        this.loginTries.set(tabId, { origin, entryId: entry.id })
        this.onVaultLogin?.(tabId, page.url)
        return this.read(
          tabId,
          undefined,
          keypad
            ? 'Filled the login from the Dool2 vault (the password was entered with the on-screen secure keypad). Press the login button.'
            : 'Filled the login from the Dool2 vault. Press the login button.',
        )
      }
      case 'dialog': {
        // Chooses in a site confirm dialog (confirm, prompt). If [OK] means paying, sending or deleting, approval is needed
        const d = this.dialogs.get(tabId)
        if (!d) throw new Error('No site confirm dialog is open. Read the page again (browser_read) to check')
        const accept = a.accept !== false
        if (accept) {
          const risk = classifyDialogRisk(d.message, this.userLang())
          // A confirm asked by the payment company window inside a payment group is the same payment. If several items were approved at once,
          // each item's confirm dialog ("delete this?") is not asked either (the button already used one)
          if (risk && !this.inProvider(tabId, d.url) && !this.useSeries(d.url, risk.kind, false))
            throw new Error(
              this.finalStep() === 'self'
                ? `${GATE_STOP}: ${risk.reason} — this is ${RISK_TEXT[risk.kind]}, so Dool2 does not press [OK]. The user chose "press the final button myself". Sum up what is prepared so far (what, where, how much), tell the user, and end this reply.`
                : `${GATE_STOP}: ${risk.reason} — this is ${RISK_TEXT[risk.kind]}. Show an approval card with browser_request_approval(dialog: true, what, where, how much). Once approved, Dool2 presses [OK].`,
            )
        }
        await this.browser.call('dialog', {
          tabId,
          accept,
          expect: d.message,
          ...(d.type === 'prompt' && typeof a.text === 'string' ? { text: a.text.slice(0, 500) } : {}),
        })
        this.dialogs.delete(tabId)
        return this.read(
          tabId,
          undefined,
          `Pressed [${accept ? 'OK' : 'Cancel'}] in the site confirm dialog.`,
        )
      }
      case 'checkout': {
        // Payment card (user design 11-20): one approval for the one final button on the checkout screen. Goods, amount, delivery, payment method and info on one card
        const page = this.pages.get(tabId)
        if (!page) throw new Error('Read the checkout screen first')
        const ref = String(a.ref ?? '')
        if (!page.refs.has(ref))
          throw new Error(`No ${ref} ref. Read the checkout screen again and point at the final button`)
        // Whether it is a checkout screen is decided by the AI looking at the screen: when asked for a card, show it (asking is always safe).
        // (before, checkout marks were searched with regexes and the card was refused when not found — measured 11-20 the card did not show on a Gmarket order sheet)
        const str = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '')
        const list = <T>(v: unknown, n: number, f: (x: Record<string, unknown>) => T | undefined): T[] =>
          (Array.isArray(v) ? v : [])
            .slice(0, n)
            .map((x) => (x && typeof x === 'object' ? f(x as Record<string, unknown>) : undefined))
            .filter((x): x is T => x !== undefined)
        const goods = list(a.goods, 20, (g) =>
          str(g.name, 80)
            ? {
                name: str(g.name, 80),
                ...(str(g.option, 80) ? { option: str(g.option, 80) } : {}),
                ...(str(g.qty, 20) ? { qty: str(g.qty, 20) } : {}),
                ...(str(g.price, 30) ? { price: str(g.price, 30) } : {}),
                ...(/^https:\/\//.test(str(g.image, 800)) ? { image: str(g.image, 800) } : {}),
              }
            : undefined,
        )
        const lines = list(a.lines, 10, (l) =>
          str(l.label, 24) && str(l.value, 30)
            ? {
                label: str(l.label, 24),
                value: str(l.value, 30),
                ...(l.kind === 'discount' || l.kind === 'fee' || l.kind === 'point'
                  ? { kind: l.kind as 'discount' | 'fee' | 'point' }
                  : {}),
              }
            : undefined,
        )
        // Mobile numbers get the middle masked (cards and records never keep the full number)
        const maskTel = (v: string) =>
          v.replace(/\b(01[016789])[-\s.]?(\d{3,4})[-\s.]?(\d{4})\b/g, (_m, a1, _b, c) => `${a1}-****-${c}`)
        const info = list(a.info, 8, (l) =>
          str(l.label, 16) && str(l.value, 160)
            ? { label: str(l.label, 16), value: maskTel(str(l.value, 160)) }
            : undefined,
        )
        const choices = Array.isArray(a.choices) ? (a.choices as unknown[]).map(String) : []
        const chose = Array.isArray(a.chose)
          ? (a.chose as unknown[])
              .map((c) => String(c ?? '').slice(0, 60))
              .filter(Boolean)
              .slice(0, 8)
          : []
        const title = str(a.title, 60)
        return this.askApproval(
          tabId,
          ref,
          {
            what:
              str(a.what, 200) ||
              [title, goods.map((g) => g.name).join('·')].filter(Boolean).join(' · ') ||
              browserText(this.userLang()).payWhat,
            where: str(a.where, 100) || title,
            ...(str(a.total, 60) ? { amount: str(a.total, 60) } : {}),
            ...(str(a.cancel, 200) ? { cancel: str(a.cancel, 200) } : {}),
            ...(choices.length
              ? {
                  choices,
                  choiceTitle: str(a.choiceTitle, 20) || browserText(this.userLang()).payMethodTitle,
                }
              : {}),
            ...(chose.length ? { chose } : {}),
            ...(str(a.ship_to, 120)
              ? {
                  shipTo: str(a.ship_to, 120),
                  shipOptions: (Array.isArray(a.ship_options) ? a.ship_options : [])
                    .map((x) =>
                      String(x ?? '')
                        .trim()
                        .slice(0, 120),
                    )
                    .filter((x) => x && x !== str(a.ship_to, 120))
                    .slice(0, 5),
                }
              : {}),
            checkout: {
              ...(title ? { title } : {}),
              ...(str(a.after, 120) ? { after: str(a.after, 120) } : {}),
              goods,
              lines,
              info,
            },
          },
          'money',
        )
      }
      case 'request_approval': {
        if (a.dialog === true)
          return this.askDialogApproval(tabId, {
            what: String(a.what ?? ''),
            where: String(a.where ?? ''),
            ...(a.amount ? { amount: String(a.amount) } : {}),
            ...(a.cancel ? { cancel: String(a.cancel) } : {}),
          })
        const ref = String(a.ref ?? '')
        // Approval requests are never refused: asking the user is always safe (the AI judges which step the button belongs to)
        const choices = Array.isArray(a.choices)
          ? (a.choices as unknown[]).map((c) =>
              typeof c === 'string' ? c : String((c as { ref?: unknown })?.ref ?? ''),
            )
          : []
        const chose = Array.isArray(a.chose)
          ? (a.chose as unknown[])
              .map((c) => String(c ?? '').slice(0, 60))
              .filter(Boolean)
              .slice(0, 8)
          : []
        return this.askApproval(tabId, ref, {
          what: String(a.what ?? ''),
          where: String(a.where ?? ''),
          ...(a.amount ? { amount: String(a.amount) } : {}),
          ...(a.cancel ? { cancel: String(a.cancel) } : {}),
          ...(choices.length
            ? {
                choices,
                choiceTitle: String(a.choiceTitle ?? browserText(this.userLang()).payMethodTitle).slice(
                  0,
                  20,
                ),
              }
            : {}),
          ...(chose.length ? { chose } : {}),
          ...(Number(a.count) > 1 ? { count: Number(a.count) } : {}),
          ...(typeof a.ship_to === 'string' && a.ship_to.trim()
            ? {
                shipTo: a.ship_to.trim().slice(0, 120),
                shipOptions: (Array.isArray(a.ship_options) ? a.ship_options : [])
                  .map((x) =>
                    String(x ?? '')
                      .trim()
                      .slice(0, 120),
                  )
                  .filter((x) => x && x !== String(a.ship_to).trim())
                  .slice(0, 5),
              }
            : {}),
        })
      }
      case 'upload':
        return this.upload(tabId, a)
      case 'fill_profile': {
        // My info (booker and orderer fields): the AI names only the fields and items; the daemon checks the URL and hands the values straight to the extension
        const page = this.pages.get(tabId)
        if (!page) throw new Error('Read the page first')
        if (!this.profile) throw new Error('My info is not available')
        let origin: string
        try {
          origin = new URL(page.url).origin
        } catch {
          throw new Error('The page URL is unknown')
        }
        const asks = Array.isArray(a.fields) ? (a.fields as { ref?: unknown; key?: unknown }[]) : []
        if (!asks.length) throw new Error('Tell me the fields to fill (fields: [{ref, key}])')
        const p = await this.profile.get()
        const done: string[] = []
        const cut: string[] = []
        const missing = new Set<ProfileField>()
        let askedSecret = ''
        for (const x of asks.slice(0, 20)) {
          const ref = String(x.ref ?? '')
          // Back digits of the resident registration number: never kept in my info. Received only then with a masked phone card, and the daemon puts them in the field (the AI never sees the value)
          if (x.key === 'rrn_back' && !p.rrn_back) {
            const t = page.refs.get(ref)
            if (!t || !([ROLE.input, ROLE.searchBox, ROLE.password] as string[]).includes(t.role))
              throw new Error(`${ref} is not a text field`)
            let host = ''
            try {
              host = new URL(page.url).hostname
            } catch {}
            const id = this.requestCode?.(
              tabId,
              t.name,
              browserText(this.userLang()).rrnBack,
              '',
              host,
              'rrn_back',
              ref,
            )
            if (!id) throw new Error('Could not show the resident number back digits card')
            // Keep the tab open until the user enters it on the card (ending the reply cleans up working tabs)
            this.hold(tabId, 10 * 60_000)
            askedSecret = t.name
            continue
          }
          const key = String(x.key ?? '') as ProfileKey
          if (!(PROFILE_KEYS as readonly string[]).includes(key))
            throw new Error(`${key} is not a my-info item. Available: ${PROFILE_KEYS.join(', ')}`)
          if (key === 'auth_app' || key === 'carrier')
            throw new Error(
              `${key === 'carrier' ? 'The mobile carrier' : 'The authenticator app'} is not typed into a field; choose it from the button or list with that name (the exact name from my info in the result)`,
            )
          const role = page.refs.get(ref)?.role ?? ''
          if (
            !([ROLE.input, ROLE.searchBox] as string[]).includes(role) &&
            !(key === 'rrn_back' && role === ROLE.password)
          )
            throw new Error(`${ref} is not a text field`)
          const value = profileValue(p, key)
          if (!value) {
            for (const f of sourceOf(key)) if (!p[f]) missing.add(f)
            continue
          }
          const r = (await this.browser.call('fill', {
            tabId,
            ref,
            value,
            origin,
            trust: AUTH_FRAME_SITES,
          })) as { length?: number }
          // If the field limits length (maxlength), the value gets cut: tell the AI to fill it again in another format
          // The field counts only letters and digits (separators differ by field): compare on the same basis
          const want = value.replace(/[^0-9A-Za-z\uAC00-\uD7A3]/g, '').length
          if (typeof r?.length === 'number' && r.length >= 0 && r.length < want)
            cut.push(`${ref}(${key}): only ${r.length} of ${want} characters went in`)
          const shown = sourceOf(key)
            .map((f) => (p[f] ? maskValue(f, p[f] as string) : ''))
            .join(' ')
          done.push(`${PROFILE_FIELDS[sourceOf(key)[0] as ProfileField].label}(${shown})`)
        }
        // For an identity check window, which app to press: the authenticator app in my info (if none, get it with a card)
        const identity = asks.some((x) => /^(name|birth|phone)/.test(String(x.key ?? '')))
        const lines = [
          done.length ? `Filled from my info: ${done.join(', ')}.` : '',
          askedSecret
            ? `The resident number back digits are not in my info, so they are being collected once with the phone secure keypad (field "${askedSecret}", saved to the vault when received). Tell the user in one sentence "Enter your resident number back digits on the card on your phone" and end this reply. A notification comes when it goes in.`
            : '',
          cut.length
            ? `Some fields got cut — ${cut.join('; ')}. Sent like this, a different number or date goes out. Fill again in the format that field takes: a mobile field with the prefix (010) chosen separately takes phone_rest (last 8 digits), three mobile fields take phone_head, phone_mid, phone_last, a 6-digit birth date takes birth6, digits-only fields take phone_digits or birth_digits.`
            : '',
          identity && p.auth_app
            ? `For an identity check window, press the default authenticator app in my info '${p.auth_app}' and press through [request verification]. If that site's window has no '${p.auth_app}', get the app to use this time with browser_request_profile(fields: ["auth_app"], options: the app names shown in that window).`
            : identity
              ? 'For an identity check window, my info has no authenticator app. Do not ask in chat; let the user choose with browser_request_profile(fields: ["auth_app"], options: the app names shown in that window).'
              : '',
          identity && p.carrier
            ? `If there is a field to choose the mobile carrier, choose '${p.carrier}' from my info.`
            : identity
              ? 'If there is a field to choose the mobile carrier, do not ask in chat; get it with browser_request_profile(fields: ["carrier"]) (once entered, Dool2 chooses it from then on).'
              : '',
          missing.size
            ? `My info has no ${[...missing].map((f) => PROFILE_FIELDS[f].label).join('·')}. Do not ask the user; show the my-info card with browser_request_profile, then end the reply.`
            : '',
        ].filter(Boolean)
        return this.read(tabId, undefined, lines.join(' '))
      }
      case 'select': {
        // Dropdown list (product options, select box): without choose, show the list; with it, choose by that text
        const page = this.pages.get(tabId)
        if (!page) throw new Error('Read the page first')
        const ref = String(a.ref ?? '')
        if (!page.refs.has(ref)) throw new Error(`No ${ref} ref. Read the page again`)
        const list = await this.selectOptions(tabId, ref)
        if (!list?.length)
          throw new Error(
            `Could not read the ${ref} list. Open that field with browser_click, read the page, and press the visible item with browser_click.`,
          )
        const labels = list.map((o) => o.label)
        // Payment method and installment lists are not refused either: if the user already chose, choose it; if not, the AI decides whether to let them choose on the payment card
        const want = typeof a.choose === 'string' ? a.choose.trim() : ''
        if (!want) {
          const lines = list.map(
            (o, i) =>
              `${i + 1}. ${o.label}${o.selected ? ' ✓(chosen now)' : ''}${SOLD_OUT_WORDS.test(o.label) ? ' — cannot be chosen' : ''}`,
          )
          return {
            content: [
              {
                type: 'text',
                text: `${tabTag(tabId)} ${ref} list (${list.length})\n${lines.join('\n')}\n\nTo choose, put the item text in browser_select's choose (the option the user named, else the remembered size or color).`,
              },
            ],
          }
        }
        const hit = matchOption(labels, want)
        if (!hit)
          throw new Error(
            `"${want}" is not in the list or resembles several items. List: ${labels.slice(0, 20).join(' · ')}. If none fits, ask the user which one.`,
          )
        if (SOLD_OUT_WORDS.test(hit))
          throw new Error(
            `"${hit}" is sold out. Tell the user and ask for another option (and a restock alert if they want one).`,
          )
        await this.browser.call('choose', { tabId, ref, label: hit }, 20_000)
        return this.read(
          tabId,
          undefined,
          `Chose "${hit}" in the ${ref} list. If there are more options, choose them the same way; when done, check quantity and amount.`,
        )
      }
      case 'new_password': {
        // Signup or password change: make and enter a strong password. It goes into the vault only after the screen shows it finished. The AI never gets the value
        const page = this.pages.get(tabId)
        if (!page) throw new Error('Read the page first')
        let origin: string
        try {
          origin = new URL(page.url).origin
        } catch {
          throw new Error('The page URL is unknown')
        }
        const purpose = a.purpose === 'reset' ? 'reset' : 'signup'
        const pwRef = String(a.password ?? a.ref ?? '')
        const confirmRef = a.confirm ? String(a.confirm) : ''
        if (!pwRef) throw new Error('Tell me the field for the new password (password: ref)')
        for (const r of [pwRef, confirmRef].filter(Boolean)) {
          const c = page.refs.get(r)
          const role = c?.role ?? ''
          // Password fields only (text inputs only when the name says password — never into coupon or search fields)
          const looksPw =
            role === ROLE.password || (role === ROLE.input && PASSWORD_FIELD_NAME.test(c?.name ?? ''))
          if (!looksPw) throw new Error(`${r} is not a password field. Read the page again`)
        }
        // Creating a real account or changing a password: only on sites the user chose (instructions alone cannot prevent it)
        const key = siteKey(origin)
        if (!this.signupAllowed(key)) {
          // The card shows the service name (the connector name if there is one, else the address)
          const name = (await this.siteConnector?.(page.url).catch(() => undefined))?.name ?? key
          const said = this.askSignup?.(name, key, purpose, this.pwNeedOwn.has(key))
          if (said === 'ok') this.allowSignup(key)
          else if (said === 'asked')
            return {
              content: [
                {
                  type: 'text',
                  text:
                    purpose === 'reset'
                      ? `Asked on the user's phone whether to set a new ${name} password. Nothing has been entered yet. End this reply briefly with "please choose on your phone". You will be told to carry on once they choose.`
                      : `Asked on the user's phone whether to sign up for ${name} (or whether they already have an account). Nothing has been entered yet. End this reply briefly with "please choose on your phone". You will be told to carry on once they choose.`,
                },
              ],
            }
          else
            throw new Error(
              'Signup and password change happen only after the user chooses. Ask the user "log in or sign up?" first.',
            )
        }
        // ID (email): the one the AI chose, else the email in my info
        let username = String(a.username ?? '').trim()
        if (!username && this.profile) username = profileValue(await this.profile.get(), 'email') ?? ''
        if (!username)
          throw new Error(
            'Tell me which ID to sign up or change with (username). If my info has no email, get it with browser_request_profile.',
          )
        // Check the length that actually went into the field: if the field limits length (maxlength), it gets cut,
        // and the vault value and the site password differ. Make it again to fit that length
        const fill = async (ref: string, value: string) => {
          const r = (await this.browser.call('fill', { tabId, ref, value, origin, password: true })) as
            | { length?: number }
            | undefined
          return typeof r?.length === 'number' ? r.length : undefined
        }
        // If the user set it on the phone, use that value (ask again if it does not fit)
        const own = this.ownPw.get(key)
        let pw = own ?? makePassword()
        let got = await fill(pwRef, pw)
        if (own && got !== undefined && got !== pw.length) {
          this.ownPw.delete(key)
          this.disallowSignup(key)
          throw new Error(
            `The password the user set did not fully fit in this field (only ${got} characters went in). Read the password rules on screen (length, symbols), tell the user in one line, and call browser_new_password again (they choose again on the phone).`,
          )
        }
        // If the field does not take the generated password as is, do not hand off to the person; ask again on the phone (the user can set one that fits the rules)
        const askAgain = (why: string) => {
          this.disallowSignup(key)
          // Calling again does not enter the same thing again; the user sets it on the phone (before, 'sign me up' was taken as consent and the same failure repeated)
          this.pwNeedOwn.add(key)
          return new Error(
            `${why} Read the password rules on screen (length, allowed characters), tell the user in one line, and call browser_new_password again. Calling again asks on the phone so the user can set a password that fits the rules.`,
          )
        }
        // Secure keypad fields that block both pasting and typing: press the on-screen keypad buttons by their labels (the value never goes to the AI)
        let viaKeypad = false
        if (got !== undefined && got !== pw.length && !own) {
          const kp = makeKeypadPassword()
          if (await this.keypadType(tabId, pwRef, kp)) {
            pw = kp
            got = kp.length
            viaKeypad = true
            if (confirmRef && !(await this.keypadType(tabId, confirmRef, kp)))
              throw askAgain('Could not press the secure keypad of the confirm password field.')
          }
        }
        if (got !== undefined && got !== pw.length) {
          if (got < 8)
            throw askAgain('This field does not take the entered password as is (characters were dropped).')
          pw = makePassword(got)
          got = await fill(pwRef, pw)
          if (got !== undefined && got !== pw.length)
            throw askAgain('This field does not take the entered password as is (it may strip symbols).')
        }
        if (confirmRef && !viaKeypad) {
          const c = await fill(confirmRef, pw)
          if (c !== undefined && c !== pw.length)
            throw new Error(
              'The confirm password field did not get the full value. Read the page again, check the confirm field ref is right, and call browser_new_password again.',
            )
        }
        // Not in the vault yet: it goes in once the screen shows signup finished (so a wrong value is not left after failure or "already registered")
        this.ownPw.delete(key)
        this.pwNeedOwn.delete(key)
        this.pendingPw = this.pendingPw.filter((p) => p.key !== key)
        this.pendingPw.push({ key, origin, username, password: pw, purpose, at: Date.now() })
        return this.read(
          tabId,
          undefined,
          `${own ? 'Entered the password the user set' : 'Made a new password and entered it'} (${pw.length} characters) in "${pwRef}"${confirmRef ? `·"${confirmRef}"` : ''} (${username}). ` +
            'You never get the password. Fill the other fields and press the signup or change button. When the done screen shows, Dool2 saves it to the vault and tells you. ' +
            'If it breaks the password rules (length, symbols), tell the user.',
        )
      }
      case 'request_code': {
        // Verification code: the daemon puts the number the user entered on the phone card straight into the field. The AI never sees the number
        const page = this.pages.get(tabId)
        if (!page) throw new Error('Read the page first')
        const ref = String(a.ref ?? '')
        // Payment PIN keypad (digits are images, buttons in shuffled spots): the AI looks at the screen and maps digits → button refs,
        // and the user enters it on the phone secure keypad. The daemon presses in that order — the AI never sees the PIN
        if (a.kind === 'pin' && a.box && typeof a.box === 'object') {
          // Image keypad not exposed as buttons (measured 11-22 Donghaeng Lottery K bank quick top-up): crop and show the keypad box,
          // and let the AI point at the spots of digits 0~9 in the image. The user enters it on the phone secure keypad and the daemon presses those spots
          const at = (a.keys_at && typeof a.keys_at === 'object' ? a.keys_at : {}) as Record<string, unknown>
          const kept = this.pinShots.get(tabId)
          if (!Object.keys(at).length || !kept) {
            const got = (await this.browser
              .call('element-shots', { tabId, refs: [], boxes: [a.box] }, 30_000)
              .catch(() => undefined)) as
              | { shots?: { data: string; rect?: { x: number; y: number; w: number; h: number } }[] }
              | undefined
            const shot = got?.shots?.[0]
            if (!shot?.rect || shot.rect.w < 60 || shot.rect.h < 60)
              throw new Error(
                'Could not capture the keypad, or it is too small. Look at the screen with browser_screenshot and point again with a box (0~1000 of the screen) that holds the whole number keypad',
              )
            this.pinShots.set(tabId, { rect: shot.rect, at: Date.now() })
            return {
              content: [
                {
                  type: 'text',
                  text: 'Cropped the keypad. Point at the center of the 0~9 buttons in the image with keys_at({"0":[x,y],"1":[x,y],…}, 0~1000 of this image) and call again with the same box. Each of 0~9 must be there once. Do not include delete or shuffle. Do not hand the screen to the user.',
                },
                { type: 'image', data: shot.data, mimeType: 'image/jpeg' },
              ],
            }
          }
          const points: Record<string, PinKey> = {}
          for (const d of '0123456789') {
            const v = at[d]
            const xy = Array.isArray(v) ? v.map(Number) : []
            const [px, py] = xy
            if (
              px === undefined ||
              py === undefined ||
              !Number.isFinite(px) ||
              !Number.isFinite(py) ||
              px < 0 ||
              px > 1000 ||
              py < 0 ||
              py > 1000
            )
              throw new Error(
                `No spot for digit ${d}. Point at the center of every 0~9 button in the cropped image as [x, y] (0~1000) in keys_at.`,
              )
            points[d] = {
              x: Math.round(kept.rect.x + (px / 1000) * kept.rect.w),
              y: Math.round(kept.rect.y + (py / 1000) * kept.rect.h),
            }
          }
          const spots = new Set(
            Object.values(points).map((p) =>
              typeof p === 'object' ? `${Math.round(p.x / 8)},${Math.round(p.y / 8)}` : p,
            ),
          )
          if (spots.size !== 10)
            throw new Error(
              'Two digits point at the same spot. Look at the image again and point at a different button for each of 0~9.',
            )
          if (!this.requestPin)
            throw new Error(
              'The phone keypad card cannot be shown right now (no phone connection). Tell the user in one line to check the Dool2 app connection on the phone, and end this reply.',
            )
          let host = ''
          try {
            host = new URL(page.url).hostname
          } catch {}
          const len = Math.min(Math.max(Number(a.length) || 6, 4), 8)
          const id = this.requestPin(
            tabId,
            String(a.label ?? '') || browserText(this.userLang()).payPin,
            host,
            points,
            len,
          )
          if (!id) throw new Error('Could not show the keypad card')
          this.pinShots.delete(tabId)
          this.hold(tabId, 10 * 60_000)
          return {
            content: [
              {
                type: 'text',
                text: `Showed a secure keypad card on the phone (${len} digits). Tell the user in one sentence, like "enter your PIN on the keypad on your phone", and end this reply. Once entered, the daemon presses the on-screen keypad and tells you in the next message.`,
              },
            ],
          }
        }
        if (a.kind === 'pin') {
          const keys = (a.keys && typeof a.keys === 'object' ? a.keys : {}) as Record<string, unknown>
          // Before pointing: crop each keypad button (key_refs) and let the AI read the digit on each.
          // Matching spots on one screenshot is error-prone (measured Coupang: the PIN came out wrong)
          if (!Object.keys(keys).length) {
            const list = (Array.isArray(a.key_refs) ? a.key_refs : [])
              .map(String)
              .filter((r) => page.refs.has(r))
            if (list.length < 10)
              throw new Error(
                'Call again with every keypad button ref in key_refs (the 10 digit buttons; delete and others may be included). Each button gets cropped and shown. If the keypad is an image not exposed as buttons, look with browser_screenshot and point at the whole keypad box with box (0~1000 of the screen) using kind: "pin" — do not hand the screen to the user or use the tap-to-solve card.',
              )
            const got = (await this.browser
              .call('element-shots', { tabId, refs: list }, 30_000)
              .catch(() => undefined)) as { shots?: { ref: string; data: string }[] } | undefined
            const shots = got?.shots ?? []
            if (shots.length < 10)
              throw new Error('Could not capture the keypad buttons. Read the page again and call again')
            return {
              content: [
                {
                  type: 'text',
                  text: 'Cropped each keypad button. Read the digit shown in each image, put them in keys({"0":"e…","1":"e…",…}) and call again with the same field. Do not include non-digit buttons (delete, shuffle). Each of 0~9 must be there once.',
                },
                ...shots.flatMap((sh) => [
                  { type: 'text' as const, text: sh.ref },
                  { type: 'image' as const, data: sh.data, mimeType: 'image/jpeg' },
                ]),
              ],
            }
          }
          const map: Record<string, string> = {}
          for (const d of '0123456789') {
            const r = String(keys[d] ?? '')
            if (!page.refs.has(r))
              throw new Error(
                `No button ref for digit ${d}. Point at every 0~9 in the cropped images and put them in keys.`,
              )
            map[d] = r
          }
          // One button mapped to two digits means a misread (pressing it would give a wrong PIN and could lock the account)
          if (new Set(Object.values(map)).size !== 10)
            throw new Error(
              'The same button is mapped to two digits. Look at the cropped images again and map 0~9 to different buttons.',
            )
          if (!this.requestPin)
            throw new Error(
              'The phone keypad card cannot be shown right now (no phone connection). Tell the user in one line to check the Dool2 app connection on the phone, and end this reply.',
            )
          let host = ''
          try {
            host = new URL(page.url).hostname
          } catch {}
          const len = Math.min(Math.max(Number(a.length) || 6, 4), 8)
          const id = this.requestPin(
            tabId,
            String(a.label ?? '') || browserText(this.userLang()).payPin,
            host,
            map,
            len,
          )
          if (!id) throw new Error('Could not show the keypad card')
          this.hold(tabId, 10 * 60_000)
          return {
            content: [
              {
                type: 'text',
                text: `Showed a ${len}-digit secure keypad card on the phone. Tell the user in one sentence, like "enter your payment PIN on the keypad on your phone", and end this reply. Once entered, Dool2 presses the mapped buttons in order and tells you. Then read the screen and carry on, and when the order complete screen and order number show, finish with browser_order_done.`,
              },
            ],
          }
        }
        if (!this.requestCode)
          throw new Error(
            'The phone verification code card cannot be shown right now (no phone connection). Tell the user in one line to check the Dool2 app connection on the phone, and end this reply.',
          )
        const target = page.refs.get(ref)
        if (!target || !([ROLE.input, ROLE.searchBox] as string[]).includes(target.role))
          throw new Error(
            `${ref} is not a field for a verification code. Read the page again and check the field ref`,
          )
        // CAPTCHA: crop around the field, show the AI, and put the image the AI picked (pick) on the card (picking the image is not done by rules)
        let image: string | undefined
        if (a.kind === 'captcha') {
          const got = (await this.browser
            .call('captcha-candidates', { tabId, ref }, 30_000)
            .catch(() => undefined)) as { shots?: { what: string; data: string }[] } | undefined
          const shots = got?.shots ?? []
          const pick = Number(a.pick)
          if (!Number.isInteger(pick) || pick < 1 || pick > shots.length) {
            if (!shots.length)
              throw new Error(
                'Could not capture images around the field. Look at the screen with browser_screenshot and point at the field again',
              )
            return {
              content: [
                {
                  type: 'text',
                  text: `Cropped ${shots.length} images around the CAPTCHA field (${ref}). Pick the number of the image where the distorted letters and digits are all clearly visible, and call browser_request_code again on the same field with kind: "captcha", pick: number. If none shows the CAPTCHA, look at the screen with browser_screenshot and point at the field again. Do not read and type the characters yourself; get them from the user.`,
                },
                ...shots.flatMap((sh, i) => [
                  { type: 'text' as const, text: `${i + 1}. ${sh.what}` },
                  { type: 'image' as const, data: sh.data, mimeType: 'image/jpeg' },
                ]),
              ],
            }
          }
          image = shots[pick - 1]?.data
        }
        // One guidance line from the screen ("enter the 6 digits sent to your phone")
        const snap = (await this.browser
          .call('snapshot', { tabId, maxChars: 12_000 })
          .catch(() => undefined)) as { text?: string } | undefined
        const hint =
          (snap?.text ?? '')
            .split('\n')
            .map((l: string) =>
              l
                .replace(/\[[^\]]*\]/g, '')
                .replace(/^\s*(#+|[-*•]|\d+\.)\s*/, '')
                .trim(),
            )
            .find((l: string) => l.length >= 8 && l.length <= 80 && CODE_HINT_WORDS.test(l)) ?? ''
        let host = ''
        try {
          host = new URL(page.url).hostname
        } catch {}
        const id = this.requestCode(
          tabId,
          target.name,
          String(a.label ?? '') || target.name || browserText(this.userLang()).codeLabel,
          hint,
          host,
          a.kind === 'rrn_back' ? 'rrn_back' : a.kind === 'captcha' ? 'captcha' : 'code',
          ref,
          image,
        )
        if (!id) throw new Error('Could not show the verification code card')
        // Keep the tab open until the user enters it on the card
        this.hold(tabId, 10 * 60_000)
        return {
          content: [
            {
              type: 'text',
              text: 'Showed a verification code card on the phone. Tell the user in one sentence, like "enter the code you received on the card", and end this reply. When the code goes into the field, you are told in the next message. Then press [OK] and carry on.',
            },
          ],
        }
      }
      case 'request_tap': {
        // Tap-to-solve image: crop just that box and send it to the phone, then tap where the user tapped (the PC screen is not handed to the person)
        if (!this.requestTap) throw new Error('The image card cannot be shown')
        const page = this.pages.get(tabId)
        if (!page) throw new Error('Read the page first')
        // Images often have no ref: the ref's spot if there is one, else a box pointed at on the screenshot (box, 0~1000)
        const ref = a.ref ? String(a.ref) : ''
        const box = a.box && typeof a.box === 'object' ? (a.box as Record<string, unknown>) : undefined
        if (ref && !page.refs.has(ref))
          throw new Error(
            `No ${ref} ref. Images often have no ref. Look at the screen with browser_screenshot and point with box (0~1000 of the screen) at a box that holds the whole puzzle image or map`,
          )
        if (!ref && !box)
          throw new Error(
            'Look at the screen with browser_screenshot and point generously at a box holding the whole puzzle text, image or map with box: {x, y, w, h} (screen top-left 0, right and bottom edge 1000)',
          )
        const got = (await this.browser
          .call('element-shots', ref ? { tabId, refs: [ref] } : { tabId, refs: [], boxes: [box] }, 30_000)
          .catch(() => undefined)) as
          | { shots?: { ref: string; data: string; rect?: { x: number; y: number; w: number; h: number } }[] }
          | undefined
        const shot = got?.shots?.[0]
        if (!shot?.rect || shot.rect.w < 40 || shot.rect.h < 40)
          throw new Error(
            'Could not capture that spot, or it is too small. Look at the screen with browser_screenshot and point again with a box that holds the whole puzzle image',
          )
        let host = ''
        try {
          host = new URL(page.url).hostname
        } catch {}
        const say =
          String(a.say ?? '')
            .trim()
            .slice(0, 80) || browserText(this.userLang()).tapSay
        const taps = Math.min(9, Math.max(1, Math.round(Number(a.taps) || 1)))
        const id = this.requestTap(tabId, say, host, shot.data, shot.rect, taps)
        if (!id) throw new Error('Could not show the image card')
        this.hold(tabId, 10 * 60_000)
        return {
          content: [
            {
              type: 'text',
              text: 'Showed an image card on the phone. Tell the user in one sentence, like "tap the right spot in the image on the phone card", and end this reply. Once tapped, Dool2 taps the same spot on the PC screen and tells you in the next message. Then read the screen again and press [OK] or [Submit] to carry on.',
            },
          ],
        }
      }
      case 'request_profile': {
        if (!this.profile || !this.requestProfile) throw new Error('The my-info card cannot be shown')
        const all = Object.keys(PROFILE_FIELDS) as ProfileField[]
        const asked = (Array.isArray(a.fields) ? a.fields : [])
          .map(String)
          .filter((f): f is ProfileField => all.includes(f as ProfileField))
        const { missing } = await this.profile.masked()
        // Resident number back digits are collected separately with the secure keypad at the identity check field (not in the my-info card's default list)
        const fields = asked.length
          ? asked.filter((f) => f !== 'rrn_back')
          : missing.filter((f) => f !== 'rrn_back')
        if (!fields.length) throw new Error('My info is complete. Fill with browser_fill_profile')
        const options = (Array.isArray(a.options) ? a.options : [])
          .map((o) => String(o).trim().slice(0, 20))
          .filter(Boolean)
        const id = this.requestProfile(fields, String(a.reason ?? '').slice(0, 120), options)
        if (!id) throw new Error('Could not show the my-info card')
        return {
          content: [
            {
              type: 'text',
              text:
                `Showed the my-info card (${fields.map((f) => PROFILE_FIELDS[f].label).join('·')}). While the card waits for an answer, finish now what works without this info (checking eligibility, researching prices and candidates, reading documents, candidates based on Seoul, a prep list), put the results in the reply, and end it with one sentence like "enter it on the card once and I'll fill it in myself from then on". Do not end with only a note about the card. ` +
                'Entered values are stored only in the PC vault and you get only masked values. You are told in the next message once saved. Then fill with browser_fill_profile.',
            },
          ],
        }
      }
      case 'request_login': {
        // Login card: values the user enters on the PC or phone card go only into the vault. The AI never sees them
        const page = this.pages.get(tabId)
        if (!page) throw new Error('Read the login page first')
        let origin: string
        try {
          origin = new URL(page.url).origin
        } catch {
          throw new Error('The page URL is unknown')
        }
        const local = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin)
        if (!origin.startsWith('https://') && !local)
          throw new Error(
            'This address is not encrypted (https), so login details are not taken into the vault. Try reopening the same service at an https address; if there is none, tell the user in one line that this site is not encrypted so Dool2 cannot handle its login.',
          )
        // Values received by card that failed to log in were already removed. Values not yet confirmed can be received again
        if ((await this.vault?.findForOrigin(origin)) && !this.unverified.has(origin))
          return {
            content: [
              { type: 'text', text: 'This site is already in the Dool2 vault. Fill with browser_login.' },
            ],
          }
        // If the service is connected (vault account, social login), the daemon logs in again without asking the person
        // (measured 11-22 Korean Air: when the session expired, it showed a login card first even though it was connected via Naver)
        const relogin = await this.reloginFor?.(origin).catch(() => undefined)
        if (relogin)
          return {
            content: [
              {
                type: 'text',
                text: `This site has a connected way in (a vault account or a social login used before), so no login card was shown. Call connect_ask("${relogin}") and the Dool2 daemon logs in again without a card and tells you when done. Say only one sentence to the user, like "I'll log in again and carry on".`,
              },
            ],
          }
        const site =
          String(a.site ?? '')
            .trim()
            .slice(0, 60) || new URL(origin).hostname
        const r = this.logins.create({ tabId, origin, site })
        return {
          content: [
            {
              type: 'text',
              text:
                `Showed a login card (${r.id.slice(0, 8)}). Tell the user in one or two sentences to enter their ${site} ID and password on the card, and end this reply. ` +
                'Entered values are stored only in the Dool2 vault and never come to you. You are told in the next message once saved. Then read the page again, fill with browser_login and press the login button.',
            },
          ],
        }
      }
      case 'wait_auth': {
        // Waiting for an authenticator approval: handing off to the person and waiting for [done] lets the verification expire meanwhile (measured).
        // Notify the phone and press [verification done] every few seconds to see whether it was approved. Text like "not signed" means not yet.
        // Some sites (Hometax) open the verification window as a popup (new tab), so tabs Dool2 opened recently are checked too
        const am = browserText(this.userLang())
        const msg = String(a.message ?? '').trim() || am.authBody
        this.notifyUser?.(am.authTitle, msg)
        // Only keep the tab open. No phone remote screen prep (holdForPerson) — the screen changed and closed the verification window (measured)
        this.hold(tabId, 200_000)
        // Done or not yet is not decided by text rules (guidance like "…please proceed" was read as not yet and only showed the card again and again, measured K-Pass).
        // When the screen changes structurally (URL, confirm dialog, verification window closed, buttons changed) or the user presses [I've verified], the screen goes to the AI
        const buttons = (text: string) =>
          [...text.matchAll(BUTTON_OR_LINK_NAMED_REF)].map((m) => ({
            ref: m[1] as string,
            name: m[2] as string,
          }))
        const buttonSet = (text: string) =>
          buttons(text)
            .map((b) => b.name.trim())
            .filter(Boolean)
            .sort()
            .join('|')
        const snap = (t: number) =>
          this.browser.call('snapshot', { tabId: t, maxChars: 40_000 }).catch(() => undefined) as Promise<
            Snapshot | undefined
          >
        // Tabs to watch: the given tab + up to 3 other tabs Dool2 read recently (popups)
        const tabs = [tabId, ...[...this.pages.keys()].filter((t) => t !== tabId).slice(-3)]
        const first = new Map<number, Snapshot>()
        for (const t of tabs) {
          const f = await snap(t)
          if (f) first.set(t, f)
        }
        const started = Date.now()
        const expired = () => this.notifyUser?.(am.authExpiredTitle, am.authExpiredBody)
        let host = ''
        try {
          host = new URL(this.pages.get(tabId)?.url ?? '').hostname
        } catch {}
        // Some sites close the verification window when [verification done] is pressed before approval (measured Hometax: the window vanished 6 seconds after the request).
        // So while waiting, nothing is pressed; it only watches
        const card = (label: string) => this.askAuthDone?.(host, label, am.authHint)
        const waiting = card(msg)
        let pressedByUser = false
        if (waiting)
          void waiting.answer.then((v) => {
            if (v) pressedByUser = true
          })
        // Signs the screen changed: the URL changed, a confirm dialog newly appeared, the verification window (another tab) closed, or the set of buttons changed
        const changed = async (): Promise<{ main: Snapshot; why: string } | undefined> => {
          for (const t of tabs) {
            const was = first.get(t)
            if (!was) continue
            const now = await snap(t)
            const main = async () => (t === tabId ? now : await snap(tabId))
            if (!now) {
              // The verification popup closed (many sites close it themselves after approval)
              if (t === tabId) continue
              const m = await snap(tabId)
              if (m) return { main: m, why: 'the verification window closed' }
              continue
            }
            if (now.dialog && !was.dialog)
              return { main: (await main()) ?? now, why: 'a site confirm dialog appeared' }
            if (now.url !== was.url && (t === tabId || !/about:blank/.test(now.url)))
              return { main: (await main()) ?? now, why: 'the URL changed' }
            if (buttonSet(now.text) !== buttonSet(was.text)) {
              // Right after the request, site buttons change at once to 'request again', time left and so on. Too early for a person to
              // approve in the app, so just reset the baseline and keep waiting (measured 11-22 Samsung Fire: it ended twice within 10 seconds and the phone card vanished)
              if (Date.now() - started < 20_000) {
                first.set(t, now)
                continue
              }
              return { main: (await main()) ?? now, why: 'the buttons on screen changed' }
            }
          }
          return undefined
        }
        const others = tabs.filter((t) => t !== tabId)
        const judge =
          'Judge from the screen below yourself: if it says verification is done or shows the next step, carry on; if there is a button to go on (verification done, confirm verification, OK, next — scroll down with browser_scroll if not visible), press it' +
          `${others.length ? `. The verification window may be another tab (tab ${others.join(', ')}) — look with browser_read` : ''}. ` +
          'Only if the screen says verification is not done yet, call browser_wait_auth again to ask the user again (the card shows again). Before carrying on, write one line like "Verification is done. Now I\'ll do ○○" (it shows on the progress card right away).'
        const handBack = (main: Snapshot, why: string) => {
          waiting?.cancel()
          this.pages.set(tabId, pageInfo(main.url, main.text))
          return this.read(tabId, undefined, `${why}. ${judge}`)
        }
        const watch = async (signal?: AbortSignal): Promise<ToolResult> => {
          while (Date.now() - started < 180_000) {
            await new Promise((r) => setTimeout(r, 3_000))
            if (signal?.aborted) {
              waiting?.cancel()
              return { content: [] }
            }
            const c = await changed()
            if (c) {
              this.onNote?.('wait-auth', { by: 'screen', why: c.why, url: c.main.url.replace(/[?#].*$/, '') })
              return handBack(c.main, `The screen changed while waiting for verification (${c.why})`)
            }
            if (!pressedByUser) continue
            // The user said they approved. If the AI pointed at a button (ref), press only that once, then hand the screen to the AI
            let pressed = ''
            if (typeof a.ref === 'string') {
              const now = await snap(tabId)
              const btn = now && buttons(now.text).find((b) => b.ref === a.ref)
              if (btn) {
                await this.browser.call('click', { tabId, ref: btn.ref }, 30_000).catch(() => undefined)
                await new Promise((r) => setTimeout(r, 2_500))
                pressed = btn.name
              }
            }
            this.onNote?.('wait-auth', { by: 'user', pressed })
            const main = (await snap(tabId)) ?? first.get(tabId)
            if (!main) break
            return handBack(
              main,
              `The user approved in the authenticator app and pressed [I've verified].${pressed ? ` Dool2 pressed the pointed-at [${pressed}] once.` : ''}`,
            )
          }
          waiting?.cancel()
          expired()
          return {
            content: [
              {
                type: 'text',
                text: 'No approval was confirmed for 3 minutes, so waiting stopped (the verification request expires soon too). Do not request again; answer the user briefly, like "Verification timed out, so I stopped. To try again, say \'do it again\'", and end this reply.',
              },
            ],
          }
        }
        // Off the turn: the conversation is free while the user opens the app and approves (a wait here held every
        // other message for up to 3 minutes, measured 11-19 to 11-24: 9 waits, 1,461 s). The screen comes back as a new message
        const sink = this.afterAuth?.()
        if (!sink) return watch()
        void watch(sink.signal)
          .then((r) => {
            if (sink.signal.aborted) return
            const text = r.content
              .map((c) => (c.type === 'text' ? c.text : ''))
              .filter(Boolean)
              .join('\n')
            if (text) sink.deliver(text)
          })
          .catch(() => undefined)
        return {
          content: [
            {
              type: 'text',
              text: 'The card is on the phone and Dool2 is watching the screen. End this reply now with one short line, like "Approve it in the app. I\'ll carry on as soon as it\'s done." Do not call browser_wait_auth again or click anything. When the screen changes or the user taps the card, the screen comes to you as a new message; continue from there.',
            },
          ],
        }
      }
      case 'order_done':
        return this.orderDone(tabId, a)
      case 'handoff': {
        // Things a person must do (login, CAPTCHA, identity verification, final button): bring the Dool2 tab forward and end this reply.
        // The screen sees this tool call and shows [view in Chrome] [done].
        // The user holds only the phone — handing off the PC screen was almost always something to fix (measured: the mobile number field of a financial certificate window could not be read, so it was handed off).
        // So the first call on a screen does not hand off; it reads the screen again and returns it. Only the second call hands off
        let where = ''
        try {
          where = new URL(this.pages.get(tabId)?.url ?? '').pathname
        } catch {}
        const key = `${tabId}:${where}`
        // User decision 11-20: no PC screen hand-off — only in an emergency (emergency) that phone cards cannot handle
        if (a.emergency !== true) {
          const again = await this.read(
            tabId,
            undefined,
            "Not handed off. Handing off the PC screen is not allowed (user decision). Get the person's part through phone cards: payment PIN keypad, verification codes and certificate passwords with browser_request_code, robot-check images with browser_request_tap, choices and payment with browser_checkout or browser_request_approval, my info with browser_fill_profile. If the screen is cut off, make it visible with browser_scroll or browser_read and try again. If the same path is blocked, find another path. Never tell the user to do it themselves on the PC or in another app. Call again with emergency: true only in a real emergency that phone cards cannot handle.",
          )
          return { ...again, isError: true }
        }
        if (!this.handoffChecked.has(key)) {
          this.handoffChecked.add(key)
          const again = await this.read(
            tabId,
            undefined,
            'Not handed off yet. The user holds only the phone, so touching the PC screen is hard for them. Read the screen again (below, including frames on the page and "(fields visible on screen)"). ' +
              'If the fields and buttons here can do it, do it yourself: name, mobile number and birth date with browser_fill_profile, text verification codes, certificate passwords and PINs with browser_request_code (phone keypad card), authenticator app approval with browser_wait_auth, choices with browser_request_approval, tap-the-image robot checks with browser_request_tap (image card on the phone). ' +
              'If a human hand is still truly needed, call browser_handoff again then.',
          )
          // Returned as a failure: so no [PC screen hand-off] card stays in the chat (it stays only when really handed off)
          return { ...again, isError: true }
        }
        await this.browser.call('focus', { tabId })
        this.holdForPerson(tabId)
        this.watchHandoff(tabId)
        return {
          content: [
            {
              type: 'text',
              text:
                'Showed a card on the phone with only the fields needed from this screen. Tell the user in one or two sentences what to enter, like "enter just the ○○ field on the card on your phone" (do not tell them to look at the PC screen or the Dool2 tab), and end this reply here. ' +
                'When the user finishes (the screen changes or [done]), the Dool2 daemon notices and a notification tells you to carry on in the next message. Then read the page again to check and carry on. Do not ask the user to "tell me when done".',
            },
          ],
        }
      }
    }
    throw new Error(`Unknown browser tool: ${tool}`)
  }

  /**
   * One action (click, type, key, wait, scroll). The page is not read — the caller reads once at the end.
   * The checks blocking risky actions are the same as when calling tools one at a time
   */
  private async act(tabId: number, s: Record<string, unknown>): Promise<ActResult> {
    switch (s.do) {
      case 'click': {
        // A box without a ref (store cards etc.) is found by its text on screen and given a ref, then pressed. It goes through the approval gate by that text all the same
        let ref = typeof s.ref === 'string' ? s.ref : ''
        if (!ref && typeof s.text === 'string' && s.text.trim())
          ref = (await this.markText(tabId, s.text)).ref
        const page = this.pages.get(tabId)
        const target = page?.refs.get(ref)
        if (!page || !target)
          throw new Error(
            `I don't know what ${ref} is. Read the page first (browser_read) and check the refs`,
          )
        const label = `${target.role} ${target.name}`
        const risk = classifyRisk(label)
        // The AI looked at the screen and declared "this is the final button that spends money (sends, deletes)"
        const declared = s.final === true
        // Inside a payment group: [choose card], [next], [agree], [pay] in the payment company window (new tab, frame on the page, order sheet tab moved to the payment company)
        // are the same payment the user already approved. Not asked again (measured 11-20 Gmarket: [next] inside the payment window asked for approval again and stopped)
        const provider = this.inProvider(tabId, page.url, ref)
        // Even with words like 'apply' or 'register', a real link that only goes to another screen is pressed without approval
        // (on Gov24 even lookup-only services are entered with an 'apply' button). Even payment-ish names on real links only open a screen
        // (measured benefits 16: a 'pay' menu link was blocked as payment, so the attendance check failed). Delete-type ones stay blocked since GET links exist for them too
        const navOnly =
          !declared &&
          !provider &&
          target.role === ROLE.link &&
          (risk?.kind === 'contact' || risk?.kind === 'money') &&
          (
            (await this.browser.call('link-navigates', { tabId, ref }).catch(() => undefined)) as
              | { navigates?: boolean }
              | undefined
          )?.navigates === true
        // The already-approved payment button pressed after changing the shipping address (once)
        const passed = !provider && !navOnly ? this.usePass(tabId, target.name) : undefined
        // The AI looked at the screen and judged "this button only moves on to the checkout screen" (opens_checkout). Only for buttons with money words.
        // If the order got confirmed right after pressing, the read result says so loudly (safety rail)
        // Safety rail: names that spend money by themselves ([pay now], [Place order], [confirm booking]) are not passed even with opens_checkout
        const opens =
          !declared &&
          !provider &&
          !navOnly &&
          !passed &&
          s.opens_checkout === true &&
          risk?.kind === 'money' &&
          !payNow(target.name)
        const gated = !provider && !navOnly && !passed && !opens && (declared || risk !== undefined)
        // Sends and deletes approved as several at once are pressed for the remaining count (payments are not grouped)
        if (gated && !(risk && !declared && this.useSeries(page.url, risk.kind)))
          throw new Error(this.gateText(ref, target.name, risk, declared))
        const r = (await this.browser.call(
          'click',
          { tabId, ref, ...(s.force === true ? { force: true } : {}) },
          30_000,
        )) as BrowserState & {
          newTabId?: number
          coveredBy?: string
          delivered?: boolean
        }
        // A new window opening from a paying tab belongs to the same payment group. If this is the approved payment button, the payment group opens here
        const ses = this.paySession(tabId)
        if (ses && r.newTabId) this.joinSession(ses, r.newTabId)
        if (passed) this.startSession(passed, tabId, page.url, target.name, r.newTabId ? [r.newTabId] : [])
        const note = [
          `Pressed ${target.role} "${target.name}".`,
          provider && (risk || declared)
            ? '(A step inside the payment in progress, so pressed without asking approval again.)'
            : '',
          navOnly
            ? '(A link that only goes to another screen, so pressed without approval. The button that actually submits on that screen needs approval.)'
            : '',
          opens
            ? '(Judged as a button moving on to the checkout screen and pressed without approval. The final button on the checkout screen gets one approval with browser_checkout. If the order got confirmed right away, tell the user at once.)'
            : '',
          passed
            ? '(The payment button was already approved, so pressed it. Finish through the payment window and call browser_order_done with the order number on the order complete screen.)'
            : '',
          r.coveredBy ? `("${r.coveredBy}" was covering that spot. If it is a popup, close it first.)` : '',
          // The extension signals the mouse did not reach the element: do not end with 'pressed'; let the AI look at the screen and judge (11-20 test store)
          r.delivered === false
            ? '(The press may not have reached the element. Read again to see whether the screen changed; if not, press again.)'
            : '',
        ]
          .filter(Boolean)
          .join(' ')
        return { note, ...state(r), ...(r.newTabId ? { newTabId: r.newTabId } : {}) }
      }
      case 'type': {
        const ref = String(s.ref ?? '')
        const page = this.pages.get(tabId)
        if (!page?.refs.has(ref)) throw new Error(`I don't know what ${ref} is. Read the page first`)
        // Enter is not a final button: not blocked (measured 11-20 Gmarket: Enter in address search was blocked as payment and gave empty results).
        // Only buttons the AI raised with browser_checkout spend money
        const text = String(s.text ?? '')
        const r = (await this.browser.call('type', {
          tabId,
          ref,
          text,
          submit: Boolean(s.submit),
        })) as BrowserState & { drawn?: boolean; seen?: boolean }
        const name = page.refs.get(ref)?.name
        const where = name ? ` in "${name}"` : ''
        const done = s.submit ? `Typed${where} and pressed Enter.` : `Typed${where}.`
        // Spots an editor draws (title and body boxes, not text fields) are clicked and typed into. If the typed text does not show on screen, say so
        // (rather than handing off to the person to copy and paste, let the AI look at the screen and try again)
        const spot = name ? `the "${name}" spot` : 'that spot'
        const note = !r.drawn
          ? done
          : r.seen === false
            ? `Clicked ${spot} and typed, but the typed text does not show on screen. Check with browser_screenshot; if it did not go in, press that spot with browser_click and type again.`
            : `Clicked ${spot} and ${s.submit ? 'typed and pressed Enter' : 'typed'} (the typed text shows on screen).`
        return { note, ...state(r) }
      }
      case 'press': {
        const key = String(s.key ?? '')
        // Enter is pressed as is too (not a final button, same reason as type above)
        const r = (await this.browser.call('press', { tabId, key })) as BrowserState
        return { note: `Pressed the ${key} key.`, ...state(r) }
      }
      case 'hover': {
        // Only hovers (nothing is pressed, so no risk check)
        const ref = String(s.ref ?? '')
        const target = this.pages.get(tabId)?.refs.get(ref)
        if (!target) throw new Error(`I don't know what ${ref} is. Read the page first`)
        const r = (await this.browser.call('hover', { tabId, ref })) as BrowserState
        return { note: `Hovered over ${target.role} "${target.name}".`, ...state(r) }
      }
      case 'scroll': {
        const r = (await this.browser.call('scroll', {
          tabId,
          direction: s.direction === 'up' ? 'up' : 'down',
        })) as BrowserState
        return { note: 'Scrolled.', ...state(r) }
      }
      case 'wait': {
        const ms = Math.min(Math.max(Number(s.ms) || 1000, 100), 5000)
        await new Promise((r) => setTimeout(r, ms))
        return { note: `Waited ${(ms / 1000).toFixed(1)} seconds.` }
      }
    }
    throw new Error(`Unknown action: ${String(s.do)} (click·type·press·hover·scroll·wait)`)
  }

  /**
   * Several actions at once: does only the given actions in order and reads the page once at the end.
   * Reading and returning the whole page per action is slow and long (up to 8,000 characters at a time), so actions that follow each other, like filling a form, are grouped.
   * Stops there when the URL changes, a new tab opens, a confirm dialog appears or something is blocked (refs for the remaining actions are from the old screen)
   */
  private async steps(tabId: number, a: Record<string, unknown>): Promise<ToolResult> {
    const list = (Array.isArray(a.steps) ? a.steps : []).filter(
      (x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object',
    )
    if (!list.length) throw new Error('Put the actions to do in steps')
    if (list.length > MAX_STEPS) throw new Error(`Up to ${MAX_STEPS} actions at a time`)
    if (!this.pages.get(tabId)) throw new Error('Read the page first (browser_read)')
    const lines: string[] = []
    let at = tabId
    let url = this.pages.get(tabId)?.url
    for (const [i, s] of list.entries()) {
      const left = list.length - i - 1
      let r: ActResult
      try {
        r = await this.act(at, s)
      } catch (e) {
        lines.push(`${i + 1}. Stopped: ${(e as Error).message}`)
        if (left) lines.push(`(the remaining ${left} actions were not done)`)
        // Returned as an error so the reason it was blocked (approval needed etc.) shows first. The current screen too
        const page = await this.read(at, a.maxChars).catch(() => undefined)
        return {
          isError: true,
          content: [{ type: 'text', text: lines.join('\n') }, ...(page?.content ?? [])],
        }
      }
      lines.push(`${i + 1}. ${r.note}`)
      const why = r.newTabId
        ? 'a new tab opened'
        : r.dialog
          ? 'a site confirm dialog appeared'
          : r.url !== undefined && url !== undefined && r.url !== url
            ? 'it moved to another screen'
            : undefined
      if (r.newTabId) at = r.newTabId
      if (r.url !== undefined) url = r.url
      if (why && left) {
        lines.push(
          `(Because ${why}, the remaining ${left} actions were not done. Look at the new screen below and carry on)`,
        )
        break
      }
    }
    return this.read(at, a.maxChars, lines.join('\n'))
  }

  /** Work records to look at when fixing things (shape of unread checkout lists etc.) */
  onNote?: (kind: string, data: Record<string, unknown>) => void
  /** Keeps screen images (logs/shots) */
  onShot?: (label: string, base64: string) => void

  /** Options of a dropdown list (undefined if the extension cannot read them; the reason goes to the work record) */
  private async selectOptions(tabId: number, ref: string) {
    const r = (await this.browser.call('options', { tabId, ref }, 15_000).catch(() => undefined)) as
      | { options?: { label: string; selected: boolean }[] | null; why?: string }
      | undefined
    if (!r?.options && r?.why) {
      let host = ''
      try {
        host = new URL(this.pages.get(tabId)?.url ?? '').hostname
      } catch {}
      this.onNote?.('select-unread', { host, ref, why: r.why })
    }
    return r?.options ?? undefined
  }

  /** Detailed payment choice groups on the checkout screen (saved cards, installments). At most 3 groups, 12 each */
  private async subChoices(tabId: number, page: PageInfo) {
    const out: {
      key: string
      title: string
      ref: string
      options: string[]
      selected: number
      /** Whether the default is what was chosen last time on this site */
      remembered: boolean
    }[] = []
    let host = ''
    try {
      host = new URL(page.url).hostname
    } catch {}
    const selects = [...page.refs].filter(([, v]) => v.role === ROLE.select).slice(0, 6)
    const m = browserText(this.userLang())
    for (const [ref] of selects) {
      if (out.length >= 3) break
      let opts = (await this.selectOptions(tabId, ref))?.slice(0, 40)
      if (!opts) continue
      const title = subChoiceTitle(
        opts.map((o) => o.label),
        this.userLang(),
      )
      if (!title) continue
      // If the card list has saved cards (part of the number masked), only those: card company names after them are for registering a new card
      // (measured Coupang: 4 saved cards followed by 'KB Kookmin Card, Samsung Card…')
      const saved = opts.filter((o) => /\*{3,}/.test(o.label))
      if (title === m.subCard && saved.length) opts = saved
      opts = opts.slice(0, 12)
      // Default: the card or installment chosen last time on this site if it is in the list, else what is chosen on screen
      const remembered = opts.findIndex((o) => o.label === this.lastSub.get(`${host}|${title}`))
      out.push({
        key: `s${out.length + 1}`,
        title,
        ref,
        options: opts.map((o) => o.label),
        remembered: remembered >= 0,
        selected:
          remembered >= 0
            ? remembered
            : Math.max(
                0,
                opts.findIndex((o) => o.selected),
              ),
      })
    }
    return out
  }

  /** Finds the dropdown seen at approval on the current screen (the same ref if possible, else a list with the same options) */
  private async findSelect(
    tabId: number,
    refs: Map<string, { role: string; name: string }>,
    sr: { ref: string; options: string[] },
  ) {
    const same = (o?: { label: string }[]) =>
      !!o && o.length >= sr.options.length && sr.options.every((l, i) => o[i]?.label === l)
    const cands = [
      sr.ref,
      ...[...refs].filter(([k, v]) => v.role === ROLE.select && k !== sr.ref).map(([k]) => k),
    ]
    for (const ref of cands.slice(0, 8)) {
      if (!refs.has(ref)) continue
      const o = await this.selectOptions(tabId, ref)
      if (same(o)) return { ref, selected: o?.find((x) => x.selected)?.label }
    }
    return undefined
  }

  /**
   * Gets the user's approval for pressing this button (the AI's request_approval, a connector's approve step).
   * With kind (connector tier pay or contact), approval is asked even if the button label shows no risk
   */
  async askApproval(
    tabId: number,
    ref: string,
    d: {
      what: string
      where: string
      amount?: string
      cancel?: string
      /** Refs of the controls chosen while approving (payment method radios etc.) */
      choices?: string[]
      choiceTitle?: string
      /** What Dool2 chose itself before paying (no insurance, terms consent etc.) */
      chose?: string[]
      /** How many of the same thing in a row (e.g. deleting 6 events). 2 or more means one approval covers the rest */
      count?: number
      /** Where to deliver: the address chosen now and other saved addresses */
      shipTo?: string
      shipOptions?: string[]
      /** Goods, amount and info lines of the payment card (browser_checkout) */
      checkout?: {
        title?: string
        after?: string
        goods: CheckoutGood[]
        lines: NonNullable<ApprovalView['lines']>
        info: NonNullable<ApprovalView['info']>
      }
    },
    kind?: RiskKind,
  ): Promise<ToolResult> {
    const read = this.pages.get(tabId)
    const target = read?.refs.get(ref)
    if (!read || !target) throw new Error(`I don't know what ${ref} is. Read the page first`)
    // A payment card (browser_checkout) counts as a checkout screen: the screen's payment methods, saved cards and installments go on the card
    const page: PageInfo = d.checkout && !read.checkout ? { ...read, checkout: 'payment card' } : read
    // Choices: only choosing controls really on the checkout screen. They must not be pay or confirm buttons themselves
    const picks: { id: string; label: string; ref: string; role: string; name: string; near?: string }[] = []
    // Even if the AI passes no choices, the daemon puts them on the approval card when the checkout screen has two or more payment method controls
    // (measured: the AI ignored the tool description and chose Naver Pay itself). Even when passed, the screen's other payment methods are added
    const asked = approvalChoices(page, d.choices, d.choiceTitle)
    for (const cref of asked.slice(0, 8)) {
      const c = page.refs.get(cref)
      if (!c) throw new Error(`Choice ${cref} is not on screen. Read the page again`)
      if (
        !(
          [ROLE.radio, ROLE.button, ROLE.option, ROLE.checkbox, ROLE.tab, ROLE.item, ROLE.link] as string[]
        ).includes(c.role)
      )
        throw new Error(`Choice ${cref} is not a choosing control`)
      const label = optionLabel(page, cref)
      if (
        cref === ref ||
        (c.role !== ROLE.radio && !isPayOption(c.role, label) && classifyRisk(`${c.role} ${c.name}`))
      )
        throw new Error(`Choice ${cref} ("${label}") is a pay or confirm button, so it cannot be a choice`)
      if (!label) throw new Error(`Choice ${cref} has no name, so I don't know what it is`)
      picks.push({
        id: `c${picks.length + 1}`,
        label: payOptionName(label).slice(0, 40),
        ref: cref,
        role: c.role,
        name: c.name,
        ...(c.name ? {} : { near: label }),
      })
    }
    // Approval requests are never refused (asking the user is safe for a button at any step). Only the kind is decided:
    // a payment card is always money; otherwise button label → service tool tier → consent button → button the AI asked approval for
    const m = browserText(this.userLang())
    const risk: Risk =
      (d.checkout ? { kind: 'money' as const, reason: m.reasonPayCard } : undefined) ??
      classifyRisk(`${target.role} ${target.name}`) ??
      (kind ? { kind, reason: m.reasonToolTier } : undefined) ??
      (CONSENT_WORD.test(target.name)
        ? { kind: 'contact' as const, reason: m.reasonConsent(target.name) }
        : { kind: 'irreversible' as const, reason: m.reasonAiAsked })
    if (this.finalStep() === 'self')
      throw new Error(
        'The user chose "press the final button myself", so Dool2 does not press this button. Sum up what is prepared so far (what, where, how much, cancellation terms), tell the user, and end this reply.',
      )
    // Saved cards and installment months in the checkout dropdowns go on the approval card as lines below (default is what was chosen on screen)
    const subs = page.checkout ? await this.subChoices(tabId, page) : []
    // One tab has one final button to press: if an approval is waiting on the same tab, it is replaced by the new one
    // (measured: the AI read again and asked once more for the same button, two cards showed, and the first had a changed ref so it could not be pressed)
    this.approvals.expireTab(tabId)
    // Show the real screen on the approval card (so the user can notice if the amount the AI wrote is wrong)
    const shot = (await this.browser.call('screenshot', { tabId }).catch(() => undefined)) as
      | { data?: string }
      | undefined
    // Default choice: the last one chosen on this site, else the first
    let host = ''
    try {
      host = new URL(page.url).hostname
    } catch {}
    const last = this.lastChoice.get(host)
    // Payment method chosen now: the screen mark (selected), else the payment method right above the card and installment lists
    // (measured Coupang: the chosen method's button has no mark, and saved cards and installments show only under the chosen method)
    const at = (r: string) => page.pos?.get(r) ?? -1
    const firstSub = subs.length ? Math.min(...subs.map((g) => at(g.ref))) : -1
    const opened = picks.filter((p) => page.expanded?.has(p.ref))
    const onPage =
      picks.find((p) => page.selected?.has(p.ref)) ??
      // Screens where only the chosen method has its benefits expanded (Yanolja). If several are expanded, unknown
      (opened.length === 1 ? opened[0] : undefined) ??
      (firstSub >= 0
        ? picks.filter((p) => at(p.ref) >= 0 && at(p.ref) < firstSub).sort((a, b) => at(b.ref) - at(a.ref))[0]
        : undefined)
    // My payment methods: matched in order with what the site accepts. The first match is the default, and matching chips get a mark
    const mine = this.payMethods?.() ?? []
    const minePick = pickPayMethod(
      mine,
      picks.map((p) => p.label),
    )
    const mineOf = (label: string) => mine.find((m) => payMethodMatches(m, label))
    const preferred =
      (minePick ? picks[minePick.option] : undefined) ??
      picks.find(
        (p) => last && (p.name === last || p.near === last || (p.name || p.near || '').includes(last)),
      ) ??
      onPage ??
      picks[0]
    // If a card is chosen and the checkout screen has a card company list, default to the registered card company (a card chosen last time comes first)
    const card = preferred ? mineOf(preferred.label) : undefined
    // Also 'KB Kookmin Card' → 'Kookmin' (the screen shows it like 'Kookmin Card / 9409…')
    const brand = card?.issuer?.replace(CARD_SUFFIX, '')
    const brands = brand ? [...new Set([brand, brand.replace(/^[A-Z]+/, '')])].filter(Boolean) : []
    const subDefault = (g: (typeof subs)[number]) => {
      const screen = g.selected
      if (!brands.length || g.title !== m.subCard || g.remembered) return screen
      const isMine = (o: string) => brands.some((b) => o.includes(b))
      const last4 = card?.last4
      const byLast4 = last4 ? g.options.findIndex((o) => isMine(o) && o.includes(last4)) : -1
      const at = byLast4 >= 0 ? byLast4 : g.options.findIndex(isMine)
      return at >= 0 ? at : screen
    }
    const rec = this.approvals.create({
      tabId,
      ref,
      role: target.role,
      label: target.name,
      url: page.url,
      kind: risk.kind,
      reason: risk.reason,
      what: `${d.count && d.count > 1 ? m.allOf(d.count) : ''}${d.what}`.slice(0, 200),
      where: d.where.slice(0, 100),
      ...(d.amount ? { amount: d.amount.slice(0, 60) } : {}),
      ...(d.cancel ? { cancel: d.cancel.slice(0, 200) } : {}),
      ...(d.chose?.length ? { chose: d.chose } : {}),
      ...(d.shipTo ? await this.shipChoices(d.shipTo, d.shipOptions ?? []) : {}),
      ...(d.checkout?.title ? { title: d.checkout.title } : {}),
      ...(d.checkout?.after ? { after: d.checkout.after } : {}),
      ...(d.checkout?.goods.length ? { goods: d.checkout.goods } : {}),
      ...(d.checkout?.lines.length ? { lines: d.checkout.lines } : {}),
      ...(d.checkout?.info.length ? { info: d.checkout.info } : {}),
      ...(shot?.data ? { shot: shot.data } : {}),
      ...(picks.length
        ? {
            choices: picks.map(({ id, label }) => {
              const m = mineOf(label)
              return { id, label, ...(m ? { mine: payMethodLabel(m) } : {}) }
            }),
            choiceTitle: d.choiceTitle ?? m.payMethodTitle,
            ...(preferred ? { choice: preferred.id } : {}),
            choiceRefs: Object.fromEntries(
              picks.map((p) => [
                p.id,
                { ref: p.ref, role: p.role, name: p.name, ...(p.near ? { near: p.near } : {}) },
              ]),
            ),
          }
        : {}),
      ...(subs.length
        ? {
            subChoices: subs.map((g) => ({
              key: g.key,
              title: g.title,
              options: g.options.map((label, i) => ({ id: `${g.key}o${i + 1}`, label: label.slice(0, 40) })),
              choice: `${g.key}o${subDefault(g) + 1}`,
              // This list belongs to the payment method chosen on screen now (not used if another method is chosen)
              ...(onPage ? { when: onPage.id } : {}),
            })),
            subRefs: Object.fromEntries(subs.map((g) => [g.key, { ref: g.ref, options: g.options }])),
          }
        : {}),
    })
    if (d.count && d.count > 1) this.series.set(rec.id, Math.min(20, Math.floor(d.count)))
    // A payment card waits 1 hour: hold the tab for the same time so tab cleanup does not close it
    this.hold(tabId, risk.kind === 'money' ? PAY_SESSION_TTL_MS : APPROVAL_TTL_MS)
    return {
      content: [
        {
          type: 'text',
          text:
            `Asked for approval (${rec.id.slice(0, 8)}). Tell the user in one or two sentences what to approve, and end this reply here. ` +
            'When the user approves, Dool2 presses that button itself and tells you the result in the next message. Then read the page again to check.',
        },
      ],
    }
  }

  /**
   * Puts PC files into a file field on the page (blog photos, videos, document attachments). My files go out to that site, so
   * the first time an approval card (which files, to which site) is needed. The same approved file and site are not asked again for 30 minutes.
   * Only puts them in: the AI then presses the post or submit button (sending and submitting get their own approval on that button)
   */
  private async upload(tabId: number, a: Record<string, unknown>): Promise<ToolResult> {
    const page = this.pages.get(tabId)
    const ref = String(a.ref ?? '')
    const target = page?.refs.get(ref)
    if (!page || !target) throw new Error(`I don't know what ${ref || 'ref'} is. Read the page first`)
    if (!this.uploadFiles) throw new Error('File upload is not available on this PC')
    const paths = (Array.isArray(a.paths) ? a.paths : typeof a.path === 'string' ? [a.path] : []).map(String)
    const v = await this.uploadFiles(paths)
    if ('error' in v) throw new Error(v.error)
    const files = v.files
    let host = ''
    try {
      host = new URL(page.url).host
    } catch {}
    if (!host) throw new Error('The page URL is unknown')
    const now = Date.now()
    if (files.every((f) => (this.uploadPass.get(`${host}|${f.path}`) ?? 0) > now)) {
      const r = await sendFiles(this.browser, tabId, ref, files)
      return this.read(tabId, undefined, this.uploadedText(files, r, host, target.name, 'en'))
    }
    if (this.finalStep() === 'self')
      throw new Error(
        'The user chose "press the final button myself", so Dool2 does not upload their files to sites. Sum up which files to upload where, tell the user, and end this reply.',
      )
    const shot = (await this.browser.call('screenshot', { tabId }).catch(() => undefined)) as
      | { data?: string }
      | undefined
    const names = files.map((f) => f.name)
    const what = String(a.what ?? '')
      .trim()
      .slice(0, 120)
    const m = browserText(this.userLang())
    const rec = this.approvals.create({
      tabId,
      ref,
      role: target.role,
      label: target.name,
      url: page.url,
      kind: 'contact',
      reason: m.reasonUpload,
      what: (what || m.uploadWhat(files.length, names.join(', '))).slice(0, 200),
      where: host,
      items: files.map((f) => `${f.show} (${sizeText(f.size)})`),
      ...(shot?.data ? { shot: shot.data } : {}),
    })
    this.uploadAsks.set(rec.id, files)
    this.hold(tabId, APPROVAL_TTL_MS)
    return {
      content: [
        {
          type: 'text',
          text:
            `Asked for approval (${rec.id.slice(0, 8)}). Ask the user in one or two sentences whether ${names.join(', ')} may be uploaded to ${host}, and end this reply here. ` +
            'Once approved, Dool2 puts them in that file field itself and tells you the result in the next message. Then read the page again to see whether the files went up, and carry on.',
        },
      ],
    }
  }

  /** After putting files in, for the AI (English) or the approval card result (user language): what went in, and nothing is posted or submitted yet */
  private uploadedText(files: UploadFile[], r: UploadReply, host: string, label: string, lang: Lang): string {
    const names = files.map((f) => f.name)
    const off = notAccepted(r.accept ?? '', names)
    return browserText(lang).uploaded({
      host,
      label,
      names: names.join(', '),
      chooser: r.found === 'chooser',
      accept: r.accept ?? '',
      off: off.join(', '),
    })
  }

  /** Approved upload: checks the field is unchanged, then puts the files in */
  private async approveUpload(
    id: string,
    rec: ApprovalRecord,
    files: UploadFile[],
  ): Promise<{ ok: boolean; message: string }> {
    let host = ''
    try {
      host = new URL(rec.url).host
    } catch {}
    const m = browserText(this.userLang())
    try {
      const s = (await this.browser.call('snapshot', { tabId: rec.tabId, maxChars: 40_000 })) as Snapshot
      this.pages.set(rec.tabId, pageInfo(s.url, s.text))
      const now = parseRefs(s.text).get(rec.ref)
      if (s.url !== rec.url || !now || now.name !== rec.label || now.role !== rec.role) {
        const msg = m.uploadChanged(rec.label || rec.ref)
        this.approvals.finish(id, false, msg)
        return { ok: false, message: msg }
      }
      // The files may have been moved or deleted meanwhile: check again
      const v = this.uploadFiles
        ? await this.uploadFiles(files.map((f) => f.path))
        : { error: m.filesUnavailable }
      if ('error' in v) throw new Error(v.error)
      const r = await sendFiles(this.browser, rec.tabId, rec.ref, v.files)
      const until = Date.now() + 30 * 60_000
      for (const f of v.files) this.uploadPass.set(`${host}|${f.path}`, until)
      const msg = this.uploadedText(v.files, r, host, rec.label, this.userLang())
      this.approvals.finish(id, true, msg)
      return { ok: true, message: msg }
    } catch (e) {
      const msg = m.uploadFailed((e as Error).message)
      this.approvals.finish(id, false, msg)
      return { ok: false, message: msg }
    }
  }

  /** Gets approval for pressing [OK] in a site confirm dialog (the page is frozen while the dialog is open, so there is no screenshot) */
  private askDialogApproval(
    tabId: number,
    d: { what: string; where: string; amount?: string; cancel?: string },
  ): ToolResult {
    const dlg = this.dialogs.get(tabId)
    if (!dlg) throw new Error('No site confirm dialog is open. Read the page again to check')
    // Never refused: if the AI wants to ask, show the card
    const m = browserText(this.userLang())
    const risk = classifyDialogRisk(dlg.message, this.userLang()) ?? {
      kind: 'irreversible' as const,
      reason: m.reasonAiDialog,
    }
    if (this.finalStep() === 'self')
      throw new Error(
        'The user chose "press the final button myself", so Dool2 does not press this confirm dialog. Sum up what is prepared so far (what, where, how much), tell the user, and end this reply.',
      )
    const rec = this.approvals.create({
      tabId,
      ref: 'dialog',
      role: m.dialogRole,
      label: m.dialogLabel(dlg.message.slice(0, 150)),
      url: dlg.url,
      kind: risk.kind,
      reason: risk.reason,
      what: d.what.slice(0, 200),
      where: d.where.slice(0, 100),
      ...(d.amount ? { amount: d.amount.slice(0, 60) } : {}),
      ...(d.cancel ? { cancel: d.cancel.slice(0, 200) } : {}),
    })
    this.dialogApprovals.set(rec.id, dlg.message)
    this.hold(tabId, risk.kind === 'money' ? PAY_SESSION_TTL_MS : APPROVAL_TTL_MS)
    return {
      content: [
        {
          type: 'text',
          text:
            `Asked for approval (${rec.id.slice(0, 8)}). Tell the user in one or two sentences what to approve, and end this reply here. ` +
            'When the user approves, Dool2 presses [OK] in the confirm dialog itself and tells you the result in the next message. Then read the page again to check.',
        },
      ],
    }
  }

  /** When payment has started (approval result for the AI and the phone): the task is to reach order complete, the group's tabs, and how to finish */
  private payingText(x: PaySession): string {
    const extra = [...x.tabs].filter((t) => t !== x.tabId)
    return browserText(this.userLang()).paying(x.tabId, extra)
  }

  /**
   * The AI looks at the screen and reports order complete (or payment failure): closes the payment group (releases held tabs and the paying mark)
   * and finishes the payment approval with the order number. The end is "order complete screen + order number" (user decision 11-20)
   */
  private async orderDone(tabId: number, a: Record<string, unknown>): Promise<ToolResult> {
    const failed = a.failed === true
    const cut = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '')
    const orderNo = cut(a.order_no, 60)
    const summary = cut(a.summary, 200)
    const reason = cut(a.reason, 200)
    if (!failed && !orderNo)
      throw new Error(
        'Put in the order number (order_no) exactly as written on the order complete screen. If it is not on screen, open order history in a new tab and find it. If the payment did not go through, call with failed: true and reason.',
      )
    // Even if the order number was found on another tab (order history): if there is only one payment group, it is that payment
    const live = this.liveSessions()
    const x = this.paySession(tabId) ?? (live.length === 1 ? live[0] : undefined)
    if (x) this.endSession(x)
    this.onNote?.('order-done', { site: x?.site ?? '', ok: !failed, ...(failed && reason ? { reason } : {}) })
    if (failed) {
      if (x) this.approvals.settle(x.approvalId, false, browserText(this.userLang()).payFailed(reason))
      return {
        content: [
          {
            type: 'text',
            text: `Recorded the payment as not finished and closed the payment group${reason ? ` (${reason})` : ''}. First check whether money was charged (open order history in a new tab). If not, try again with another payment method or another way, and get the payment button approved again once with browser_checkout. Never tell the user to do it themselves on the PC or in another app.`,
          },
        ],
      }
    }
    if (x) this.approvals.settle(x.approvalId, true, browserText(this.userLang()).orderDone(orderNo, summary))
    return {
      content: [
        {
          type: 'text',
          text:
            `Recorded order complete (order number ${orderNo})${x ? '. Marked the payment approval done and released the paying tabs' : ''}. ` +
            'Now show one result card with show_result (what, how much, order number, arrival or use date) and save this order (site, order number, amount, date) with know_save.',
        },
      ],
    }
  }

  /** Marks the spot to press by its text on screen (the page must be read first). Returns the new ref and its text */
  async markText(tabId: number, text: string): Promise<{ ref: string; name: string }> {
    const page = this.pages.get(tabId)
    if (!page) throw new Error('Read the page first (browser_read)')
    const m = (await this.browser.call('mark-text', { tabId, text }, 15_000)) as { ref: string; name: string }
    page.refs.set(m.ref, { role: ROLE.text, name: m.name })
    return m
  }

  /** Refs of the last read tab (when a connector looks for an input field) */
  refsOf(tabId: number): Map<string, { role: string; name: string }> | undefined {
    return this.pages.get(tabId)?.refs
  }

  /** Whether this tab can be handled from the phone's remote screen now: within 30 minutes of Dool2 handing it to the person */
  /** Marks a tab for the person to work on (when logging in through the phone remote screen in a tab opened for a service connection) */
  allowRemote(tabId: number) {
    this.handedOff.set(tabId, Date.now())
  }

  /**
   * Payment groups (approval id → group). From pressing the approved payment button until order complete (browser_order_done).
   * The pressed tab and the payment windows and new tabs it opened are one group, and buttons in the payment company window inside it are not approved again.
   * Tabs in a group are not moved to another URL or taken by service tools (measured 11-20 Gmarket: after approval, the tab showing the card payment window
   * was moved to order history and the payment broke)
   */
  private sessions = new Map<string, PaySession>()
  /** When to look for a late payment window (ms after pressing). The first is waited before returning the approval result (short in tests) */
  payPopupWaits = [2_500, 5_000, 10_000]
  private liveSessions(now = Date.now()): PaySession[] {
    for (const [id, x] of this.sessions) if (now - x.startedAt > PAY_SESSION_TTL_MS) this.sessions.delete(id)
    return [...this.sessions.values()]
  }
  /** The payment group this tab is in (undefined if none) */
  paySession(tabId: number): PaySession | undefined {
    return this.liveSessions().find((x) => x.tabs.has(tabId))
  }
  isPaying(tabId: number): boolean {
    return this.paySession(tabId) !== undefined
  }
  /**
   * Presses the pointed-at on-screen keypad buttons in order for the PIN received on the phone secure keypad (the value is not kept). true if all were pressed.
   * force: each press changes '●○○○○○ (1/6)' above the keypad, so the surrounding-text check (which stops list rows being reused) blocked from the second digit
   * (test store payment window). The AI just pointed at the keypad, and whether the spots got shuffled again is judged by the AI from the screen after pressing.
   * once: pressing again a digit button that did not change the screen as 'not pressed' would enter the digit twice
   */
  /**
   * Types a password with an on-screen secure keypad (each key has a label: "3", "lowercase q", "exclamation mark"). The value never goes to the AI.
   * For fields that block keyboard input (measured 11-21 Shinhan Card signup: both typing and pasting were 'blocked by the secure keypad').
   * false if there is no keypad or a letter button cannot be found
   */
  async keypadType(tabId: number, fieldRef: string, pw: string): Promise<boolean> {
    return keypadType(this.browser, tabId, fieldRef, pw)
  }

  async pressPin(tabId: number, keys: Record<string, PinKey>, pin: string): Promise<boolean> {
    for (const [i, d] of [...pin].entries()) {
      const ref = keys[d]
      if (!ref) return false
      // Image keypad not exposed as buttons: press the pointed-at screen spot
      if (typeof ref === 'object') {
        const ok = await this.browser
          .call('input', { tabId, action: 'tap', x: ref.x, y: ref.y }, 15_000)
          .then(
            () => true,
            () => false,
          )
        if (!ok) return false
        await new Promise((res) => setTimeout(res, 150))
        continue
      }
      // The screen height stretched to press a keypad at the bottom stays until the last digit (stretching and shrinking per digit adds 0.5 seconds each)
      const keepTall = i < pin.length - 1
      const ok = await this.browser
        .call('click', { tabId, ref, once: true, force: true, quick: true, keepTall }, 15_000)
        .then(
          () => true,
          () => false,
        )
      if (!ok) return false
      await new Promise((res) => setTimeout(res, 120))
    }
    return true
  }
  /** Payment finished (order complete screen confirmed): closes that tab's payment group */
  donePaying(tabId: number) {
    const x = this.paySession(tabId)
    if (x) this.endSession(x)
  }
  /**
   * Whether it is inside the payment company window: another tab of the payment group (payment window), a frame on the pressed tab, or the pressed tab moved to the payment company address.
   * Money buttons on the store's order sheet itself are not included (buying again at the same store needs approval again)
   */
  private inProvider(tabId: number, url: string, ref = ''): boolean {
    const x = this.paySession(tabId)
    if (!x) return false
    if (tabId !== x.tabId || frameRef(ref)) return true
    return url !== '' && siteKey(url) !== x.site
  }
  /** The approved payment button was pressed: opens a payment group */
  private startSession(approvalId: string, tabId: number, url: string, label: string, extra: number[] = []) {
    // One payment per tab: an older group on the same tab is closed
    for (const x of this.liveSessions()) if (x.tabs.has(tabId)) this.sessions.delete(x.approvalId)
    const x: PaySession = {
      approvalId,
      tabId,
      tabs: new Set([tabId]),
      site: siteKey(url),
      label,
      startedAt: Date.now(),
    }
    this.sessions.set(approvalId, x)
    this.hold(tabId, PAY_SESSION_TTL_MS)
    for (const t of extra) this.joinSession(x, t)
    this.onNote?.('pay-session', { site: x.site, tabs: [...x.tabs] })
    // Payment windows open late after a server round trip: look a few more times (approve waits for the first one)
    for (const ms of this.payPopupWaits.slice(1)) {
      const t = setTimeout(() => void this.findPayTabs(x), ms)
      t.unref?.()
    }
    return x
  }
  private joinSession(x: PaySession, tabId: number) {
    if (x.tabs.has(tabId)) return
    x.tabs.add(tabId)
    this.hold(tabId, PAY_SESSION_TTL_MS)
    this.onNote?.('pay-session-tab', { site: x.site, tabId })
  }
  private endSession(x: PaySession) {
    this.sessions.delete(x.approvalId)
    for (const t of x.tabs) {
      this.hold(t, 0)
      this.paidPass.delete(t)
    }
  }
  /** Finds windows opened by the payment group's tabs and adds them (the extension's late new-window notice + openers in the tab list) */
  private async findPayTabs(x: PaySession) {
    if (this.sessions.get(x.approvalId) !== x) return
    for (const t of [...x.tabs]) {
      const p = (await this.browser.call('popup', { tabId: t }, 5_000).catch(() => undefined)) as
        | { newTabId?: number }
        | undefined
      if (typeof p?.newTabId === 'number') this.joinSession(x, p.newTabId)
    }
    for (const t of await this.openerTabs())
      if (t.opener !== undefined && x.tabs.has(t.opener)) this.joinSession(x, t.tabId)
  }
  /**
   * The extension's tab list (tab and the tab that opened it). An extension that does not know the tab list command gives an empty list — then only late new-window notices (popup) are used.
   * (the tab list command on the extension side comes separately: read broadly so differences in name or shape do not break)
   */
  private async openerTabs(): Promise<{ tabId: number; opener?: number }[]> {
    const r = (await this.browser.call(TABS_CMD, {}, 5_000).catch(() => undefined)) as unknown
    const list: unknown[] = Array.isArray(r)
      ? r
      : Array.isArray((r as { tabs?: unknown } | undefined)?.tabs)
        ? (r as { tabs: unknown[] }).tabs
        : []
    const out: { tabId: number; opener?: number }[] = []
    for (const v of list) {
      const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
      const id = Number(o.tabId ?? o.id)
      const opener = Number(o.openerTabId ?? o.opener)
      if (Number.isInteger(id)) out.push({ tabId: id, ...(Number.isInteger(opener) ? { opener } : {}) })
    }
    return out
  }
  /** If a new tab is a window opened by a payment group's tab, add it to the group (asked only while paying) */
  private async adoptTab(tabId: number) {
    const live = this.liveSessions()
    if (!live.length || live.some((x) => x.tabs.has(tabId))) return
    const me = (await this.openerTabs()).find((t) => t.tabId === tabId)
    const x = me?.opener !== undefined ? live.find((y) => y.tabs.has(me.opener as number)) : undefined
    if (x) this.joinSession(x, tabId)
  }
  /** When the handed-off screen changes (the person seems done), tell the daemon: carry on even if the user does not say 'done' */
  onHandoffChanged?: (tabId: number, why: string) => void
  private handoffWatches = new Map<number, ReturnType<typeof setInterval>>()
  stopHandoffWatch(tabId: number) {
    const t = this.handoffWatches.get(tabId)
    if (t) clearInterval(t)
    this.handoffWatches.delete(tabId)
  }
  /**
   * Every 3 seconds, looks at the tab's URL, robot check, and field and button names, and reports when they differ from hand-off time (next screen after login or verification).
   * Typing into fields alone does not count (values are not looked at). A closed tab (login popup closed when done) also counts as done. Up to 10 minutes
   */
  /** Interval for watching the handed-off screen (short in tests) */
  handoffEveryMs = 3_000
  private watchHandoff(tabId: number, everyMs = this.handoffEveryMs) {
    this.stopHandoffWatch(tabId)
    const sig = (s: { url?: string; text?: string; captcha?: boolean }) =>
      `${s.url ?? ''}|${s.captcha ? 1 : 0}|${[...parseRefs(s.text ?? '').values()]
        .map((r) => `${r.role}:${r.name}`)
        .sort()
        .join(',')}`
    let base: string | undefined
    let fails = 0
    let n = 0
    const t = setInterval(() => {
      if (++n > (10 * 60_000) / everyMs) return this.stopHandoffWatch(tabId)
      void this.browser
        .call('snapshot', { tabId, maxChars: 20_000 }, 10_000)
        .then((s) => {
          fails = 0
          const cur = sig(s as { url?: string; text?: string; captcha?: boolean })
          if (base === undefined) base = cur
          else if (cur !== base && this.handoffWatches.has(tabId)) {
            this.stopHandoffWatch(tabId)
            this.onHandoffChanged?.(tabId, 'the screen moved to the next step')
          }
        })
        .catch(() => {
          // Failing to read twice in a row means the tab closed (social login popups close by themselves when done)
          if (++fails >= 2 && this.handoffWatches.has(tabId)) {
            this.stopHandoffWatch(tabId)
            this.onHandoffChanged?.(tabId, 'the handed-off window closed')
          }
        })
    }, everyMs)
    t.unref?.()
    this.handoffWatches.set(tabId, t)
  }

  /** A tab for the person: opens the remote screen and keeps it out of tab cleanup until done (only on hand-off, unlike allowRemote called by every tool) */
  holdForPerson(tabId: number) {
    this.allowRemote(tabId)
    this.hold(tabId, REMOTE_TTL_MS)
  }

  /**
   * Tabs waiting for a person or approval are kept out of the extension's tab cleanup (up to 3 tabs, sleep after 12 minutes).
   * Otherwise, while waiting, other tabs (social login windows etc.) open and this least recently used tab gets closed,
   * the held seat or checkout screen disappears, and "not a tab Dool2 opened" came up (measured: Lotte Cinema payment).
   * Older extensions that do not know this command still do the work
   */
  private hold(tabId: number, ms: number) {
    void this.browser.call('hold', { tabId, ms }, 5_000).catch(() => undefined)
  }

  remoteAllowed(tabId: number, now = Date.now()): boolean {
    const at = this.handedOff.get(tabId)
    if (at === undefined) return false
    if (now - at > REMOTE_TTL_MS) {
      this.handedOff.delete(tabId)
      return false
    }
    return true
  }

  /** One remote screen image (shrunk to the size sent to the phone) */
  async remoteScreen(tabId: number, fit?: { width: number; height: number }) {
    if (!this.remoteAllowed(tabId)) throw new Error(browserText(this.userLang()).remoteViewOnly)
    // For the live view: fast, with size and quality for the phone screen (several per second). The screen's inputs, buttons and current field come too (remote).
    // With fit, the PC tab is drawn at the phone screen size (phone-width drawing also via the remote input view)
    const args = fit
      ? { tabId, fit, maxWidth: Math.min(fit.width * 2, 1000), quality: 55, remote: true }
      : { tabId, maxWidth: 780, quality: 55, remote: true }
    return (await this.browser.call('screenshot', args)) as {
      url: string
      title: string
      data: string
      viewport: { width: number; height: number }
    } & RemoteInfo
  }

  /** Remote screen 'needed fields only': fields, choices and buttons for the person to fill (tabs Dool2 handed off only) */
  async remoteForm(tabId: number): Promise<RemoteForm> {
    if (!this.remoteAllowed(tabId)) throw new Error(browserText(this.userLang()).remoteViewOnly)
    return (await this.browser.call('form', { tabId }, 20_000)) as RemoteForm
  }

  /** Puts values filled on the fields-only screen and presses the button. Values never go to the AI, only into the page fields */
  async remoteFill(tabId: number, values: RemoteFormValue[], press?: string) {
    if (!this.remoteAllowed(tabId)) throw new Error(browserText(this.userLang()).remoteControlOnly)
    const id = (x: unknown) => String(x ?? '').slice(0, 24)
    const clean = (Array.isArray(values) ? values : []).slice(0, 30).map((v) => ({
      id: id(v.id),
      ...(typeof v.value === 'string' ? { value: v.value.slice(0, 200) } : {}),
      ...(typeof v.checked === 'boolean' ? { checked: v.checked } : {}),
      ...(typeof v.pick === 'string' ? { pick: id(v.pick) } : {}),
    }))
    return this.browser.call(
      'form-fill',
      { tabId, values: clean, ...(press ? { press: id(press) } : {}) },
      30_000,
    )
  }

  /** Input a person made on the remote screen. Coordinates come as image ratios (0~1) and are turned into page coordinates */
  async remoteInput(
    tabId: number,
    input: {
      action: 'tap' | 'text' | 'key' | 'scroll' | 'view' | 'leave'
      x?: number
      y?: number
      text?: string
      key?: string
      dy?: number
      w?: number
      h?: number
    },
    viewport: { width: number; height: number },
  ) {
    if (!this.remoteAllowed(tabId)) throw new Error(browserText(this.userLang()).remoteControlOnly)
    const args: Record<string, unknown> = { tabId, action: input.action }
    if (input.action === 'tap') {
      const fx = Number(input.x)
      const fy = Number(input.y)
      if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1))
        throw new Error(browserText(this.userLang()).tapOutside)
      args.x = fx * viewport.width
      args.y = fy * viewport.height
    }
    if (input.action === 'text') args.text = String(input.text ?? '').slice(0, 500)
    if (input.action === 'key') args.key = String(input.key ?? '')
    if (input.action === 'scroll') {
      const dy = Number(input.dy) || 0
      // ±1 is one screen at a time; larger is page pixels dragged by the finger (scrolls at the dragged spot)
      args.dy = Math.abs(dy) <= 1 ? (dy < 0 ? -1 : 1) : Math.max(-3000, Math.min(3000, dy))
      const fx = Number(input.x)
      const fy = Number(input.y)
      if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) {
        args.x = fx * viewport.width
        args.y = fy * viewport.height
      }
    }
    if (input.action === 'view') {
      args.w = Number(input.w) || 390
      args.h = Number(input.h) || 700
    }
    return this.browser.call('input', args)
  }

  /** Approval request id → how many are approved at once */
  private series = new Map<string, number>()
  /** Remaining count that can be pressed in a row with one approval (per site and kind, 10 minutes). Sends and deletes only — payment is one button per approval */
  private grants: { host: string; kind: RiskKind; left: number; until: number }[] = []

  private grantSeries(url: string, kind: RiskKind, left: number) {
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {}
    if (!host || left < 1 || kind === 'money') return
    this.grants.push({ host, kind, left, until: Date.now() + 10 * 60_000 })
  }

  /**
   * Uses one remaining approval if there is one. Payments are not grouped: before, one approved payment let that site's money buttons
   * be pressed without approval for 30 minutes (safety hole, 11-20 full audit)
   */
  private useSeries(url: string, kind: RiskKind, consume = true): boolean {
    if (kind === 'money') return false
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {}
    const now = Date.now()
    this.grants = this.grants.filter((g) => g.until > now && g.left > 0)
    const g = this.grants.find((x) => x.host === host && x.kind === kind)
    if (!g) return false
    if (!consume) return true
    g.left--
    this.onNote?.('approval-series', { host, kind, left: g.left })
    return true
  }

  /** Blocked button: short, no procedure explanation, only which card to raise it with */
  private gateText(ref: string, name: string, risk: Risk | undefined, declared: boolean): string {
    const what = `[${ref} "${name}"]`
    if (this.finalStep() === 'self')
      return `${GATE_STOP}: ${what} is ${risk ? RISK_TEXT[risk.kind] : 'the final button'}, so Dool2 does not press it. The user chose "press the final button myself". Sum up what is prepared so far (what, where, how much), tell the user, and end this reply.`
    if (!risk)
      return `${GATE_STOP}: you said ${what} is the final button (final). Raise this ref with browser_checkout for a payment, or browser_request_approval for sending or deleting, to show an approval card.`
    if (risk.kind === 'money')
      return `${GATE_STOP}: ${what} is a button that spends money (${risk.reason}). Show a payment card with browser_checkout(ref: "${ref}") and get one approval.${declared ? '' : ' If the button only moves on to the checkout screen, press it again with opens_checkout: true.'}`
    return `${GATE_STOP}: ${what} is ${RISK_TEXT[risk.kind]} (${risk.reason}). Show an approval card with browser_request_approval(ref: "${ref}").`
  }

  /**
   * Presses the button the user approved. Re-reads the page right before pressing, and presses only when the approved button label and URL are unchanged.
   * Only the side holding the screen token (the user's screen) can call it (not with the AI's tool token)
   */
  async approve(id: string, choice?: string): Promise<{ ok: boolean; message: string }> {
    const rec: ApprovalRecord | undefined = this.approvals.take(id)
    if (!rec) return { ok: false, message: browserText(this.userLang()).approvalGone }
    const tx = browserText(this.userLang())
    const upFiles = this.uploadAsks.get(id)
    if (upFiles) {
      this.uploadAsks.delete(id)
      return this.approveUpload(id, rec, upFiles)
    }
    const dialogText = this.dialogApprovals.get(id)
    if (dialogText !== undefined) {
      this.dialogApprovals.delete(id)
      try {
        // Press only when the dialog open in the extension now is the one that was approved
        const r = (await this.browser.call('dialog', {
          tabId: rec.tabId,
          accept: true,
          expect: dialogText,
        })) as {
          url?: string
          title?: string
        }
        this.dialogs.delete(rec.tabId)
        const pressed = tx.dialogPressed(dialogText.slice(0, 80))
        // A payment confirm dialog opens a payment group just like a button and carries on until order complete
        if (rec.kind === 'money') {
          const x = this.startSession(id, rec.tabId, rec.url, rec.label)
          const msg = `${pressed} ${this.payingText(x)} ${tx.screenNow(r.title ?? '', r.url ?? '')}`
          this.approvals.progress(id, msg)
          return { ok: true, message: msg }
        }
        const msg = `${pressed} ${tx.screenNow(r.title ?? '', r.url ?? '')}`
        this.approvals.finish(id, true, msg)
        return { ok: true, message: msg }
      } catch (e) {
        const msg = tx.dialogFailed((e as Error).message)
        this.approvals.finish(id, false, msg)
        return { ok: false, message: msg }
      }
    }
    try {
      const s = (await this.browser.call('snapshot', { tabId: rec.tabId, maxChars: 40_000 })) as Snapshot
      let now = parseRefs(s.text).get(rec.ref)
      this.pages.set(rec.tabId, pageInfo(s.url, s.text))
      // A spot found by text (a service tool's final button) is not in the ref list: find it again by the same text and check it is the same spot
      if (rec.role === ROLE.text && s.url === rec.url) {
        const m = (await this.browser
          .call('mark-text', { tabId: rec.tabId, text: rec.label }, 15_000)
          .catch(() => undefined)) as { ref: string; name: string } | undefined
        if (m?.ref === rec.ref) now = { role: ROLE.text, name: m.name }
      }
      if (s.url !== rec.url || !now || now.name !== rec.label || now.role !== rec.role) {
        const msg = tx.changedAfterApproval(rec.label)
        this.approvals.finish(id, false, msg)
        return { ok: false, message: msg }
      }
      // Press the chosen payment method (choice) first. Then read the screen again and check the final button is the same
      let base = s
      let finalRef = rec.ref
      let finalName = rec.label
      let chosen: string | undefined
      const picked: string[] = []
      const pickedSubs: [string, string][] = []
      // What was chosen: payment method (c1) and detailed choices (s1o2) joined by commas (exactly as the phone signed)
      const all = (choice ?? '').split(',').filter(Boolean)
      // Where to deliver: if not a0 (the current one), the address must be changed before paying. Changing the address on screen differs by site, so the AI does it,
      // and this approval lets the final button be pressed once (not asked again, 1 hour like payment approval)
      const isShip = (p: string) => /^a\d+$/.test(p) || p.startsWith('n:')
      const ship = all.find(isShip)
      // n:… = a new address the user entered (added to that site's addresses and chosen)
      const fresh = ship?.startsWith('n:') ? safeDecode(ship.slice(2)).trim().slice(0, 100) : ''
      const shipTo = fresh
        ? tx.newAddress(fresh)
        : ship && ship !== 'a0'
          ? rec.shipOptions?.find((o) => o.id === ship)?.label
          : undefined
      const parts = all.filter((p) => !isShip(p))
      if (shipTo) {
        const pay = parts
          .map(
            (p) =>
              rec.choices?.find((c) => c.id === p)?.label ??
              rec.subChoices?.flatMap((g) => g.options).find((o) => o.id === p)?.label,
          )
          .filter(Boolean)
        this.paidPass.set(rec.tabId, {
          label: rec.label,
          until: Date.now() + PAY_SESSION_TTL_MS,
          approvalId: id,
        })
        const msg = tx.shipChange(shipTo, pay.map((x) => `"${x}"`).join(', '), rec.label)
        // The approval is not finished yet: it finishes at order complete (browser_order_done)
        this.approvals.progress(id, msg)
        return { ok: true, message: msg }
      }
      const main = parts.find((p) => rec.choiceRefs?.[p])
      // If another payment method was chosen, the card and installment choices under the old one are not used
      const applies = (p: string) => {
        const when = rec.subChoices?.find((g) => g.key === p.split('o')[0])?.when
        return !when || !main || when === main
      }
      const subs = parts.filter((p) => /^s\d+o\d+$/.test(p) && rec.subRefs?.[p.split('o')[0] as string])
      const fail = (why: string) => {
        const msg = tx.payFail(why)
        this.approvals.finish(id, false, msg)
        return { ok: false, message: msg }
      }
      if (parts.length !== subs.length + (main ? 1 : 0)) return fail(tx.failNoMethod)
      if (main || subs.length) {
        const reread = async () => {
          base = (await this.browser.call('snapshot', { tabId: rec.tabId, maxChars: 40_000 })) as Snapshot
          this.pages.set(rec.tabId, pageInfo(base.url, base.text))
          return base.url === rec.url
        }
        if (main) {
          const c = rec.choiceRefs?.[main] as NonNullable<ApprovalRecord['choiceRefs']>[string]
          const what = c.name || c.near || tx.chosenMethod
          const at = sameChoice(pageInfo(s.url, s.text), c)
          if (!at) return fail(tx.choiceChanged(what))
          await this.browser.call('click', { tabId: rec.tabId, ref: at }, 30_000)
          if (!(await reread())) return fail(tx.choiceMoved(what))
          chosen = what
        }
        // Saved card and installment: if the screen differs from what was chosen, choose it in that list
        let changed = false
        for (const sid of subs.filter(applies)) {
          const [key = '', n = ''] = sid.split('o')
          const sr = rec.subRefs?.[key] as { ref: string; options: string[] }
          const label = sr.options[Number(n) - 1]
          const group = rec.subChoices?.find((g) => g.key === key)
          if (!label) return fail(tx.subMissing)
          const at = await this.findSelect(rec.tabId, parseRefs(base.text), sr)
          if (!at) {
            // The list vanished after changing the payment method: skip if it was the default, stop if a change was asked
            if (group?.choice === sid) continue
            return fail(tx.subGone(label, group?.title))
          }
          if (at.selected !== label) {
            await this.browser.call('choose', { tabId: rec.tabId, ref: at.ref, label }, 15_000)
            changed = true
          }
          picked.push(label)
          if (group?.title) pickedSubs.push([group.title, label])
        }
        if (changed && !(await reread())) return fail(tx.subMoved)
        if (base !== s) {
          const refs = parseRefs(base.text)
          const next =
            sameControl(refs, rec.ref, rec.role, rec.label) ??
            [...refs].find(([, v]) => v.role === rec.role && sameFinal(v.name, rec.label))?.[0]
          if (!next) return fail(tx.finalChanged(rec.label))
          finalRef = next
          finalName = refs.get(next)?.name ?? rec.label
        }
      }
      // Sites whose payment window opens as a new window: allow this site's popups so Chrome's popup blocker does not stop it
      if (rec.kind === 'money')
        await this.browser.call('allow-popups', { tabId: rec.tabId }).catch(() => undefined)
      let r = (await this.browser.call('click', { tabId: rec.tabId, ref: finalRef }, 30_000)) as {
        url?: string
        title?: string
        dialog?: SiteDialog
        newTabId?: number
        coveredBy?: string
      }
      // If the site asks "are you sure?" after the approved button, it is the very thing the user approved, so press [OK]
      let also = ''
      if (r.dialog?.type === 'confirm') {
        const asked = r.dialog.message
        r = (await this.browser.call('dialog', { tabId: rec.tabId, accept: true, expect: asked })) as typeof r
        also = tx.alsoConfirmed(asked.slice(0, 80))
      }
      // If nothing happened after pressing, do not say 'pressed' (measured: a cookie banner layer covered it so the click did nothing,
      // but it reported 'pressed' and the AI guessed 'login' as the cause). If any of new window, confirm dialog, URL or page text changed, it took effect
      if (!also && !r.dialog && !r.newTabId && (r.url ?? base.url) === base.url) {
        const after = (await this.browser
          .call('snapshot', { tabId: rec.tabId, maxChars: 40_000 })
          .catch(() => undefined)) as Snapshot | undefined
        if (after && after.url === base.url && after.text === base.text) {
          this.pages.set(rec.tabId, pageInfo(after.url, after.text))
          const msg = tx.noEffect(rec.label, r.coveredBy)
          this.approvals.finish(id, false, msg)
          return { ok: false, message: msg }
        }
      }
      if (chosen) this.rememberChoice(rec.url, chosen)
      // Remember the chosen saved card and installment per site too (default for the next approval card)
      try {
        const host = new URL(rec.url).hostname
        for (const [title, label] of pickedSubs) {
          this.lastSub.set(`${host}|${title}`, label)
          this.onSubChoice?.(`${host}|${title}`, label)
        }
      } catch {}
      const how = [chosen ? tx.methodPicked(chosen) : '', ...picked.map((p) => `"${p}"`)]
        .filter(Boolean)
        .join(', ')
      // If the chosen easy pay has "what is used inside it" registered by the user, tell the AI to choose it in the payment window (ADR 0023)
      const mainLabel = rec.choices?.find((c) => c.id === main)?.label
      const inner = mainLabel
        ? (this.payMethods?.() ?? []).find(
            (m) => m.kind !== 'card' && m.inner && payMethodMatches(m, mainLabel),
          )
        : undefined
      const hint = inner ? tx.innerHint(PAY_KINDS[inner.kind] ?? inner.kind, inner.inner ?? '') : ''
      // If several were approved at once (deleting 6 events etc.), buttons of the same site and kind are pressed without asking for the remaining count within 10 minutes.
      // No whole-site 30-minute pass: one approval = one button (payments are not grouped)
      const many = this.series.get(id)
      this.series.delete(id)
      let rest = ''
      if (many && many > 1 && rec.kind !== 'money') {
        this.grantSeries(rec.url, rec.kind as RiskKind, many - 1)
        rest = tx.seriesRest(many)
      }
      const pressed = tx.pressedButton(how, finalName, also)
      if (rec.kind !== 'money') {
        const msg = `${pressed}${rest} ${tx.screenNow(r.title ?? '', r.url ?? '')}`
        this.approvals.finish(id, true, msg)
        return { ok: true, message: msg }
      }
      // Payment: not the end here. Group the pressed tab and payment windows into a payment group and carry on until order complete (browser_order_done).
      // Payment windows often open late as new windows: wait briefly and look once more, then look a few more times after that (startSession)
      if (!r.newTabId) {
        await new Promise((res) => setTimeout(res, this.payPopupWaits[0] ?? 0))
        const late = (await this.browser.call('popup', { tabId: rec.tabId }).catch(() => ({}))) as {
          newTabId?: number
        }
        if (late.newTabId) r = { ...r, newTabId: late.newTabId }
      }
      const x = this.startSession(id, rec.tabId, rec.url, finalName, r.newTabId ? [r.newTabId] : [])
      const msg = `${pressed}${hint} ${this.payingText(x)} ${tx.screenNow(r.title ?? '', r.url ?? '')}`
      // The approval record stays 'approved (paying)' and finishes with the order number once order complete is confirmed (browser_order_done)
      this.approvals.progress(id, msg)
      return { ok: true, message: msg }
    } catch (e) {
      const msg = tx.pressFailed(rec.label, (e as Error).message)
      this.approvals.finish(id, false, msg)
      return { ok: false, message: msg }
    }
  }

  /**
   * A pay-tier service tool handed this tab to the AI: a payment flow starts here (hold the tab, add checkout and confirmed screen guidance).
   * There is no bypass that presses buttons without approval: buttons that only move on to the checkout screen are judged by the AI with opens_checkout
   */
  startPayFlow(tabId: number, tool: string, sites: string[] = [], now = Date.now()) {
    this.payFlows.set(tabId, { tool, at: now })
    // Tabs holding seats or carts: keep them from cleanup while approving and choosing a payment method
    this.hold(tabId, REMOTE_TTL_MS)
    for (const site of sites) if (site) this.paySites.set(site.toLowerCase(), { tool, at: now })
  }

  /** The tool name if this is a payment flow tab (or a tab that opened a payment flow site) (forgotten after an hour) */
  payFlow(tabId: number, now = Date.now()): string | undefined {
    const f = this.payFlows.get(tabId)
    if (f && now - f.at <= PAY_FLOW_TTL_MS) return f.tool
    if (f) this.payFlows.delete(tabId)
    let host = ''
    try {
      host = new URL(this.pages.get(tabId)?.url ?? '').hostname.toLowerCase()
    } catch {}
    if (!host) return undefined
    for (const [site, s] of this.paySites) {
      if (now - s.at > PAY_FLOW_TTL_MS) {
        this.paySites.delete(site)
        continue
      }
      if (host === site || host.endsWith(`.${site}`)) return s.tool
    }
    for (const site of this.payServiceSites)
      if (host === site || host.endsWith(`.${site}`)) return `site:${site}`
    return undefined
  }

  /** A tab closed (by the user or tab cleanup): removes its records and expires approvals waiting on it */
  forgetTab(tabId: number) {
    this.pages.delete(tabId)
    this.guided.delete(tabId)
    this.handedOff.delete(tabId)
    this.dialogs.delete(tabId)
    this.payFlows.delete(tabId)
    // A payment window closed (many close by themselves after paying): remove it from the group, and close the group when all are closed
    for (const x of this.liveSessions())
      if (x.tabs.delete(tabId) && !x.tabs.size) this.sessions.delete(x.approvalId)
    this.approvals.expireTab(tabId)
    if (this._lastTabId === tabId) this._lastTabId = undefined
  }

  /** If a newly entered site has a service tool, tells the AI to use it (faster and more accurate than pressing screens one by one) */
  private async guideFor(tabId: number, url: string): Promise<string | undefined> {
    const svc = await this.siteConnector?.(url).catch(() => undefined)
    if (svc) {
      if (this.guided.get(tabId) === svc.id) return undefined
      this.guided.set(tabId, svc.id)
      return `📘 This site (${svc.name}) has Dool2 service tools: ${svc.tools.join(', ')}. Use these tools first rather than pressing screens one by one (service_call if not in the visible tool list). Continue in the browser only for what the tools cannot do.`
    }
    return undefined
  }

  /** Screen after a new password was entered: if finished, put it in the vault; if the account already exists, discard it */
  private async settlePassword(s: {
    url: string
    title?: string
    text: string
  }): Promise<string | undefined> {
    this.pendingPw = this.pendingPw.filter((p) => Date.now() - p.at < 60 * 60_000)
    const key = siteKey(s.url)
    const p = this.pendingPw.find((x) => x.key === key)
    if (!p) return undefined
    const now = { url: s.url, title: s.title ?? '', text: s.text }
    // The screen right after entering is the baseline (text already on the signup page like "already a member?" does not count)
    if (!p.base) {
      p.base = now
      return undefined
    }
    const r = accountOutcome(now, p.base)
    if (!r) return undefined
    this.pendingPw = this.pendingPw.filter((x) => x !== p)
    if (r === 'exists')
      return `🔐 "${p.username}" is said to be already registered. The generated password was discarded (not put in the vault). Stop signing up and switch to login: if the password is unknown, use password reset (after the user confirms, purpose: "reset").`
    await this.vault?.savePassword?.(p.origin, p.username, p.password)
    this.onAccountSaved?.(s.url)
    return p.purpose === 'reset'
      ? `🔐 Confirmed the password change finished and saved the new password in the vault (${p.username}). Dool2 logs in with it from now on.`
      : `🔐 Confirmed signup finished and saved it in the vault (${p.username}). Dool2 logs in with this account from now on.`
  }

  /** Values from a login card: put in the vault but marked 'unconfirmed' (the daemon calls this right after saving) */
  markUnverified(origin: string) {
    this.unverified.add(origin)
  }

  /**
   * Screen read after logging in with vault values. Whether it worked is not decided by rules; the AI judges from the screen:
   * moving to a screen without a password field counts as success (the unconfirmed mark is removed); still on the login screen leaves the judgment to the AI
   */
  private async settleLogin(tabId: number, s: Snapshot): Promise<string | undefined> {
    const t = this.loginTries.get(tabId)
    if (!t) return undefined
    let origin = ''
    try {
      origin = new URL(s.url).origin
    } catch {}
    if (origin === t.origin && s.text.includes(ROLE.password))
      return '🔑 Just tried to log in with vault values. If this screen says login failed (a wrong ID or password notice, the same login screen as before), report it by calling browser_login with failed: true and reason (what the screen said). If the button is not pressed yet, press the login button first.'
    // Moved to a screen without a password field: success
    this.loginTries.delete(tabId)
    this.unverified.delete(t.origin)
    return undefined
  }

  /** The AI saw on screen that "login failed": if the values just came from a card, remove them from the vault so they can be received again */
  private async loginFailed(tabId: number, reason: string): Promise<ToolResult> {
    const t = this.loginTries.get(tabId)
    let origin = t?.origin
    if (!origin)
      try {
        origin = new URL(this.pages.get(tabId)?.url ?? '').origin
      } catch {}
    if (!origin)
      throw new Error("I don't know which site's login this is. Read the page again (browser_read)")
    this.loginTries.delete(tabId)
    const fresh = this.unverified.has(origin)
    if (fresh && t) await this.vault?.remove?.(t.entryId)
    // A value saved before may have changed: allow showing the card again (the new value overwrites the old)
    this.unverified.add(origin)
    const why = reason ? `("${reason.slice(0, 60)}")` : ''
    return {
      content: [
        {
          type: 'text',
          text: fresh
            ? `🔑 Login failed${why}. The ID and password from the card were wrong, so they were removed from the vault. Show the card again with browser_request_login to get them (if the user does not know the password, use password reset).`
            : `🔑 Login failed${why}. The value in the vault seems to have changed. Show the card with browser_request_login to get the new value (it overwrites the old one). If the user does not know the password, use password reset.`,
        },
      ],
    }
  }

  /** Wait: waits until the screen changes (at most ms) and reports what changed. The AI judges whether it worked by reading the screen */
  private async waitChange(tabId: number, a: Record<string, unknown>): Promise<ToolResult> {
    const ms = Math.min(Math.max(Number(a.ms) || 3_000, 100), 10_000)
    const r = (await this.browser.call(
      'wait',
      { tabId, ms, until: a.until === 'time' ? 'time' : 'change' },
      ms + 20_000,
    )) as BrowserState & {
      title?: string
      waitedMs?: number
      changed?: boolean
      what?: string[]
      dialogNotes?: SiteDialog[]
    }
    const sec = ((r.waitedMs ?? ms) / 1000).toFixed(1)
    if (r.dialog) this.dialogs.set(tabId, r.dialog)
    const lines = [
      `${tabTag(tabId)} ${r.title || '(no title)'} — ${r.url ?? ''}`,
      r.changed
        ? `Waited ${sec} seconds. What changed:`
        : `Waited ${sec} seconds, but the screen did not change.`,
      ...(r.what ?? []).map((w) => `- ${w}`),
      ...dialogLines(r.dialogNotes ?? []),
      ...(r.dialog ? openDialogLines(r.dialog) : []),
      ...(r.changed && !r.dialog ? ['Read the screen with browser_read to see what happened.'] : []),
    ]
    return { content: [{ type: 'text', text: lines.join('\n') }] }
  }

  /** Dool2 tab list: where new windows and payment windows opened, blocked new windows, tabs closed by cleanup */
  private async tabList(a: Record<string, unknown>): Promise<ToolResult> {
    const tabId = Number(a.tabId)
    const r = (await this.browser.call('tabs', Number.isInteger(tabId) ? { tabId } : {})) as {
      tabs?: {
        tabId: number
        url: string
        title: string
        opener?: number
        createdAt?: number
        windowType?: string
        active?: boolean
        loading?: boolean
        held?: boolean
        sleeping?: boolean
      }[]
      closed?: { tabId: number; opener?: number; url: string; title: string; closedAt?: number }[]
      tidied?: { tabId: number; url: string; title: string; why: string; at: number }[]
      blockedPopups?: { tabId: number; url: string; at: number }[]
    }
    const ago = (t?: number) => {
      if (!t) return ''
      const m = Math.round((Date.now() - t) / 60_000)
      return m < 1 ? 'just now' : `${m} min ago`
    }
    const tabs = r.tabs ?? []
    const lines = [
      `Dool2 tabs (${tabs.length}):`,
      ...tabs.map((t) => {
        const bits = [
          t.opener !== undefined ? `window opened by tab ${t.opener}` : '',
          t.windowType && t.windowType !== 'normal' ? `${t.windowType} window` : '',
          t.active ? 'front tab' : '',
          t.loading ? 'loading' : '',
          t.held ? 'held' : '',
          t.sleeping ? 'sleeping' : '',
          t.createdAt ? `opened ${ago(t.createdAt)}` : '',
        ].filter(Boolean)
        return `- ${tabTag(t.tabId)} ${t.title || '(no title)'} — ${t.url}${bits.length ? ` (${bits.join(' · ')})` : ''}`
      }),
      ...((r.closed ?? []).length
        ? [
            'Recently closed new windows:',
            ...(r.closed ?? []).map(
              (c) =>
                `- tab ${c.tabId}${c.opener !== undefined ? ` (window opened by tab ${c.opener})` : ''} ${c.title || ''} — ${c.url || '(unknown URL)'}, closed ${ago(c.closedAt)}`,
            ),
          ]
        : []),
      ...((r.blockedPopups ?? []).length
        ? [
            'New windows Chrome blocked (popup blocker):',
            ...(r.blockedPopups ?? []).map(
              (b) =>
                `- from tab ${b.tabId} ${ago(b.at)}: ${b.url || '(blank window without a URL: it may be a window that submits a payment form)'}`,
            ),
          ]
        : []),
      ...((r.tidied ?? []).length
        ? [
            'Tabs Dool2 closed while tidying up:',
            ...(r.tidied ?? []).map((t) => `- tab ${t.tabId} ${t.title || t.url} — ${t.why}, ${ago(t.at)}`),
          ]
        : []),
    ]
    return { content: [{ type: 'text', text: lines.join('\n') }] }
  }

  /** If a guessed deep URL is a 'missing page', tells the AI to find its way from the home page (measured 11-22 guessing Naver Pay and Coupang attendance URLs) */
  private notFoundHint(url: string, out: ToolResult): ToolResult {
    const head = out.content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n')
      .slice(0, 1500)
    if (!NOT_FOUND_WORDS.test(head)) return out
    let home = ''
    try {
      const u = new URL(url)
      if (u.pathname.length > 1) home = `${u.origin}/`
    } catch {}
    if (!home) return out
    return {
      ...out,
      content: [
        ...out.content,
        {
          type: 'text',
          text: `⚠️ This page does not exist. Do not guess and reopen URLs; open the home page (${home}) and find it through the menu or search.`,
        },
      ],
    }
  }

  private async read(
    tabId: number,
    maxChars?: unknown,
    note?: string,
    scope: { view?: boolean; from?: string; skip?: number } = {},
  ): Promise<ToolResult> {
    const max = Number(maxChars) || 8_000
    const partial = Boolean(scope.view || scope.from || scope.skip)
    let s = (await this.browser.call('snapshot', { tabId, maxChars: max, ...scope })) as Snapshot
    const notes = [...(s.dialogNotes ?? [])]
    // Sites that draw late show a blank screen right after opening (CatchTable: only 4 links). Wait once and read again
    if (!s.dialog && !partial && nearlyEmpty(s.text)) {
      await new Promise((r) => setTimeout(r, 1500))
      s = (await this.browser.call('snapshot', { tabId, maxChars: max })) as Snapshot
      notes.push(...(s.dialogNotes ?? []))
    }
    // Windows covering the screen (cookie consent, ads, urgency popups) are not closed silently: only the close button ref is reported and the AI decides
    // (before, Dool2 pressed them silently on every read. Because of measured 2026-11-18 Hotels.com: a cookie banner layer covered [Book])
    const cover = !s.dialog ? coverLine(s.text) : undefined
    if (s.dialog) {
      // While a confirm dialog is open, the page is frozen: report only the dialog and keep the refs read before
      this.dialogs.set(tabId, s.dialog)
      return {
        content: [
          {
            type: 'text',
            text: [
              ...(note ? [note] : []),
              `${tabTag(tabId)} ${s.title || '(no title)'} — ${s.url}`,
              ...dialogLines(notes),
              ...openDialogLines(s.dialog),
            ].join('\n'),
          },
        ],
      }
    }
    this.dialogs.delete(tabId)
    const info = pageInfo(s.url, s.text)
    this.pages.set(tabId, info)
    const accountNote = await this.settlePassword(s)
    const loginNote = await this.settleLogin(tabId, s)
    // If "please choose an option" appeared after pressing the buy button, tell how to point at the option field and choose
    const optionNote =
      notes.some((d) => d.type !== 'beforeunload' && NEED_OPTION.test(d.message)) ||
      OPTION_FIRST_WORDS.test(s.text)
        ? (() => {
            const fields = optionFields(info.refs)
            return `🧩 An option must be chosen first.${fields.length ? ` Option fields: ${fields.join(' ')}.` : ''} See the list with browser_select(ref), choose the option the user named (else the remembered size or color) with choose, then press the buy button again. If nothing is remembered either, ask the user once (with what can be chosen from the list and what is sold out).`
          })()
        : undefined
    const guide = await this.guideFor(tabId, s.url)
    const ses = this.paySession(tabId)
    const flow = ses ? undefined : this.payFlow(tabId)
    const lines = [
      ...(note ? [note] : []),
      `${tabTag(tabId)} ${s.title || '(no title)'} — ${s.url}`,
      ...(cover ? [cover] : []),
      ...(accountNote ? [accountNote] : []),
      ...(loginNote ? [loginNote] : []),
      ...(optionNote ? [optionNote] : []),
      ...(ses
        ? [
            `💳 Paying (group: ${[...ses.tabs].map((t) => `tab ${t}`).join('·')}). Buttons inside the payment company window are not approved again. When the order complete screen and order number show, finish with browser_order_done.`,
            ...(info.confirmed
              ? [
                  `✅ The screen shows "${info.confirmed}". If the order is complete, read the order number and call browser_order_done(order_no).`,
                ]
              : []),
          ]
        : []),
      ...(flow && info.confirmed
        ? [
            `⚠ The screen shows "${info.confirmed}". The booking or order may already be confirmed. Tell the user as it is and check it on the history screen.`,
          ]
        : flow && info.checkout
          ? [
              `💳 This is a checkout screen ('${info.checkout}'). Read the final amount, cancellation policy and booker details, and get the final button approved only once with browser_checkout (payment card). Before that, open this screen's change-address control (its name differs by site), read the other saved addresses and close it, then put goods (goods), amount lines (lines), final amount (total), delivery (ship_to, ship_options), payment methods (choices) and info lines (info: arrival, requests, booker) on one card. If a payment PIN keypad appears, get a cropped image per button with browser_request_code(kind: "pin", key_refs: the keypad button refs), map the digits (keys) and call again to get the PIN on the phone secure keypad. Only fields only a person can fill, like a new card number used for the first time, are an emergency (browser_handoff, emergency).`,
            ]
          : []),
      ...(s.captcha
        ? [
            '⚠ A robot check (CAPTCHA) is showing. If it is a CAPTCHA where text is typed, get it through a phone card with the image via browser_request_code(kind: "captcha") (do not read and type the text yourself). If it is solved by tapping an image (tap a spot on a map, choose tiles), look at the screen with browser_screenshot, then send the image to the phone with browser_request_tap(box: puzzle image spot, say: puzzle text) so the user taps it. If it is a single "I\'m not a robot" check, press it yourself. Never hand the PC screen to the person.',
          ]
        : []),
      ...(guide ? [guide] : []),
      ...dialogLines(notes),
      ...scopeLines(s, scope),
      ...(!partial && nearlyEmpty(s.text)
        ? [
            '⚠ The screen has almost no text. The URL may be wrong (addresses that do not exist on the site show only a blank screen). Open the site home and search with its search box. Try other ways before handing off to the person.',
          ]
        : []),
      '',
      s.text || '(No text to read. If the screen is still drawing, read again in a moment)',
      ...(s.around?.below
        ? [
            '',
            `↓ About ${s.around.below.toLocaleString()} more characters are below the screen. Scroll down with browser_scroll and read again with view.`,
          ]
        : []),
      ...(s.truncated
        ? [
            '',
            `(The text is long, so only ${max} characters are shown. To continue, read again with skip: ${(s.skipped ?? 0) + (s.mainLength ?? s.text.length)}; to jump to a part, put its text in from to read from that line)`,
          ]
        : []),
    ]
    return { content: [{ type: 'text', text: lines.join('\n') }] }
  }
}

/** Line telling which part was read (view, from, skip) */
export function scopeLines(
  s: { around?: { above: number; below: number }; skipped?: number; fromMissing?: boolean },
  scope: { view?: boolean; from?: string; skip?: number },
): string[] {
  const out: string[] = []
  if (scope.view)
    out.push(
      `(Read only the part visible on screen${s.around?.above ? `. ↑ about ${s.around.above.toLocaleString()} characters above` : ''})`,
    )
  if (scope.from && s.fromMissing)
    out.push(`(Could not find "${scope.from}" on the page, so read from the start)`)
  else if (s.skipped) out.push(`(Skipped the first ${s.skipped.toLocaleString()} characters)`)
  return out
}

/** Lines telling the AI about dialogs Dool2 closed right away (messages sites give only in a dialog: "wrong password" etc.) */
export function dialogLines(notes: SiteDialog[]): string[] {
  return notes.map((d) =>
    d.type === 'beforeunload'
      ? '💬 A dialog asked whether to leave the page, so [Leave] was pressed.'
      : `💬 Site alert: "${d.message.slice(0, 300)}" (closed with [OK])`,
  )
}

/** Lines telling the AI about an open confirm dialog */
export function openDialogLines(d: SiteDialog): string[] {
  const ask =
    d.type === 'prompt'
      ? `Use browser_dialog with the text to enter (text) and either [OK] (accept: true) or [Cancel] (accept: false).${d.defaultPrompt ? ` (prefilled text: "${d.defaultPrompt.slice(0, 100)}")` : ''}`
      : 'Use browser_dialog to choose [OK] (accept: true) or [Cancel] (accept: false).'
  return [
    '',
    `⚠ A site confirm dialog is open: "${d.message.slice(0, 500)}"`,
    `The page is frozen until one is chosen, so nothing can be read or pressed. ${ask} If one side does not match the user's request, [Cancel].`,
  ]
}

/** A screen with almost no text apart from refs (e12) (still drawing, or a wrong URL) */
export function nearlyEmpty(text: string): boolean {
  const words = text.replace(/\[e\d+ [^\]]*\]/g, '').replace(/\s+/g, '')
  return words.length < 8
}

/**
 * One line about a window covering the screen: the reject button of a cookie consent banner, the close button of an ad or urgency popup. Not pressed (the AI decides whether to close it).
 * undefined if none
 */
export function coverLine(text: string): string | undefined {
  const refs = parseRefs(text)
  const show = (ref: string, what: string) => {
    const c = refs.get(ref)
    return `🪟 Covering window: [${ref} ${c?.role ?? ROLE.button} "${c?.name ?? ''}"] (${what}). If it hides the task, close it with browser_click.`
  }
  const cookie = cookieReject(text)
  if (cookie) return show(cookie, 'reject on a cookie consent banner')
  const promo = promoClose(text)
  return promo ? show(promo, 'close on an ad or urgency popup') : undefined
}

/** Decodes a text piece the phone sent (as is if broken) */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
