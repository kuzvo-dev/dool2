// My payment methods (ADR 0023): an ordered list in the daemon's settings. Card numbers and payment passwords are never taken
import { randomUUID } from 'node:crypto'
import type { Lang } from '@dool2/i18n'
import type { Settings } from '@dool2/protocol'
import { cleanPayMethod, MAX_PAY_METHODS, PAY_KINDS, type PayMethod } from '@dool2/protocol/pay-methods'
import { userLang } from './lang.js'
import { payMethodsCopy } from './locales/pay-methods.js'

interface SettingStore {
  getSetting(key: string): unknown
  setSetting(key: string, value: unknown): void
}

const KEY = 'payMethods'

export function loadPayMethods(store: SettingStore): PayMethod[] {
  const v = store.getSetting(KEY)
  return Array.isArray(v) ? (v as PayMethod[]) : []
}

/**
 * Replaces the whole list with the one the phone sent (add, delete, reorder). If any item can't be accepted,
 * nothing changes and the reason is returned (shown on the phone)
 */
export function savePayMethods(
  store: SettingStore,
  raw: unknown[],
  now = new Date().toISOString(),
): { ok: true; methods: PayMethod[] } | { ok: false; error: string } {
  if (raw.length > MAX_PAY_METHODS)
    return {
      ok: false,
      error: payMethodsCopy(
        userLang({ language: store.getSetting('language') as Settings['language'] }),
      ).tooMany(MAX_PAY_METHODS),
    }
  const out: PayMethod[] = []
  for (const r of raw) {
    const m = cleanPayMethod(r, randomUUID(), now)
    if (typeof m === 'string') return { ok: false, error: m }
    // The same id twice gets a new id (so delete and reorder don't get mixed up)
    out.push(out.some((x) => x.id === m.id) ? { ...m, id: randomUUID() } : m)
  }
  store.setSetting(KEY, out)
  return { ok: true, methods: out }
}

// ── AI tool pay_method_list: saved payment methods, masked values only ──

/** A value with 5 or more digits (ignoring spaces and hyphens) may be a card number, so it is not sent to the AI (blocked on save too, checked again here) */
function shown(v: string | undefined): string | undefined {
  if (!v) return undefined
  return /\d{5,}/.test(v.replace(/[\s-]/g, '')) ? undefined : v
}

/**
 * My payment methods (pay_method_list tool). Only kind, card issuer, nickname, last 4 digits and the masked label
 * inside an easy-pay service. Card numbers, expiry dates and CVCs are never stored. The first one is the main
 * payment method (the approval card picks in this order). Text for the AI; menu paths are in the user's language
 */
export function payMethodsText(methods: PayMethod[], lang: Lang = 'ko'): string {
  const m = payMethodsCopy(lang)
  if (!methods.length)
    return [
      `No payment methods saved. The user can add the cards and easy-pay services they use in "${m.settingsPath}" (card issuer and last 4 digits only, never the card number).`,
      'Next: if card benefits matter, tell the user this path in one sentence, or ask only which card issuers and easy-pay services they use and compare on that basis (never ask for a card number). Still find and show the lowest price without benefits.',
    ].join('\n')
  const lines = methods.map((x, i) => {
    const isCard = x.kind === 'card'
    const name = isCard ? (shown(x.issuer) ?? PAY_KINDS.card) : (PAY_KINDS[x.kind] ?? x.kind)
    const parts = [
      `${i + 1}. ${i === 0 ? '[main payment method] ' : ''}${name} (${isCard ? 'card' : 'easy pay'})`,
      ...(isCard && shown(x.nickname) ? [`nickname ${x.nickname}`] : []),
      ...(isCard && x.last4 && /^\d{4}$/.test(x.last4) ? [`ends in ${x.last4}`] : []),
      ...(!isCard && shown(x.inner) ? [`uses inside: ${x.inner}`] : []),
    ]
    return parts.join(' · ')
  })
  return [
    `${methods.length} saved payment method(s). The first one is the main payment method, and at payment the approval card pre-selects, from the top, the first one the site accepts.`,
    'Dool2 never takes or stores full card numbers, expiry dates or CVCs (only issuer, nickname and last 4 digits).',
    '',
    ...lines,
    '',
    `Next: compare card benefits and discounts only for the cards and easy-pay services in this list (do not assume the user has cards that are not listed). Card benefits depend on last month's spending, limits and promotion terms, so call them "expected", and confirm the final price on the payment screen. The user changes this list in "${m.shortPath}".`,
  ].join('\n')
}
