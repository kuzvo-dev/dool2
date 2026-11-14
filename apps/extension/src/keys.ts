// 키 이름 → CDP Input.dispatchKeyEvent 값. 실제 키보드 입력과 같은 이벤트를 만든다.

export interface KeyDef {
  key: string
  code: string
  keyCode: number
  /** 글자를 만드는 키 (Enter는 \r이어야 폼이 제출된다) */
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
  엔터: 'Enter',
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
}

export const KEY_NAMES = Object.keys(KEYS)

export function keyDef(name: string): KeyDef | undefined {
  return KEYS[name] ?? KEYS[ALIASES[name.trim().toLowerCase()] ?? '']
}

/** 이 확장이 열어도 되는 주소: http·https만 (file:, chrome:, javascript:, data: 금지) */
export function safeUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  let s = raw.trim()
  if (!s) return undefined
  // "naver.com"처럼 스킴 없이 오면 https로 본다
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`
  try {
    const u = new URL(s)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined
  } catch {
    return undefined
  }
}
