// Key name -> CDP Input.dispatchKeyEvent values. Produces the same events as a real keyboard.
import { KEY_ALIASES_KR } from './region/kr/keys.js'

export interface KeyDef {
  key: string
  code: string
  keyCode: number
  /** Key that produces a character (Enter must be \r for forms to submit) */
  text?: string
}

const KEYS: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
}

const ALIASES: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  esc: 'Escape',
  escape: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
  ...KEY_ALIASES_KR,
}

export const KEY_NAMES = Object.keys(KEYS)

export function keyDef(name: string): KeyDef | undefined {
  return KEYS[name] ?? KEYS[ALIASES[name.trim().toLowerCase()] ?? '']
}

/** Addresses this extension may open: http and https only (no file:, chrome:, javascript:, data:) */
export function safeUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  let s = raw.trim()
  if (!s) return undefined
  // Without a scheme, like "naver.com", treat it as https
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`
  try {
    const u = new URL(s)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined
  } catch {
    return undefined
  }
}

/** Pick from JSON by dot path: "data.list", from the end "items.-1", collecting "items.*.name" (empty path means the whole thing) */
export function pickPath(v: unknown, path: string): unknown {
  const keys = path.split('.').filter(Boolean)
  let cur = v
  for (const [i, k] of keys.entries()) {
    if (cur === null || cur === undefined) return undefined
    if (k === '*') {
      if (!Array.isArray(cur)) return undefined
      const rest = keys.slice(i + 1).join('.')
      return cur.map((x) => (rest ? pickPath(x, rest) : x)).filter((x) => x !== undefined && x !== null)
    }
    cur = Array.isArray(cur) && /^-\d+$/.test(k) ? cur.at(Number(k)) : (cur as Record<string, unknown>)[k]
  }
  return cur
}
