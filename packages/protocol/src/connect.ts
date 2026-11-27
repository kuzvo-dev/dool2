// Service connect card (skills/<id>/connect.json, ADR 0014).
// A template describing what shows on the connect screen (list and detail) and what Dool2 can do in that service.
// To add a service, put this one file in one folder. No code changes.
import type { Lang } from '@dool2/i18n'
import { z } from 'zod'
import { APPROVAL_TIERS, approvalLine, CATEGORY_LABEL } from './connect-text.js'

export { APPROVAL_TIERS, approvalLine }

/**
 * Risk tier of an ability or tool (docs/architecture.md 4.1, ADR 0029).
 * `pay` and `contact` run only after approval signed on the phone.
 */
export const TIERS = ['lookup', 'fill', 'pay', 'contact'] as const
export type Tier = (typeof TIERS)[number]

/** Korean values used before ADR 0029. Still accepted when reading cards, mapped to the English keys. */
export const LEGACY_TIERS: Readonly<Record<string, Tier>> = {
  찾아보기: 'lookup',
  '채워 두기': 'fill',
  '돈 내기': 'pay',
  연락하기: 'contact',
}

export const TierSchema = z.preprocess(
  (v) => (typeof v === 'string' && v in LEGACY_TIERS ? LEGACY_TIERS[v] : v),
  z.enum(TIERS),
)

/** Categories on the connect screen (CATEGORY_LABEL in connect-text.ts). The order is the list order */
export const CONNECT_CATEGORIES = CATEGORY_LABEL
export const ConnectCategorySchema = z.enum(
  Object.keys(CONNECT_CATEGORIES) as [
    keyof typeof CONNECT_CATEGORIES,
    ...(keyof typeof CONNECT_CATEGORIES)[],
  ],
)
export type ConnectCategory = z.infer<typeof ConnectCategorySchema>

/**
 * Connection method (docs/architecture.md 5.0 "start with the most accurate method")
 * - browser: sign in once in the user's Chrome and Dool2 works on that screen (most services)
 * - official: where an official integration exists (mail IMAP, calendar API, etc.). Used like browser until it is ready
 * - open: used without signing in (parcel tracking etc.)
 * - device: phone permission (contacts, location, calendar). Turned on in the phone app
 */
export const ConnectHowSchema = z.enum(['browser', 'official', 'open', 'device'])
export type ConnectHow = z.infer<typeof ConnectHowSchema>

/**
 * Whether a service's tools run in the PC's Chrome (everything but phone features). While Chrome or the Dool2
 * extension is off, such a connected service cannot be used, so the screens do not call it "connected" then
 */
export function needsPcChrome(card: { how: ConnectHow }): boolean {
  return card.how !== 'device'
}

/** Where a service shows the signed-in account (ADR 0041) */
export const ConnectAccountSchema = z
  .object({
    /**
     * Page that shows the signed-in account. {{account}} becomes the account being checked, for services that keep
     * several accounts side by side (Gmail: /mail/u/{{account}}/ opens only that account's mailbox)
     */
    url: z.string().url().startsWith('https://'),
    /**
     * Pattern (regular expression) around the account in the page text; group 1 is the account as typed on the
     * sign-in form (an email or an ID, masked is fine)
     */
    pattern: z
      .string()
      .min(4)
      .max(200)
      .refine((p) => {
        try {
          return new RegExp(p).source.includes('(')
        } catch {
          return false
        }
      }, 'A valid regular expression with a group around the account'),
    /**
     * Accounts live side by side in one browser (Google): instead of an ID and password, the person picks one of the
     * accounts already signed in to Chrome, or adds one on the provider's own screen. Address of that screen
     */
    pick: z.string().url().startsWith('https://').optional(),
  })
  .strict()
export type ConnectAccount = z.infer<typeof ConnectAccountSchema>

/** One-tap sign-in providers */
export const SocialProviderSchema = z.enum(['kakao', 'naver', 'google', 'apple', 'facebook', 'payco', 'toss'])
export type SocialProvider = z.infer<typeof SocialProviderSchema>
export const SOCIAL_LABEL: Record<SocialProvider, string> = {
  kakao: '카카오',
  naver: '네이버',
  google: '구글',
  apple: 'Apple',
  facebook: '페이스북',
  payco: '페이코',
  toss: '토스',
}
const SOCIAL_LABEL_EN: Record<SocialProvider, string> = {
  kakao: 'Kakao',
  naver: 'Naver',
  google: 'Google',
  apple: 'Apple',
  facebook: 'Facebook',
  payco: 'PAYCO',
  toss: 'Toss',
}
/** The display name of a sign-in provider */
export function socialLabel(p: SocialProvider, lang: Lang = 'ko'): string {
  return lang === 'en' ? SOCIAL_LABEL_EN[p] : SOCIAL_LABEL[p]
}

const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !s.includes('\n'), 'Write it on one line')

export const ConnectAbilitySchema = z
  .object({
    /** Short name: "배송 조회" ("Track delivery") */
    title: line(20),
    /** What a user would say, without quotes: "주문한 거 언제 와?" ("When does my order arrive?") */
    say: line(40).refine((s) => !/^["“'‘]|["”'’]$/.test(s), 'Leave out the quotes (the screen adds them)'),
    tier: TierSchema,
  })
  .strict()
export type ConnectAbility = z.infer<typeof ConnectAbilitySchema>

export const ConnectCardSchema = z
  .object({
    /** Same as the folder name. Lowercase English letters, digits and - */
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
    name: line(24),
    /** Domain in the address bar (without https://): "coupang.com". Used for the icon and sign-in check. Omit for phone permissions */
    site: z
      .string()
      .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{2,5})?$/, 'Write only the domain, without https://')
      .optional(),
    /** Other domains the same service uses (when the mail screen is at another address like mail.google.com). Service tools can open them */
    alsoSites: z
      .array(z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'Write only the domain, without https://'))
      .min(1)
      .max(6)
      .optional(),
    category: ConnectCategorySchema,
    how: ConnectHowSchema,
    /**
     * The id of the service that signs in with the same account (e.g. Naver Mail -> naver). If that service is connected, this one counts as connected too
     * (measured: Naver was connected but the Naver Mail connect card was shown again)
     */
    sameLoginAs: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,40}$/)
      .optional(),
    /** Sign-in page address (only for sites where the sign-in link is hard to find on the first page) */
    loginUrl: z.string().url().startsWith('https://').optional(),
    /** One-tap sign-ins on the sign-in page (only ones confirmed by checking the real site). The connect screen gets a "Connect with Kakao" button */
    social: z.array(SocialProviderSchema).min(1).max(7).optional(),
    /** The sign-in the user does when connecting: "아이디·비밀번호" (ID and password), "카카오·네이버 간편 로그인" (Kakao or Naver sign-in) */
    login: line(40).optional(),
    /** First paragraph of the detail screen. "If you do X, you can leave Y to Dool2." One or two sentences */
    summary: z.string().trim().min(10).max(140),
    /** Example conversation on the detail screen */
    example: z
      .object({
        ask: line(50),
        /** Text shown while working: "배송 조회 중" ("Tracking delivery") */
        working: line(20),
        reply: z.string().trim().min(5).max(120),
      })
      .strict(),
    abilities: z.array(ConnectAbilitySchema).min(2).max(6),
    /**
     * Text only a signed-in person sees (e.g. "로그아웃", "마이쿠팡"). When connecting, Dool2 treats seeing this text as having finished signing in.
     * If absent, common text like "로그아웃" and "Logout" is used to check
     */
    signedIn: z.array(line(30)).min(1).max(5).optional(),
    /**
     * Where the signed-in account shows (ADR 0041). A connection is a specific account, not "someone is signed in":
     * after connecting, Dool2 reads the account here, and when Chrome was already signed in to another account it asks
     * the person instead of quietly using that account
     */
    account: ConnectAccountSchema.optional(),
    /**
     * 1-3 short tips for working with the general browser while the connector (tools.json) does not exist yet (search URL etc., ADR 0018).
     * Delete it once the connector exists
     */
    hints: z.array(z.string().trim().min(5).max(200)).min(1).max(3).optional(),
    /**
     * Words people use for this service when they do not name it ("flight" for a flight search, "tracking number" for
     * parcels), in the card's language. A request with one of them goes to this service's lookup tool at once
     */
    aliases: z.array(z.string().trim().min(2).max(20)).min(1).max(10).optional(),
    /**
     * Where the service is for (ADR 0029): "KR", "JP", "TW", or "global" for services that work anywhere.
     * Omitted = Korea. The connect screen lists the user's region and global services first
     */
    regions: z
      .array(z.enum(['KR', 'JP', 'TW', 'global']))
      .min(1)
      .max(4)
      .optional(),
    /**
     * Translations of the people-facing text (the card itself is written in Korean). Each field is optional; a missing
     * field falls back to the card's own text. abilities are matched by position and keep their tier
     */
    i18n: z
      .object({
        en: z
          .object({
            name: line(32),
            login: line(60),
            summary: z.string().trim().min(10).max(200),
            example: z
              .object({ ask: line(80), working: line(40), reply: z.string().trim().min(5).max(200) })
              .strict(),
            abilities: z
              .array(z.object({ title: line(32), say: line(70) }).strict())
              .min(1)
              .max(6),
          })
          .partial()
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.i18n?.en?.abilities && c.i18n.en.abilities.length !== c.abilities.length)
      ctx.addIssue({
        code: 'custom',
        path: ['i18n', 'en', 'abilities'],
        message: `Translate every ability in the same order (${c.abilities.length})`,
      })
    if (c.how !== 'device' && !c.site)
      ctx.addIssue({ code: 'custom', path: ['site'], message: 'A domain (site) is required' })
    if (c.how === 'browser' && !c.login)
      ctx.addIssue({ code: 'custom', path: ['login'], message: 'Describe how to sign in (login)' })
  })
export type ConnectCard = z.infer<typeof ConnectCardSchema>

/** Card problems as a list people can read (used by the skill check test and the contributor guide) */
export function checkConnectCard(dir: string, raw: unknown): string[] {
  const r = ConnectCardSchema.safeParse(raw)
  const problems = r.success
    ? []
    : r.error.issues.map((i) => `${i.path.join('.') || '(whole card)'}: ${i.message}`)
  if (r.success && r.data.id !== dir)
    problems.push(`id (${r.data.id}) does not match the folder name (${dir})`)
  return problems
}

/** Summary of one service tool (tools.json, ADR 0018) */
export interface ConnectionTool {
  /** catchtable_search */
  name: string
  /** Finding open tables at a restaurant */
  title: string
  tier: Tier
  /** A tool that needs a connection (sign-in) */
  login: boolean
  /** A tool that has been run for real */
  verified: boolean
}

/** One row on the connect screen: card + service tool status + connection status (GET /api/connections) */
export interface ConnectionItem {
  card: ConnectCard
  /** If a connector (tools.json) exists, its status summary (verified (date) / draft / blocked (reason)) */
  skill?: string
  /** Service tools (connector) - used for "quick things to do right away" on the connect screen and the AI service map */
  tools?: ConnectionTool[]
  /** When the user finished connecting. open and device are used without connecting or turned on in the phone */
  connectedAt?: string
  /** The method last used to connect ('vault' ID and password, 'social:kakao' one-tap sign-in). Used for the order of recommendations on the connect card */
  via?: string
  /**
   * Only for sign-in account cards (Kakao, Naver, Google): the account confirmed with my account on this PC (masked text, "f***@gmail.com").
   * Other services' connect cards show it on that provider button as "Kakao · f***@gmail.com", so you know which account it signs in with before pressing
   */
  account?: string
  /** The account this connection is, as read on the service's own page (masked, "m***@gmail.com", ADR 0041) */
  signedInAs?: string
  /** The service is for the user's region or works anywhere (ADR 0029). Others go under "Other regions" */
  local?: boolean
}

/** The address of the service's first page (opened in Chrome when connecting) */
export function connectUrl(card: Pick<ConnectCard, 'site'>): string | undefined {
  if (!card.site) return undefined
  // Only test sites on this PC (127.0.0.1, localhost) use http
  const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(card.site)
  return `${local ? 'http' : 'https'}://${card.site}/`
}

// socialOrder는 zod 없이 쓰게 connect-text.ts에 있다 (PC 앱 화면은 묶지 않고 그 파일을 옆에 두고 불러온다)
export { localizeCard, socialOrder } from './connect-text.js'
