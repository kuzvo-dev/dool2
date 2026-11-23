// UI language of the extension (ADR 0029): Korean in Korea, else the browser's UI language.
import { deviceRegion, initialLang, type Lang } from '@dool2/i18n'

const ui = typeof chrome === 'undefined' ? [] : [chrome.i18n?.getUILanguage?.()]

export const lang: Lang = initialLang(undefined, ui, deviceRegion(ui))
