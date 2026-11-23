// Language and region for Dool2 (ADR 0029).
// One file with no imports, so screens that load modules without a bundler can copy it next to themselves.

/** Languages the UI ships in. Korean is the reference copy, and English must be complete. */
export const LANGS = ['ko', 'en'] as const
export type Lang = (typeof LANGS)[number]

/** Each language's name in that language, for language pickers. */
export const LANG_NAMES: Record<Lang, string> = { ko: '한국어', en: 'English' }

/** Language used when the device language is not shipped yet. */
export const FALLBACK_LANG: Lang = 'en'

/** Regions with their own service catalog and local features. Services that work anywhere are `global`. */
export const REGIONS = ['KR', 'JP', 'TW'] as const
export type Region = (typeof REGIONS)[number]
export type ServiceRegion = Region | 'global'

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && (LANGS as readonly string[]).includes(v)
}

export function isRegion(v: unknown): v is Region {
  return typeof v === 'string' && (REGIONS as readonly string[]).includes(v)
}

/**
 * Picks the UI language from what the device prefers (`navigator.languages`, `app.getPreferredSystemLanguages()`).
 * Takes the first shipped language in order, so `['ja-JP', 'ko-KR']` gives `ko`, and falls back to English.
 */
export function resolveLang(preferred: string | readonly (string | undefined)[] | undefined): Lang {
  const list = typeof preferred === 'string' ? [preferred] : (preferred ?? [])
  for (const tag of list) {
    const base = tag?.toLowerCase().split(/[-_]/)[0]
    if (isLang(base)) return base
  }
  return FALLBACK_LANG
}

/**
 * First UI language for an app (ADR 0029):
 * 1. the language the user picked,
 * 2. Korean when the region is Korea (a Korean PC with an English OS still starts in Korean),
 * 3. otherwise the device language, falling back to English.
 */
export function initialLang(
  saved: unknown,
  preferred: string | readonly (string | undefined)[] | undefined,
  region?: Region,
): Lang {
  if (isLang(saved)) return saved
  if (region === 'KR') return 'ko'
  return resolveLang(preferred)
}

/** The device's region guess from its languages and this runtime's time zone. */
export function deviceRegion(locales: readonly (string | undefined)[] | undefined): Region | undefined {
  let timeZone: string | undefined
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {}
  return guessRegion({ locales: locales ?? [], ...(timeZone ? { timeZone } : {}) })
}

const ZONE_REGION: Record<string, Region> = {
  'Asia/Seoul': 'KR',
  'Asia/Tokyo': 'JP',
  'Asia/Taipei': 'TW',
}

/**
 * Guesses the region from the device: the region part of the locale (`ko-KR`, `zh-Hant-TW`) first, then the time
 * zone. Returns `undefined` when neither matches a shipped region, so the setup screen can ask.
 */
export function guessRegion(device: {
  locales?: readonly (string | undefined)[]
  timeZone?: string
}): Region | undefined {
  for (const tag of device.locales ?? []) {
    const parts = tag?.split(/[-_]/) ?? []
    for (const p of parts.slice(1)) {
      const up = p.toUpperCase()
      if (isRegion(up)) return up
    }
  }
  return device.timeZone ? ZONE_REGION[device.timeZone] : undefined
}

/** Whether a service tagged with `regions` belongs in the main list for this user. */
export function servesRegion(
  regions: readonly ServiceRegion[] | undefined,
  region: Region | undefined,
): boolean {
  if (!regions?.length) return region === undefined || region === 'KR' // cards written before ADR 0029 are Korean
  return regions.includes('global') || (region !== undefined && regions.includes(region))
}

/** BCP 47 tag for `Intl`: language plus region when known (`ko-KR`, `en-JP`). */
export function localeTag(lang: Lang, region?: Region): string {
  return region ? `${lang}-${region}` : lang
}

// ── Messages ─────────────────────────────────────────────────────────────

/** A message is plain text or a function of its parameters (typed, so a missing parameter is a type error). */
// biome-ignore lint/suspicious/noExplicitAny: message functions take any typed parameters
export type Message = string | ((...args: any[]) => string)
export type Messages = Record<string, Message>

/** Translations for languages other than Korean and English: partial, and missing keys fall back to English. */
export type ExtraCatalogs<T extends Messages> = Partial<Record<Lang, Partial<T>>>

/**
 * Defines one set of messages. `ko` is the reference, `en` must have every key with the same shape, and the
 * type checker fails on a missing or extra key. Returns a lookup for one language.
 *
 *   const m = messages({ ko: { hi: (n: string) => `${n}님 안녕하세요` }, en: { hi: (n: string) => `Hi ${n}` } })
 *   m('en').hi('Minji')
 */
export function messages<T extends Messages>(catalogs: {
  ko: T
  en: NoInfer<{ [K in keyof T]: T[K] }>
  extra?: ExtraCatalogs<NoInfer<T>>
}): (lang: Lang) => T {
  const cache = new Map<Lang, T>()
  return (lang) => {
    const hit = cache.get(lang)
    if (hit) return hit
    const base = lang === 'ko' ? catalogs.ko : catalogs.en
    const extra = catalogs.extra?.[lang]
    const out = (extra ? { ...base, ...extra } : base) as T
    cache.set(lang, out)
    return out
  }
}

/** Picks the plural form for `n` with the language's rules (`one` is used in English, Korean has only `other`). */
export function plural(lang: Lang, n: number, forms: { one?: string; other: string }): string {
  const rule = new Intl.PluralRules(lang).select(n)
  return (rule === 'one' ? forms.one : undefined) ?? forms.other
}

/** Joins a short list the way the language does ("A, B and C" / "A, B, C"). */
export function list(
  lang: Lang,
  items: readonly string[],
  type: 'conjunction' | 'disjunction' = 'conjunction',
): string {
  return new Intl.ListFormat(lang, { style: 'long', type }).format(items)
}

// ── Formatting ───────────────────────────────────────────────────────────

const CURRENCY: Record<Region, string> = { KR: 'KRW', JP: 'JPY', TW: 'TWD' }

export function currencyOf(region: Region | undefined): string {
  return region ? CURRENCY[region] : 'KRW'
}

/** Money in the user's language: `12,000원` (ko), `₩12,000` (en). */
export function formatMoney(lang: Lang, amount: number, currency = 'KRW'): string {
  if (lang === 'ko' && currency === 'KRW') return `${new Intl.NumberFormat('ko-KR').format(amount)}원`
  return new Intl.NumberFormat(lang, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
}

export function formatNumber(lang: Lang, n: number): string {
  return new Intl.NumberFormat(lang).format(n)
}

export function formatDate(
  lang: Lang,
  date: Date | number,
  opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
  timeZone?: string,
): string {
  return new Intl.DateTimeFormat(lang, timeZone ? { ...opts, timeZone } : opts).format(date)
}
