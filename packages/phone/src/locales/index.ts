// The card copy, keyed by language. Korean-first (the default), English complete.

import { en } from './en.js'
import { ko } from './ko.js'
import type { CardCopy, CardLang } from './types.js'

export type { CardCopy, CardLang } from './types.js'

export const locales: Record<CardLang, CardCopy> = { ko, en }

/** The default card language: Korean (Korean-first product). */
export const DEFAULT_CARD_LANG: CardLang = 'ko'
