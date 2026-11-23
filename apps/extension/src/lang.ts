// UI language of the extension (ADR 0029): the browser's UI language once the app follows the device.
import { initialLang, type Lang } from '@dool2/i18n'

export const lang: Lang = initialLang(undefined, [chrome.i18n?.getUILanguage?.()])
