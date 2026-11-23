// Connecting a service: the Dool2 daemon logs in itself with the ID and password the user put on the login card
// (the AI never sees them).
// 1) Open the site and find the login page (if there is no password field, press a "login" link or button)
// 2) Fill the vault values and press the login button (Enter if there is none)
// 3) Read the result from the page text: signed in / CAPTCHA or identity check (a person must act) / wrong ID or
//    password / unknown
import type { Lang } from '@dool2/i18n'
import type { ConnectStep } from '@dool2/protocol'
import type { ConnectCard } from '@dool2/protocol/connect'
import { fillPassword, parseRefs } from './browser-tools.js'
import { looksSignedIn, signedInHow } from './connect-watch.js'
import { autoLoginText, PROVIDER_NAMES } from './locales/auto-login.js'
import {
  ACCOUNT_CHOOSER,
  ACCOUNT_SWITCH,
  ALREADY_JOINED,
  ANSWER_SUBMIT,
  APP_CONFIRM,
  ASKS_ID,
  BARE_ICON_RE,
  BUSINESS_LOGIN,
  CAPTCHA,
  CERT_ACTION,
  CERT_FIELDS,
  CERT_PASS,
  CERT_REQUIRED,
  CERT_TOSS,
  CERT_WORD,
  CHANGE_ACCOUNT,
  CHECKED_RE,
  CODE_FIELD,
  CODE_HINT,
  COMPANY_SNS,
  CONFIRM_APP,
  CONSENT,
  DORMANT,
  DORMANT_CERT_FIELD,
  DORMANT_DEFAULT_WHY,
  DORMANT_SUBMIT,
  FIELD_REF,
  FIND_RESET,
  FRAME_HEADING,
  GOOGLE_ACCOUNT,
  HUMAN_CAPTCHA,
  HUMAN_CERT,
  ID_IS,
  ID_LOGIN,
  ID_LOGIN_LOOSE,
  JOIN_HUMAN,
  JOIN_HUMAN_NOTE,
  JOIN_PAGE,
  JOIN_SUBMIT,
  JOIN_WORD,
  KAKAO_ACCOUNT,
  KEEP_SIGNED_IN,
  LINK_REF,
  LOGIN_HEADING,
  LOGIN_LINK,
  LOGIN_OR_JOIN,
  LOGIN_WORD,
  MORE_OPTIONS,
  MY_PAGE,
  NAVER_ACCOUNT,
  NEW_WINDOW,
  NEXT,
  NOT_MEMBER,
  OWN_ID,
  PASSWORD_REF,
  POPUP_CLOSE,
  POPUP_DONT_SHOW,
  PROVIDER_LOGIN_WORD,
  PROVIDER_NOISE,
  RADIO_ACCOUNT,
  REMEMBER_BROWSER,
  REQUIRED_CHECK,
  REQUIRED_OR_ALL,
  REQUIRED_WORD,
  ROLE,
  SELECTED,
  SIGNED_IN_ACCOUNT,
  SOCIAL,
  SOCIAL_BUTTON,
  SOCIAL_ENTRY,
  STEP2,
  TEL_FIELD,
  UNIFIED_ACCOUNT,
  USER_FIELD,
  VALUE_MARK,
  WRONG,
} from './region/kr/auto-login.js'
import { checkSignedIn } from './signin-check.js'

export interface AutoLoginBrowser {
  call(method: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

export interface AutoLoginInput {
  card: Pick<ConnectCard, 'id' | 'name' | 'signedIn'> & { site?: string; login?: string }
  url: string
  username: string
  password: string
  ask?: LoginAsk
  /** Current step (shown on the phone's connect card). Never includes the values (ID, password) */
  step?: StepFn
  /** Tab being logged in (the phone's connect card shows that screen). Called again when a new window opens */
  onTab?: (tabId: number) => void
  /** Language of the steps, results and questions people read. Defaults to Korean */
  lang?: Lang
}

/** Asking on the phone's input screen instead of handing the screen to a person (faster and easier than remote view) */
export interface LoginAsk {
  /** Gets a provider account's (Kakao etc.) ID and password on the phone, stores it in the vault and returns it */
  credentials?(
    origin: string,
    site: string,
    tabId: number,
  ): Promise<{ username: string; password: string } | undefined>
  /** What the page asks for (verification code, phone number) */
  info?(req: {
    field: 'otp' | 'tel' | 'text' | 'choice'
    label: string
    hint?: string
    host: string
    options?: string[]
  }): Promise<string | undefined>
  /** Account picked before when the provider has several (text as shown on the page) */
  account?: {
    get(provider: SocialProvider): string | undefined
    set(provider: SocialProvider, label: string): void
  }
  /**
   * Provider accounts the user confirmed as theirs (text on the consent page: Kakao "f***@gmail.com").
   * An account not seen before is asked about once before pressing consent (so no wrong account gets joined or linked)
   */
  known?: {
    has(provider: SocialProvider, label: string): boolean
    add(provider: SocialProvider, label: string): void
  }
}

/**
 * Whether two labels are the same account: same text, or when one is a masked email (f***@gmail.com), the leading
 * letters and domain match. Kakao's consent page sometimes masks the same account and sometimes shows it in full
 * (measured 2026-11-19)
 */
export function sameAccount(a: string, b: string): boolean {
  const x = a.trim().toLowerCase()
  const y = b.trim().toLowerCase()
  if (x === y) return true
  const [xu = '', xd = ''] = x.split('@')
  const [yu = '', yd = ''] = y.split('@')
  if (!xd || xd !== yd || !(xu.includes('*') || yu.includes('*'))) return false
  const head = (u: string) => u.replace(/\*.*$/, '')
  const [masked, full] = xu.includes('*') ? [xu, yu] : [yu, xu]
  if (full.includes('*')) return head(masked) === head(full) && head(masked).length > 0
  return head(masked).length > 0 && full.startsWith(head(masked))
}

/**
 * Account currently logged in on a provider's account page (measured 2026-11-19): Kakao accounts.kakao.com,
 * Naver's home page, Google's account label
 */
export function providerAccountIn(provider: SocialProvider, text: string): string | undefined {
  if (provider === 'kakao') return KAKAO_ACCOUNT.exec(text)?.[1]
  if (provider === 'naver') return NAVER_ACCOUNT.exec(text)?.[1]
  if (provider === 'google') return GOOGLE_ACCOUNT.exec(text)?.[1]
  return undefined
}

/**
 * Checked checkboxes. Skips ']' inside the name ("[required]") and looks for the checked mark after the quote:
 * the old pattern stopped at the ']' in the name, saw a checked box as unchecked and pressed it again to uncheck it
 * (measured on Naver consent: 29CM, Airbnb, MyRealTrip, Asiana, Eastar)
 */
export function checkedRefs(text: string): Set<string> {
  return new Set([...text.matchAll(CHECKED_RE)].map((m) => m[1] as string))
}

/** The "keep me signed in" checkbox on a login page (its mark, when not checked yet) */
export function keepSignedIn(text: string): string | undefined {
  const m = KEEP_SIGNED_IN.exec(text)
  return m && !SELECTED.test(m[2] ?? '') ? m[1] : undefined
}

/** Account currently logged in, as shown on a provider consent page (Kakao's label, or Google's single email) */
export function providerAccountOn(text: string): string | undefined {
  const kakao = SIGNED_IN_ACCOUNT.exec(text)
  if (kakao) return kakao[1]
  const mail = /(?:^|[\s"(])([\w.*+-]+@[\w-]+(?:\.[\w-]+)+)/.exec(said(text))
  return mail?.[1]
}

/**
 * When the page asks for a verification code or phone number, gets it on the phone's input screen, fills it and
 * presses confirm. done: filled and pressed / none: nothing to ask / cancel: the user did not enter it
 */
async function answerOnScreen(
  browser: AutoLoginBrowser,
  tabId: number,
  page: Snap,
  ask: LoginAsk | undefined,
  asked: Set<string>,
  lang: Lang = 'ko',
): Promise<'done' | 'none' | 'cancel'> {
  if (!ask?.info) return 'none'
  const refs = [...parseRefs(page.text)] as RefEntry[]
  const inputs = refs.filter(([, r]) => r.role === ROLE.input && !VALUE_MARK.test(r.name))
  const code = inputs.find(([, r]) => CODE_FIELD.test(r.name))
  const tel = inputs.find(([, r]) => TEL_FIELD.test(r.name))
  const target = code ?? tel
  if (!target) return 'none'
  const key = `${page.url}|${target[1].name}`
  if (asked.has(key)) return 'none'
  asked.add(key)
  // One line of page guidance (e.g. "enter the 6 digits sent by KakaoTalk")
  const hint = page.text
    .split('\n')
    // Drop the page reading's marks (heading #, list -, [e3 button …]) and keep only what people read
    .map((l) =>
      l
        .replace(/\[[^\]]*\]/g, '')
        .replace(/^\s*(#+|[-*•]|\d+\.)\s*/, '')
        .trim(),
    )
    .find((l) => l.length >= 8 && l.length <= 80 && CODE_HINT.test(l))
  const host = (() => {
    try {
      return new URL(page.url).hostname
    } catch {
      return ''
    }
  })()
  const value = await ask.info({
    field: code ? 'otp' : 'tel',
    label: target[1].name || (code ? autoLoginText(lang).codeLabel : autoLoginText(lang).telLabel),
    ...(hint ? { hint } : {}),
    host,
  })
  if (!value) return 'cancel'
  // The page may have been read again while the person was typing (phone remote view, work view), which changes
  // the marks (numbers like e12). Read the page again before filling and pressing and find the field and button
  // by name (pressing an old mark failed silently)
  const fresh = async () => {
    const now = (await browser.call('snapshot', { tabId, maxChars: 12_000 }).catch(() => undefined)) as
      | Snap
      | undefined
    return now ? ([...parseRefs(now.text)] as RefEntry[]) : refs
  }
  let cur = await fresh()
  const field = cur.find(([, r]) => r.role === ROLE.input && r.name === target[1].name) ?? target
  await browser.call('type', { tabId, ref: field[0], text: value })
  cur = await fresh()
  const at = cur.findIndex(([, r]) => r.role === ROLE.input && r.name.startsWith(target[1].name))
  const after = at >= 0 ? cur.slice(at + 1) : cur
  const submit = after.find(([, r]) => r.role === ROLE.button && ANSWER_SUBMIT.test(r.name.trim()))
  const clicked = submit
    ? await browser.call('click', { tabId, ref: submit[0] }, 30_000).then(
        () => true,
        () => false,
      )
    : false
  if (!clicked) await browser.call('press', { tabId, key: 'Enter' }).catch(() => undefined)
  return 'done'
}

export type AutoLoginResult = (
  | { status: 'ok'; tabId: number }
  | { status: 'human'; tabId: number; reason: string }
  | { status: 'wrong'; tabId: number; message: string }
  | { status: 'unknown'; tabId: number; message: string }
) & {
  /** Address of the page the password went into (may differ from the site's home, so the vault stores it too) */
  loginOrigin?: string
}

interface Snap {
  url: string
  title?: string
  text: string
  captcha?: boolean
}

const HUMAN = new RegExp(`${CAPTCHA.source}|${STEP2.source}`, 'i')
/**
 * Only what the page says to people (link text removed). Extra checks, wrong passwords, CAPTCHAs and app approvals
 * show up as sentences, fields and buttons. Links are often list titles: the Naver Mail inbox subject "new sign-in
 * from a new environment" was read as a 2-step check and an inbox that was already signed in ended as a failure
 * (measured 2026-11-19)
 */
export function said(text: string): string {
  return text.replace(LINK_REF, '')
}
/** Longest wait for an app approval (APP_CONFIRM: KakaoTalk, Naver app, Google, Toss push; nothing to fill) */
export const CONFIRM_WAIT_MS = 3 * 60_000

export type StepFn = (text: string, ask?: ConnectStep['ask']) => void

/** Which app to approve in (guessed from the page text) */
function confirmWhere(text: string, lang: Lang = 'ko'): string {
  const m = autoLoginText(lang)
  if (CONFIRM_APP.kakaoTalk.test(text)) return m.whereKakaoTalk
  if (CONFIRM_APP.naverApp.test(text)) return m.whereNaverApp
  if (CONFIRM_APP.toss.test(text)) return m.whereToss
  if (CONFIRM_APP.phone.test(text)) return m.wherePhone
  return m.wherePhoneApp
}

/**
 * On an app approval page, shows "approve in …" on the card and waits until the page changes (up to 3 minutes).
 * 'moved' when it changed, 'timeout' when time ran out, 'none' when it is not an approval page
 */
async function waitConfirm(
  page: Snap,
  tabId: number,
  snap: (tabId: number) => Promise<Snap>,
  step: StepFn | undefined,
  wait: number,
  lang: Lang = 'ko',
  limitMs = CONFIRM_WAIT_MS,
): Promise<'none' | 'moved' | 'timeout'> {
  if (hasPassword(page.text) || !APP_CONFIRM.test(said(page.text))) return 'none'
  const m = autoLoginText(lang)
  const where = confirmWhere(page.text, lang)
  step?.(m.confirmIn(where), {
    kind: 'confirm',
    id: String(tabId),
    label: m.viewScreen,
    detail: m.confirmDetail(where),
  })
  const until = Date.now() + limitMs
  while (Date.now() < until) {
    await sleep(Math.max(wait, 2_000))
    const now = await snap(tabId).catch(() => undefined)
    if (now && !APP_CONFIRM.test(said(now.text))) {
      step?.(m.confirmed)
      return 'moved'
    }
  }
  return 'timeout'
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Waits until the page is drawn (when there is hardly any text, waits a little and reads again) */
async function settled(snap: () => Promise<Snap>, wait: number): Promise<Snap> {
  let page = await snap()
  // Hardly any text, or only two or three things to press: still drawing (sites that show the login form late)
  const fields = (p: Snap) => FIELD_REF.test(p.text)
  // A login address without any field is still drawing the body (KT draws only the footer first)
  const loginPath = (p: Snap) => {
    try {
      return /log-?in|sign-?in|auth|member|account/i.test(new URL(p.url).pathname)
    } catch {
      return false
    }
  }
  const thin = (p: Snap) =>
    p.text.replace(/\s/g, '').length < 12 ||
    // Fewer than three named things: only the shell is drawn (CatchTable shows four unnamed links first)
    ((p.text.match(/\[e\d+ [^\]"]*"[^"]+"/g)?.length ?? 0) < 3 && !fields(p)) ||
    // A page with only social login ("start with Kakao") is fully drawn even without fields.
    // A "login" button in the top menu, or a frame inside the page (Google button), does not mean the body is drawn
    (loginPath(p) && !fields(p) && !SOCIAL_ENTRY.test(p.text.split(FRAME_HEADING)[0] ?? ''))
  for (let i = 0; i < 4 && thin(page); i++) {
    await sleep(Math.max(wait, 800))
    page = await snap()
  }
  return page
}

/** Ad or notice popups covering the home page ("don't show today", "close"). The login button under them can't be pressed */
const hasPopup = (text: string) =>
  ([...parseRefs(text)] as RefEntry[]).some(
    ([, r]) => (r.role === ROLE.button || r.role === ROLE.link) && POPUP_CLOSE.test(r.name.trim()),
  )
async function closePopups(
  browser: AutoLoginBrowser,
  tabId: number,
  page: Snap,
  snap: (tabId: number) => Promise<Snap>,
  wait: number,
): Promise<Snap> {
  // "Don't show today" first when present (so it stays closed), at most twice
  for (let i = 0; i < 2; i++) {
    const refs = ([...parseRefs(page.text)] as RefEntry[]).filter(
      ([, r]) => (r.role === ROLE.button || r.role === ROLE.link) && POPUP_CLOSE.test(r.name.trim()),
    )
    const target = refs.find(([, r]) => POPUP_DONT_SHOW.test(r.name)) ?? refs[0]
    if (!target) break
    await browser.call('click', { tabId, ref: target[0] }, 15_000).catch(() => undefined)
    await sleep(Math.min(wait, 800))
    page = await snap(tabId)
  }
  return page
}

export interface ProbeResult {
  /** Tabs the check opened (to close them) */
  tabs?: number[]
  status: 'found' | 'human' | 'unknown' | 'signed-in'
  url: string
  /** For checks: whether the extension saw a CAPTCHA, and the start of the page text */
  captcha?: boolean
  sample?: string
  title?: string
  userField?: string
  passwordField?: string
  submit?: string
  clicks: string[]
  /** Social logins seen on the login pages along the way */
  social?: SocialProvider[]
}

/** Check: only finds the login fields, never fills or presses them (can they be found on the real site) */
export async function probeLogin(
  browser: AutoLoginBrowser,
  input: Pick<AutoLoginInput, 'card' | 'url'>,
  opts: { wait?: number; lang?: Lang } = {},
): Promise<ProbeResult & { tabId: number }> {
  const wait = opts.wait ?? 2_500
  const snap = async (tabId: number) => (await browser.call('snapshot', { tabId, maxChars: 30_000 })) as Snap
  const opened = (await browser.call('open', { url: input.url }, 40_000)) as { tabId: number }
  let tabId = opened.tabId
  /** Opened tabs (grows when login opens a new window) */
  const tabs = [tabId]
  const clicks: string[] = []
  let page = await settled(() => snap(tabId), wait)
  if (looksSignedIn(input.card, page)) return { status: 'signed-in', url: page.url, clicks, tabId }
  if (!hasPassword(page.text)) page = await closePopups(browser, tabId, page, snap, wait)
  const social = new Set<SocialProvider>(socialProvidersIn(page.text))
  let retried = false
  const tried = new Set<string>()
  for (let i = 0; i < 4 && !hasPassword(page.text) && !twoStep(page.text); i++) {
    const target = findLoginLink(page.text, tried)
    if (!target) {
      // The page may still be changing (moving to another address, or drawing late): wait once more
      if (retried) break
      retried = true
      await sleep(Math.max(wait, 1_500))
      page = await settled(() => snap(tabId), wait)
      i--
      continue
    }
    clicks.push(target[1].name)
    tried.add(target[1].name.trim())
    // Follow the new window (popup) when login opens one
    const clicked = (await browser.call('click', { tabId, ref: target[0] }, 30_000).catch(() => undefined)) as
      | { newTabId?: number }
      | undefined
    if (clicked?.newTabId) {
      tabId = clicked.newTabId
      tabs.push(tabId)
    }
    await sleep(wait)
    page = await settled(() => snap(tabId), wait)
    for (const p of socialProvidersIn(page.text)) social.add(p)
  }
  const base = {
    social: [...social],
    url: page.url,
    ...(page.title ? { title: page.title } : {}),
    clicks,
    tabId,
    tabs,
    captcha: Boolean(page.captcha),
    sample: page.text.slice(0, 1500),
  }
  // On a social login provider's page, the fields are not this service's login fields
  if (providerPage(page.url, input.card)) return { status: 'unknown', ...base }
  // Many login pages carry an invisible CAPTCHA (Coupang, 11st). Go on when fields are visible
  if (CAPTCHA.test(said(page.text))) return { status: 'human', ...base }
  const two = twoStep(page.text)
  if (two)
    return {
      status: 'found',
      ...base,
      userField: two.user[1].name,
      submit: autoLoginText(opts.lang ?? 'ko').twoStep(two.next[1].name),
    }
  if (!hasPassword(page.text))
    return { status: page.captcha || HUMAN.test(said(page.text)) ? 'human' : 'unknown', ...base }
  const f = loginFields(page.text)
  return {
    status: 'found',
    ...base,
    ...(f.user ? { userField: f.user[1].name } : {}),
    passwordField: f.password[1].name,
    ...(f.submit ? { submit: f.submit[1].name } : {}),
  }
}

type RefEntry = [string, { role: string; name: string }]

/** Links that only join or continue as a guest (fine when login is in the name too, like "login/join") */
const JOIN_ONLY = (name: string) =>
  (JOIN_WORD.test(name) && !LOGIN_LINK.test(name)) ||
  // Business, partner and seller logins are not user accounts
  BUSINESS_LOGIN.test(name)

/**
 * Whether the page is another company's social login page (Naver, Kakao, Google…). Arriving here while connecting
 * with ID and password would put the service ID into the provider's field — never fill it. Returns the provider
 */
function providerPage(url: string, card: { site?: string; login?: string }): SocialProvider | undefined {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return undefined
  }
  for (const [id, p] of Object.entries(SOCIAL_PROVIDERS) as [
    SocialProvider,
    (typeof SOCIAL_PROVIDERS)[SocialProvider],
  ][]) {
    if (!p.host.test(host)) continue
    // The Naver connect card on Naver's login page is fine
    if (card.site && p.host.test(card.site.replace(/^www\./, ''))) return undefined
    // Sites whose ID is that provider's account (TicketLink = PAYCO ID)
    if (card.login && p.button.test(card.login)) return undefined
    return id
  }
  return undefined
}

function findLoginLink(text: string, skip: ReadonlySet<string> = new Set()): RefEntry | undefined {
  const refs = ([...parseRefs(text)] as RefEntry[]).filter(
    ([, r]) =>
      (r.role === ROLE.link || r.role === ROLE.button) &&
      r.name.trim().length <= 24 &&
      // Pressed already and the page did not change: try another (don't keep pressing the top "login/join")
      !skip.has(r.name.trim()) &&
      // Finding or resetting an ID or password is not the login page
      !FIND_RESET.test(r.name) &&
      !SOCIAL.test(r.name) &&
      !JOIN_ONLY(r.name),
  )
  return (
    // Login method page: "email login", "log in with ID", "Musinsa unified account … login"
    refs.find(([, r]) => ID_LOGIN.test(r.name.trim())) ??
    refs.find(([, r]) => ID_LOGIN_LOOSE.test(r.name)) ??
    // Unified account with a name in front ("start with the Seoul unified account")
    refs.find(([, r]) => UNIFIED_ACCOUNT.test(r.name)) ??
    refs.find(([, r]) => LOGIN_WORD.test(r.name.trim())) ??
    refs.find(([, r]) => LOGIN_OR_JOIN.test(r.name.trim())) ??
    // Login method page: telecom and portal IDs (U+ID, T ID, KT ID…)
    refs.find(([, r]) => OWN_ID.test(r.name.trim())) ??
    refs.find(([, r]) => LOGIN_LINK.test(r.name)) ??
    // "More options" / "another way to log in" on a method page (email login is inside)
    refs.find(([, r]) => MORE_OPTIONS.test(r.name.trim())) ??
    // Icon-only sites: My page or My info leads to the login page
    refs.find(([, r]) => MY_PAGE.test(r.name.trim()))
  )
}

/** Two-step login (ID or email first → continue → password): the ID field and the continue button */
function twoStep(text: string): { user: RefEntry; next: RefEntry } | undefined {
  if (hasPassword(text)) return undefined
  const refs = [...parseRefs(text)] as RefEntry[]
  const inputs = refs.filter(([, r]) => r.role === ROLE.input)
  const user =
    refs.find(([, r]) => (r.role === ROLE.input || r.role === ROLE.search) && USER_FIELD.test(r.name)) ??
    // Only one unnamed field, and the page asks for an email or ID
    (inputs.length === 1 && ASKS_ID.test(text) ? inputs[0] : undefined)
  const next = refs.find(([, r]) => r.role === ROLE.button && NEXT.test(r.name.trim()))
  return user && next ? { user, next } : undefined
}

function loginFields(text: string) {
  const order = [...parseRefs(text)] as RefEntry[]
  const pwIndex = order.findIndex(([, r]) => r.role === ROLE.password)
  const password = order[pwIndex] as RefEntry
  const before = order.slice(0, pwIndex).filter(([, r]) => r.role === ROLE.input || r.role === ROLE.search)
  const user =
    before.findLast(([, r]) => USER_FIELD.test(r.name)) ??
    before.filter(([, r]) => r.role === ROLE.input).at(-1)
  const after = order.slice(pwIndex + 1)
  const submit =
    after.find(([, r]) => r.role === ROLE.button && LOGIN_WORD.test(r.name.trim())) ??
    after.find(([, r]) => r.role === ROLE.button && LOGIN_LINK.test(r.name))
  return { user, password, submit }
}

export async function autoLogin(
  browser: AutoLoginBrowser,
  input: AutoLoginInput,
  opts: { wait?: number; tries?: number } = {},
): Promise<AutoLoginResult> {
  const wait = opts.wait ?? 1_500
  const snap = async (tabId: number) => (await browser.call('snapshot', { tabId, maxChars: 30_000 })) as Snap
  const step = input.step ?? (() => {})
  const lang = input.lang ?? 'ko'
  const m = autoLoginText(lang)
  step(m.opening(input.card.name))
  const opened = (await browser.call('open', { url: input.url }, 40_000)) as { tabId: number }
  let tabId = opened.tabId
  input.onTab?.(tabId)
  /** Opened tabs (grows when login opens a new window) */
  const tabs = [tabId]

  // 1) Find the login page: press "login" until a password field shows (up to 3 times)
  let page = await settled(() => snap(tabId), wait)
  if (looksSignedIn(input.card, page)) return { status: 'ok', tabId }
  if (!hasPassword(page.text)) {
    step(m.findingLogin)
    page = await closePopups(browser, tabId, page, snap, wait)
  }
  let retried = false
  const tried = new Set<string>()
  for (let i = 0; i < 4 && !hasPassword(page.text) && !twoStep(page.text); i++) {
    const target = findLoginLink(page.text, tried)
    if (!target) {
      // The page may still be changing (moving to another address, or drawing late): wait once more
      if (retried) break
      retried = true
      await sleep(Math.max(wait, 1_500))
      page = await settled(() => snap(tabId), wait)
      i--
      continue
    }
    tried.add(target[1].name.trim())
    step(m.pressing(target[1].name.trim().slice(0, 20)))
    // Follow the new window (popup) when login opens one
    const clicked = (await browser.call('click', { tabId, ref: target[0] }, 30_000).catch(() => undefined)) as
      | { newTabId?: number }
      | undefined
    if (clicked?.newTabId) {
      tabId = clicked.newTabId
      tabs.push(tabId)
      input.onTab?.(tabId)
    }
    await sleep(wait)
    page = await settled(() => snap(tabId), wait)
  }
  const other = providerPage(page.url, input.card)
  if (other)
    return {
      status: 'unknown',
      tabId,
      message: m.providerPageStop(PROVIDER_NAMES[lang][other]),
    }
  if (CAPTCHA.test(said(page.text))) return { status: 'human', tabId, reason: humanReason(page.text, lang) }
  // Two steps: enter the ID and press continue, then the password field appears
  const two = twoStep(page.text)
  if (two) {
    const origin0 = new URL(page.url).origin
    step(m.enteringId)
    await browser.call('fill', { tabId, ref: two.user[0], value: input.username, origin: origin0 })
    await browser.call('click', { tabId, ref: two.next[0] }, 30_000).catch(() => undefined)
    await sleep(wait)
    page = await settled(() => snap(tabId), wait)
    if (hasPassword(page.text) && !loginFields(page.text).user) {
      // Only the password is left: enter it and press
      const f = loginFields(page.text)
      const o = new URL(page.url).origin
      step(m.enteringPasswordAndLogin)
      await fillPassword(browser, { tabId, ref: f.password[0] as string, value: input.password, origin: o })
      if (f.submit) await browser.call('click', { tabId, ref: f.submit[0] }, 30_000).catch(() => undefined)
      else await browser.call('press', { tabId, key: 'Enter' }).catch(() => undefined)
      step(m.checkingLogin)
      return watchResult(browser, input, tabId, o, wait, opts.tries ?? 8, snap)
    }
  }
  if (!hasPassword(page.text) && (page.captcha || STEP2.test(said(page.text))))
    return { status: 'human', tabId, reason: humanReason(page.text, lang) }
  if (!hasPassword(page.text)) {
    // No login fields may mean already signed in (measured on Threads: it stopped with "couldn't find the login
    // fields" on a home feed already signed in in Chrome, and the AI took over). Check up to My page and finish
    // when signed in
    if (input.card.site) {
      const r = await checkSignedIn(browser, {
        id: input.card.id,
        signedIn: input.card.signedIn,
        site: input.card.site,
      }).catch(() => undefined)
      if (r?.state === 'in') return { status: 'ok', tabId }
    }
    return {
      status: 'unknown',
      tabId,
      message: m.noLoginFields,
    }
  }

  // 2) Fill the fields (the extension checks the address again)
  const fields = loginFields(page.text)
  const pwRef = fields.password[0]
  const userRef = fields.user?.[0]
  const origin = new URL(page.url).origin
  const loginOrigin = origin
  step(m.enteringCreds)
  if (userRef) await browser.call('fill', { tabId, ref: userRef, value: input.username, origin })
  // A secure keypad field is typed with the on-screen keypad buttons (measured 11-21 Shinhan Card)
  await fillPassword(browser, { tabId, ref: pwRef as string, value: input.password, origin })

  // 3) Press login: the "login" button after the password field, else Enter
  step(m.pressingLogin)
  const submit = fields.submit
  if (submit) await browser.call('click', { tabId, ref: submit[0] }, 30_000).catch(() => undefined)
  else await browser.call('press', { tabId, key: 'Enter' }).catch(() => undefined)

  // 4) Read the result
  step(m.checkingLogin)
  return watchResult(browser, input, tabId, loginOrigin, wait, opts.tries ?? 8, snap)
}

/**
 * Whether the site page shows a login after logging in. A clear sign counts at once; a guess from the login entry
 * disappearing opens the site again and checks up to My page once (guessing alone said 'ok' and wrongly marked X
 * and Campit as connected, measured 2026-11-19)
 */
async function signedInAfter(
  browser: AutoLoginBrowser,
  card: AutoLoginInput['card'],
  page: Snap,
  state: { confirmed: number },
): Promise<boolean> {
  const how = signedInHow(card, page, { sawEntry: true })
  if (how === 'strong') return true
  if (how !== 'inverse' || state.confirmed >= 2 || !card.site) return false
  state.confirmed++
  const r = await checkSignedIn(browser, { id: card.id, signedIn: card.signedIn, site: card.site }).catch(
    () => undefined,
  )
  return r?.state === 'in'
}

/** After pressing login: signed in / wrong / a person's step / unknown */
async function watchResult(
  _browser: AutoLoginBrowser,
  input: AutoLoginInput,
  tabId: number,
  loginOrigin: string,
  wait: number,
  tries: number,
  snap: (tabId: number) => Promise<Snap>,
): Promise<AutoLoginResult> {
  let page: Snap | undefined
  const asked = new Set<string>()
  const confirmState = { confirmed: 0 }
  /** While waiting for the page to change after entering a code and pressing confirm (the same page shows a bit longer) */
  let grace = 0
  const lang = input.lang ?? 'ko'
  const m = autoLoginText(lang)
  for (let i = 0; i < tries; i++) {
    await sleep(wait)
    page = await snap(tabId).catch(() => page)
    if (!page) continue
    if (await signedInAfter(_browser, input.card, page, confirmState))
      return { loginOrigin, status: 'ok', tabId }
    // Page asks to approve in a phone app: tell the card and wait (nothing to fill)
    const confirm = await waitConfirm(page, tabId, snap, input.step, wait, lang)
    if (confirm === 'moved') {
      i = Math.max(0, i - 2)
      continue
    }
    if (confirm === 'timeout')
      return {
        loginOrigin,
        status: 'human',
        tabId,
        reason: m.confirmWaiting(confirmWhere(page.text, lang)),
      }
    // Wake a dormant account (the same page shows after an ID login too)
    const dormant = dormantScreen(page.text)
    if (dormant?.kind === 'human')
      return {
        loginOrigin,
        status: 'human',
        tabId,
        reason: m.dormantHuman(input.card.name, dormant.why),
      }
    if (dormant && !asked.has(`${page.url}|dormant`)) {
      asked.add(`${page.url}|dormant`)
      input.step?.(m.waking(input.card.name))
      for (const ref of dormant.required)
        await _browser.call('click', { tabId, ref }, 15_000).catch(() => undefined)
      await _browser.call('click', { tabId, ref: dormant.submit }, 30_000).catch(() => undefined)
      i = Math.max(0, i - 2)
      continue
    }
    if (STEP2.test(said(page.text)) && !CAPTCHA.test(said(page.text)) && !WRONG.test(said(page.text))) {
      // Page asks for a code: get it on the phone's input screen, fill it and keep watching
      input.step?.(m.waitingCode)
      const a = await answerOnScreen(_browser, tabId, page, input.ask, asked, lang)
      if (a === 'done') {
        grace = 3
        i = Math.max(0, i - 2)
        continue
      }
      if (grace-- > 0) continue
    }
    if (HUMAN.test(said(page.text)) && !WRONG.test(said(page.text)))
      return { loginOrigin, status: 'human', tabId, reason: humanReason(page.text, lang) }
    if (WRONG.test(said(page.text)))
      return {
        loginOrigin,
        status: 'wrong',
        tabId,
        message: m.wrong,
      }
  }
  return {
    loginOrigin,
    status: 'unknown',
    tabId,
    message: m.unknown,
  }
}

function hasPassword(text: string) {
  return PASSWORD_REF.test(text)
}

/**
 * On an identity check window (Toss, PASS, phone check: enter name, phone number and birth date, then approve in
 * the verification app), one sentence on what to do. Otherwise undefined
 */
export function certScreen(text: string, lang: Lang = 'ko'): string | undefined {
  const t = text.replace(/\s+/g, ' ')
  const toss = CERT_TOSS.test(t)
  const pass = CERT_PASS.test(t)
  const certFields = CERT_FIELDS.test(t)
  const certWord = CERT_WORD.test(t)
  if (!toss && !pass && !certFields && !(certWord && CERT_ACTION.test(t))) return undefined
  const m = autoLoginText(lang)
  const app = toss ? m.certToss : pass ? m.certPass : m.certOther
  return m.certScreen(app)
}

function humanReason(text: string, lang: Lang = 'ko') {
  const m = autoLoginText(lang)
  if (HUMAN_CAPTCHA.test(text)) return m.captcha
  if (HUMAN_CERT.test(text)) return m.identity
  return m.checkNeeded
}

// ── Social login (Kakao, Naver, Google…) ─────────────────────────────

/** Social login providers: Korean name (`label`, shown to people), button text on sites, provider login host */
export const SOCIAL_PROVIDERS = {
  kakao: { label: PROVIDER_NAMES.ko.kakao, button: SOCIAL_BUTTON.kakao, host: /(^|\.)kakao\.com$/ },
  naver: { label: PROVIDER_NAMES.ko.naver, button: SOCIAL_BUTTON.naver, host: /(^|\.)naver\.com$/ },
  google: { label: PROVIDER_NAMES.ko.google, button: SOCIAL_BUTTON.google, host: /(^|\.)google\.com$/ },
  apple: { label: PROVIDER_NAMES.ko.apple, button: SOCIAL_BUTTON.apple, host: /(^|\.)apple\.com$/ },
  facebook: {
    label: PROVIDER_NAMES.ko.facebook,
    button: SOCIAL_BUTTON.facebook,
    host: /(^|\.)facebook\.com$/,
  },
  payco: { label: PROVIDER_NAMES.ko.payco, button: SOCIAL_BUTTON.payco, host: /(^|\.)payco\.com$/ },
  toss: { label: PROVIDER_NAMES.ko.toss, button: SOCIAL_BUTTON.toss, host: /(^|\.)toss\.im$/ },
} as const
export type SocialProvider = keyof typeof SOCIAL_PROVIDERS

/** The provider's button on a site's login page ("start with Kakao", "Naver login", an icon-only "kakao") */
export function findProviderButton(
  text: string,
  provider: SocialProvider,
  loginPage = true,
): RefEntry | undefined {
  const p = SOCIAL_PROVIDERS[provider]
  const refs = ([...parseRefs(text)] as RefEntry[]).filter(
    ([, r]) =>
      (r.role === ROLE.link || r.role === ROLE.button) && p.button.test(r.name) && r.name.trim().length <= 30,
  )
  // Skip app download and official account links ("kakao channel", "google playstore"); login words first
  const ok = refs.filter(
    ([, r]) =>
      !PROVIDER_NOISE.test(r.name) &&
      // A "facebook" link at the bottom is the company's Facebook page (Facebook login always says login or continue)
      !(r.role === ROLE.link && COMPANY_SNS.test(r.name.trim())),
  )
  return (
    ok.find(([, r]) => PROVIDER_LOGIN_WORD.test(r.name)) ??
    // A button with only the provider name ("kakao", "Naver"). With other words in front ("SSG Facebook") it is the
    // company's account link. Only on login pages: it pressed the official SNS icon at the bottom of the home page
    // ("naver" → Naver Post) (measured on Ohou)
    ((loginPage || undefined) &&
      ok.find(
        ([, r]) =>
          r.name
            .trim()
            // Ignore the screen-reader suffix ("opens in a new window", measured 11-22 Korean Air)
            .replace(NEW_WINDOW, '')
            .replace(p.button, '')
            .replace(/[\s·|-]/g, '').length <= 2,
      )) ??
    // An unnamed icon button followed only by the provider name — only on login pages
    // (measured 11-22 Korean Air: the label sat under a round N icon, so the button had no name)
    ((loginPage || undefined) && bareIconButton(text, p.button))
  )
}

function bareIconButton(text: string, provider: RegExp): RefEntry | undefined {
  for (const m of text.matchAll(BARE_ICON_RE)) {
    const label = (m[3] ?? '').trim()
    if (provider.test(label) && label.replace(provider, '').replace(/[\s·|-]/g, '').length <= 2)
      return [m[1] as string, { role: m[2] as string, name: label }] as RefEntry
  }
  return undefined
}

/** Whether this is a login page: password or ID field, login address, or a login heading */
function isLoginPage(page: Snap): boolean {
  return (
    hasPassword(page.text) ||
    /\/(login|signin|sign-in|sign_in|member\/login)(\b|[/?#._])|login\.(do|aspx|jsp)/i.test(page.url) ||
    LOGIN_HEADING.test(page.text)
  )
}

export interface SocialLoginInput {
  card: AutoLoginInput['card']
  url: string
  provider: SocialProvider
  /** Vault values for the provider's login page (the entry for that provider's address). Else ask on the phone, else a person */
  creds(origin: string): Promise<{ username: string; password: string } | undefined>
  ask?: LoginAsk
  step?: StepFn
  onTab?: (tabId: number) => void
  /**
   * Whether to sign up through social login when no member is linked. If the site already has a working account
   * (another social login, a vault ID), signing up makes a second account on the same site: then don't, tell a person
   */
  join?: boolean
  /** Language of the steps, results and questions people read. Defaults to Korean */
  lang?: Lang
}

/**
 * Connect with social login: press the provider button on the site's login page. If the provider is already
 * signed in, only pass the consent; on the provider's login page, fill the vault values (else it's a person's turn)
 */
export async function socialLogin(
  browser: AutoLoginBrowser,
  input: SocialLoginInput,
  opts: { wait?: number; tries?: number } = {},
): Promise<AutoLoginResult> {
  const wait = opts.wait ?? 1_500
  const lang = input.lang ?? 'ko'
  const m = autoLoginText(lang)
  const label = PROVIDER_NAMES[lang][input.provider]
  const name = input.card.name
  const snap = async (tabId: number) => (await browser.call('snapshot', { tabId, maxChars: 30_000 })) as Snap
  const step = input.step ?? (() => {})
  step(m.opening(name))
  const opened = (await browser.call('open', { url: input.url }, 40_000)) as { tabId: number }
  const siteTab = opened.tabId
  input.onTab?.(siteTab)
  let page = await settled(() => snap(siteTab), wait)
  if (looksSignedIn(input.card, page)) return { status: 'ok', tabId: siteTab }
  step(m.findingProviderButton(label))
  page = await closePopups(browser, siteTab, page, snap, wait)

  // 1) Find the provider button; if there is none, go to the login page
  const tried = new Set<string>()
  let btn = findProviderButton(page.text, input.provider, isLoginPage(page))
  // Already on the login page but the social buttons are not drawn yet: wait a little before pressing the top menu
  // (measured 11-22 Korean Air: only the ID and password fields were read, so the Naver button was not found)
  for (let k = 0; k < 3 && !btn && isLoginPage(page); k++) {
    await sleep(wait)
    page = await snap(siteTab)
    btn = findProviderButton(page.text, input.provider, true)
  }
  for (let i = 0, late = 0; i < 4 && !btn; i++) {
    const target = findLoginLink(page.text, tried)
    if (!target) {
      // Sites that draw the bottom menu (MY) late: wait a little and look again (CatchTable)
      if (late++ >= 3) break
      await sleep(wait)
      page = await snap(siteTab)
      btn = findProviderButton(page.text, input.provider, isLoginPage(page))
      i--
      continue
    }
    tried.add(target[1].name.trim())
    const before = page.url
    await browser.call('click', { tabId: siteTab, ref: target[0] }, 30_000).catch(() => undefined)
    await sleep(wait)
    page = await settled(() => snap(siteTab), wait)
    btn = findProviderButton(page.text, input.provider, isLoginPage(page))
    // An ad popup appeared at the click and took it: close the popup and press the same link once more
    if (!btn && page.url === before && hasPopup(page.text)) {
      page = await closePopups(browser, siteTab, page, snap, wait)
      tried.delete(target[1].name.trim())
    }
  }
  if (!btn)
    return {
      status: 'unknown',
      tabId: siteTab,
      message: m.noProviderButton(label),
    }

  // 2) Provider button → a new window (popup), or the provider page in the same tab
  step(m.pressingProvider(label))
  const clicked = (await browser
    .call('click', { tabId: siteTab, ref: btn[0] }, 30_000)
    .catch(() => undefined)) as { newTabId?: number } | undefined
  let providerTab = clicked?.newTabId ?? siteTab
  if (providerTab !== siteTab) input.onTab?.(providerTab)
  const filled = new Set<string>()
  const pressed = new Set<string>()
  const askedInfo = new Set<string>()
  let graceInfo = 0

  // 3) Watch the result and pass the provider page's steps
  let blankWaits = 0
  const confirmSite = { confirmed: 0 }
  /** Saw the provider page at least once / times it came back to the site's login page after that */
  let sawProvider = false
  let backToLogin = 0
  /** The user confirmed the account logged in on the provider page (or confirmed it before) */
  let accountOk = false
  /** Presses per required consent checkbox */
  const requiredTries = new Map<string, number>()
  for (let i = 0; i < (opts.tries ?? 14); i++) {
    await sleep(wait)
    const site = await snap(siteTab).catch(() => undefined)
    if (site && (await signedInAfter(browser, input.card, site, confirmSite))) {
      if (providerTab !== siteTab) await browser.call('close', { tabId: providerTab }).catch(() => undefined)
      return { status: 'ok', tabId: siteTab }
    }
    const p = await snap(providerTab).catch(() => undefined)
    if (!p) {
      // The popup closed: keep watching in the site tab
      if (providerTab !== siteTab) input.onTab?.(siteTab)
      providerTab = siteTab
      continue
    }
    const host = (() => {
      try {
        return new URL(p.url).hostname
      } catch {
        return ''
      }
    })()
    const onProvider = SOCIAL_PROVIDERS[input.provider].host.test(host)
    if (onProvider) sawProvider = true
    if (!onProvider) {
      // The callback page after login is still blank (redirecting): wait a little and look again (measured Aladin)
      // — ending at once as a failure misses logins that actually worked
      if (p.text.replace(/\s/g, '').length < 40 && blankWaits++ < 6) {
        await sleep(Math.max(wait, 1_500))
        continue
      }
      // Provider auth finished but no site member is linked to this account: an "already a member? / join" page
      // (measured Kyobo, Yes24). A quick join with only required terms is done by Dool2; one that needs an identity
      // check goes to a person.
      // Wake a dormant account: with only (required) consents, check them and press the finish button (once per page)
      const dormant = dormantScreen(p.text)
      if (dormant?.kind === 'human')
        return {
          status: 'human',
          tabId: providerTab,
          reason: m.dormantHuman(name, dormant.why),
        }
      if (dormant && !pressed.has(`${p.url}|dormant`)) {
        pressed.add(`${p.url}|dormant`)
        step(m.waking(name))
        for (const ref of dormant.required)
          await browser.call('click', { tabId: providerTab, ref }, 15_000).catch(() => undefined)
        await browser
          .call('click', { tabId: providerTab, ref: dormant.submit }, 30_000)
          .catch(() => undefined)
        continue
      }
      const join = joinScreen(p.text)
      // An identity check after pressing join is a person's turn (measured Kyobo: join → phone identity check)
      const joined = [...pressed].some((k) => k.endsWith('|join'))
      const hum = joined && !join && JOIN_HUMAN.exec(p.text)
      if (hum)
        return {
          status: 'human',
          tabId: providerTab,
          reason: m.joinNeedsCert(name, hum[0].replace(/\s/g, '')),
        }
      // The site asks for an identity check after social login (measured Joonggonara: name, ID number prefix,
      // carrier, phone): a person's turn
      if (!join && CERT_REQUIRED.test(said(p.text)))
        return {
          status: 'human',
          tabId: providerTab,
          reason: m.loginNeedsCert(name),
        }
      // A page saying no member joined with this provider account (no join button, so joinScreen misses it)
      // — measured Airbnb, Eastar, CatchTable, Saramin
      if (!join && (NOT_MEMBER.test(said(p.text)) || NOT_MEMBER_URL.test(p.url))) {
        const cert = JOIN_HUMAN.exec(said(p.text))
        return {
          status: 'human',
          tabId: providerTab,
          reason: m.notMember(name, label, cert ? cert[0].replace(/\s/g, '') : undefined),
        }
      }
      // Back on the site's login page after provider auth: no member joined with this account, or the site did not
      // accept the link (measured Asiana, Jin Air, Seoul forest booking, Seoul booking, CGV). Say so when seen twice
      // in a row
      const at = new URL(p.url)
      // Callback addresses (/login/oauth/callback?code=…) are on the way and don't count. Only twice in a row
      const backAtLogin =
        sawProvider &&
        LOGIN_PATH.test(at.pathname) &&
        !/callback|oauth|redirect|result/i.test(at.pathname) &&
        !/[?&](code|state)=/.test(at.search)
      backToLogin = backAtLogin ? backToLogin + 1 : 0
      if (backToLogin >= 2)
        return {
          status: 'human',
          tabId: providerTab,
          reason: m.backToLogin(name, label),
        }
      if (join?.kind === 'existing')
        return {
          status: 'human',
          tabId: providerTab,
          reason: m.existing(name, label, join.account),
        }
      if (join) {
        const key = `${p.url}|join`
        if (join.kind === 'auto' && !input.join)
          return {
            status: 'human',
            tabId: providerTab,
            reason: m.notMemberJoin(name, label),
          }
        if (join.kind === 'human' || pressed.has(key))
          return {
            status: 'human',
            tabId: providerTab,
            reason:
              join.kind === 'human' ? m.notMemberJoinCert(name, label, join.why) : m.joinUnfinished(name),
          }
        pressed.add(key)
        step(m.joining(name, label))
        for (const ref of join.required)
          await browser.call('click', { tabId: providerTab, ref }, 15_000).catch(() => undefined)
        await browser.call('click', { tabId: providerTab, ref: join.submit }, 30_000).catch(() => undefined)
      }
      continue
    }
    // Approval in the provider app (KakaoTalk login check etc.): tell the card and wait.
    // Check "don't use 2-step on this browser" first when present (the user's everyday browser, so it won't ask again)
    if (APP_CONFIRM.test(said(p.text))) {
      const remember = ([...parseRefs(p.text)] as RefEntry[]).find(
        ([ref, r]) =>
          r.role === ROLE.checkbox && REMEMBER_BROWSER.test(r.name) && !checkedRefs(p.text).has(ref),
      )
      if (remember)
        await browser.call('click', { tabId: providerTab, ref: remember[0] }, 15_000).catch(() => undefined)
    }
    const confirm = await waitConfirm(p, providerTab, snap, input.step, wait, lang)
    if (confirm === 'moved') continue
    if (confirm === 'timeout')
      return {
        status: 'human',
        tabId: providerTab,
        reason: m.confirmWaiting(confirmWhere(p.text, lang)),
      }
    if (STEP2.test(said(p.text)) && !CAPTCHA.test(said(p.text))) {
      step(m.waitingCode)
      const a = await answerOnScreen(browser, providerTab, p, input.ask, askedInfo, lang)
      if (a === 'done') {
        graceInfo = 3
        continue
      }
      if (graceInfo-- > 0) continue
    }
    if (CAPTCHA.test(said(p.text)) || p.captcha || STEP2.test(said(p.text)))
      return { status: 'human', tabId: providerTab, reason: humanReason(p.text, lang) }
    // An identity check window (Toss, PASS, phone check: enter name, phone, birth date and approve in the app) must
    // be done by a person. Say clearly what to do and hand it over (measured SSG Toss check)
    const cert = certScreen(p.text, lang)
    if (cert) return { status: 'human', tabId: providerTab, reason: cert }
    const origin = new URL(p.url).origin
    // Provider login page: fill vault values when there are some, else it's a person's turn
    const two = twoStep(p.text)
    if (hasPassword(p.text) || two) {
      // Not in the vault: get them on the phone's input screen (once entered they stay in the vault, no more asking)
      const creds =
        (await input.creds(origin)) ??
        (filled.has(p.url)
          ? undefined
          : await input.ask?.credentials?.(origin, m.providerAccount(label), providerTab))
      if (!creds || filled.has(p.url))
        return {
          status: 'human',
          tabId: providerTab,
          reason: m.providerLoginNeeded(label),
        }
      filled.add(p.url)
      step(m.enteringProviderAccount(label))
      if (two && !hasPassword(p.text)) {
        await browser.call('fill', { tabId: providerTab, ref: two.user[0], value: creds.username, origin })
        await browser.call('click', { tabId: providerTab, ref: two.next[0] }, 30_000).catch(() => undefined)
        continue
      }
      const f = loginFields(p.text)
      if (f.user)
        await browser.call('fill', { tabId: providerTab, ref: f.user[0], value: creds.username, origin })
      await fillPassword(browser, {
        tabId: providerTab,
        ref: f.password[0] as string,
        value: creds.password,
        origin,
      })
      // The user's everyday PC, so turn on "keep me signed in": without it every service needed another Kakao login and
      // KakaoTalk check (measured 11st → Olive Young)
      const keep = keepSignedIn(p.text)
      if (keep) await browser.call('click', { tabId: providerTab, ref: keep }, 15_000).catch(() => undefined)
      if (f.submit)
        await browser.call('click', { tabId: providerTab, ref: f.submit[0] }, 30_000).catch(() => undefined)
      else await browser.call('press', { tabId: providerTab, key: 'Enter' }).catch(() => undefined)
      continue
    }
    if (WRONG.test(said(p.text)))
      return {
        status: 'wrong',
        tabId: providerTab,
        message: m.providerWrong(label),
      }
    // Account chooser (Google): press the line with the email. With several, the one picked before; else ask a
    // person once and remember (measured Aladin: two Google accounts, pressing the first could join the wrong one)
    const refs = [...parseRefs(p.text)] as RefEntry[]
    // Email lines count as accounts only on the chooser page. The confirm page after choosing also has a
    // "…@gmail.com selected. Switch account" line; pressing it went back to the chooser and stopped
    // (measured Booking.com, Gmarket, Airbnb, Oasis, Eastar)
    const choosing = ACCOUNT_CHOOSER.test(`${p.url} ${p.text}`)
    const accounts = choosing
      ? refs.filter(
          ([, r]) =>
            (r.role === ROLE.link || r.role === ROLE.button) &&
            /@/.test(r.name) &&
            !ACCOUNT_SWITCH.test(r.name),
        )
      : []
    let account = accounts.length === 1 ? accounts[0] : undefined
    if (accounts.length > 1) {
      const names = accounts.map(([, r]) => r.name.trim())
      const remembered = input.ask?.account?.get(input.provider)
      // The remembered value is the page text as is, or an email address (mdjoo…@gmail.com): match it to masked
      // emails (m***@gmail.com)
      const sameMail = (n: string, mail: string) => {
        const shown = /([^\s@,]+)@([^\s@,]+)/.exec(n)
        const [user = '', domain = ''] = mail.toLowerCase().split('@')
        if (!shown || !domain) return false
        const head = (shown[1] ?? '').toLowerCase().replace(/\*+.*$/, '')
        return (shown[2] ?? '').toLowerCase() === domain && head.length > 0 && user.startsWith(head)
      }
      const byMail =
        remembered?.includes('@') && !remembered.includes(' ')
          ? names.filter((n) => sameMail(n, remembered))
          : []
      let pick =
        (remembered && names.find((n) => n === remembered)) || (byMail.length === 1 ? byMail[0] : undefined)
      if (!pick && input.ask?.info) {
        step(m.waitingAccountPick(label))
        const a = await input.ask.info({
          field: 'choice',
          label: m.whichAccount(label),
          hint: m.whichAccountHint(name),
          host,
          options: names,
        })
        pick = a && names.find((n) => n === a.trim())
        if (pick) input.ask.account?.set(input.provider, pick)
      }
      if (!pick)
        return {
          status: 'human',
          tabId: providerTab,
          reason: m.pickAccount(label),
        }
      account = accounts.find(([, r]) => r.name.trim() === pick)
    }
    // Before pressing consent: check the account logged in at the provider is one the user confirmed
    // (measured Aladin 2026-11-18: Kakao in this PC's Chrome was f***@gmail.com, not the usual account, and it pressed
    // consent anyway). Ask once for an unseen account; if the user says no, open "change account" and hand it over
    const who = account ? undefined : providerAccountOn(p.text)
    if (who && !accountOk) {
      if (input.ask?.known?.has(input.provider, who)) accountOk = true
      else {
        step(m.waitingAccountCheck(label))
        const yes = m.useAccount(who)
        const a = input.ask?.info
          ? await input.ask.info({
              field: 'choice',
              label: m.confirmAccount(label, who, name),
              hint: m.confirmAccountHint(label),
              host,
              options: [yes, m.otherAccount],
            })
          : undefined
        if (a?.trim() === yes) {
          input.ask?.known?.add(input.provider, who)
          accountOk = true
        } else {
          const change = refs.find(
            ([, r]) => (r.role === ROLE.link || r.role === ROLE.button) && CHANGE_ACCOUNT.test(r.name),
          )
          if (a && change)
            await browser.call('click', { tabId: providerTab, ref: change[0] }, 30_000).catch(() => undefined)
          return {
            status: 'human',
            tabId: providerTab,
            reason: a ? m.changeAccount(label) : m.checkAccount(label, who),
          }
        }
      }
    }
    // Info sharing consent with (required) boxes: check only those (optional items are left alone). Measured Aladin Kakao
    const required = refs.filter(
      ([, r]) => r.role === ROLE.checkbox && REQUIRED_CHECK.test(r.name) && !SELECTED.test(r.name),
    )
    if (required.length && !account) {
      const checked = checkedRefs(p.text)
      // Some pages don't check the box when it's pressed (measured Olive Young Kakao consent: the text line with the
      // same name next to it must be pressed). First the box, then the button with the same name, then a person's
      // turn (so it doesn't spend time pressing the same box)
      const open = required.filter(([ref]) => !checked.has(ref))
      for (const [ref, r] of open) {
        const n = (requiredTries.get(r.name) ?? 0) + 1
        requiredTries.set(r.name, n)
        const twin = refs.find(([, x]) => x.role === ROLE.button && x.name.trim() === r.name.trim())
        const target = n === 1 || !twin ? ref : twin[0]
        if (n <= 2)
          await browser.call('click', { tabId: providerTab, ref: target }, 15_000).catch(() => undefined)
      }
      if (open.some(([, r]) => (requiredTries.get(r.name) ?? 0) > 2))
        return {
          status: 'human',
          tabId: providerTab,
          reason: m.requiredStuck(label),
        }
      if (open.length) {
        step(m.pickingRequired)
        continue
      }
    }
    // Info sharing consent: "agree and continue"
    const consent = refs.find(([, r]) => r.role === ROLE.button && CONSENT.test(r.name.trim()))
    const next = account ?? consent
    if (next && !pressed.has(`${p.url}|${next[1].name}`)) {
      pressed.add(`${p.url}|${next[1].name}`)
      step(account ? m.pickingAccount : m.passingConsent)
      await browser.call('click', { tabId: providerTab, ref: next[0] }, 30_000).catch(() => undefined)
    }
  }
  // When the last page is an in-between page (callback, notice), open the site again and check up to My page once
  // (the login stays in cookies)
  if (input.card.site) {
    const r = await checkSignedIn(browser, {
      id: input.card.id,
      signedIn: input.card.signedIn,
      site: input.card.site,
    }).catch(() => undefined)
    if (r?.state === 'in') {
      for (const t of new Set([providerTab, siteTab]))
        await browser.call('close', { tabId: t }).catch(() => undefined)
      return { status: 'ok', tabId: siteTab }
    }
  }
  return {
    status: 'unknown',
    tabId: providerTab,
    message: m.providerUnknown(label),
  }
}

/** Address of a quick join page */
const NOT_MEMBER_URL = /\/(join|signup|sign-up|register|registration)(\b|[/?#])|social-terms/i
/** Login page address */
const LOGIN_PATH = /\/(login|signin|sign-in|sign_in)(\b|[/?#._])|viewLogin|login\.(do|aspx|jsp)/i

/**
 * The "no member is linked to this account" page after social login: the join button and the (required) terms
 * boxes not checked yet. An identity check on the same page makes it a person's turn (why). Otherwise undefined
 */
export function joinScreen(
  text: string,
):
  | { kind: 'auto'; submit: string; required: string[] }
  | { kind: 'human'; why: string }
  | { kind: 'existing'; account?: string }
  | undefined {
  // Tried to join and got "already joined (ID coffeeplan)": logging in with that account links it (measured Kyobo)
  // "the ID joined as a Shinsegae Point member is mdj****10" (measured Shinsegae Duty Free)
  if (ALREADY_JOINED.test(text)) {
    const id = RADIO_ACCOUNT.exec(text)?.[1] ?? ID_IS.exec(text)?.[1]
    return { kind: 'existing', ...(id ? { account: id } : {}) }
  }
  if (!JOIN_PAGE.test(text)) return undefined
  const refs = [...parseRefs(text)] as RefEntry[]
  const submit = refs.find(
    ([, r]) => (r.role === ROLE.button || r.role === ROLE.link) && JOIN_SUBMIT.test(r.name.trim()),
  )
  if (!submit) return undefined
  // Identity check fields before pressing join make it a person's turn (ones after join are seen on the next page)
  const human = JOIN_HUMAN.exec(
    text
      .split('\n')
      .filter((l) => !JOIN_HUMAN_NOTE.test(l))
      .join('\n'),
  )
  if (human) return { kind: 'human', why: human[0].replace(/\s/g, '') }
  const checked = checkedRefs(text)
  const required = refs
    .filter(([ref, r]) => r.role === ROLE.checkbox && REQUIRED_WORD.test(r.name) && !checked.has(ref))
    .map(([ref]) => ref)
  return { kind: 'auto', submit: submit[0], required }
}

/**
 * Dormant (long unused) account page after login: "terms consent needed for a long unused account" (measured 11st
 * 2026-11-19). With only (required) consent boxes and a finish or wake button, Dool2 checks and presses them.
 * Phone identity check fields make it a person's turn (why)
 */
export function dormantScreen(
  text: string,
): { kind: 'auto'; submit: string; required: string[] } | { kind: 'human'; why: string } | undefined {
  if (!DORMANT.test(said(text))) return undefined
  const refs = [...parseRefs(text)] as RefEntry[]
  const human = JOIN_HUMAN.exec(said(text))
  if (human || refs.some(([, r]) => r.role === ROLE.input && DORMANT_CERT_FIELD.test(r.name)))
    return { kind: 'human', why: (human?.[0] ?? DORMANT_DEFAULT_WHY).replace(/\s/g, '') }
  const submit = refs.find(
    ([, r]) => (r.role === ROLE.button || r.role === ROLE.link) && DORMANT_SUBMIT.test(r.name.trim()),
  )
  if (!submit) return undefined
  const checked = checkedRefs(text)
  const required = refs
    .filter(([ref, r]) => r.role === ROLE.checkbox && REQUIRED_OR_ALL.test(r.name) && !checked.has(ref))
    .map(([ref]) => ref)
  return { kind: 'auto', submit: submit[0], required }
}

/** For checks: social login providers on a login page */
export function socialProvidersIn(text: string): SocialProvider[] {
  return (Object.keys(SOCIAL_PROVIDERS) as SocialProvider[]).filter((p) => findProviderButton(text, p))
}
