/**
 * Turn an app's UIA windows into the same text-with-marks a snapshot produces on macOS and the web. A heading line
 * (`## <window/group title>`), plain static-text lines, and one mark per actionable element:
 *
 *   [e1 <input> "<email label>" <value>]
 *   [e2 <password> "<password label>"]   <- a password field: a ref so Dool2 can focus it, but its VALUE is never shown
 *   [e3 <checkbox> "<label>" <on/off>]
 *   [e4 <button> "<label>"]
 *
 * (The role words and the on/off/value annotations are Korean data from ./locales.) Every actionable element gets
 * `[eN role "name"]`, read by the daemon's ref regex (the same shape page-bridge uses: `/\[((?:f\d+)?e\d+)\s+…\]/`,
 * tolerating the trailing annotations). `refs` maps each `eN` to the backend element handle for click/type. Mirrors
 * @dool2/hands-mac's snapshot() walk and its password redaction.
 */
import type { UiaElement, UiaWindow } from './backend.js'
import { PC_SNAPSHOT_WORDS } from './locales/roles.js'
import { isContainer, isStaticText, isTextField, isToggle, roleWord } from './roles.js'

/** What a snapshot remembers about one `eN` ref, so a later click/type can act on it and respect the password rule. */
export interface RefInfo {
  /** The backend element handle to act on. */
  handle: string
  /** True for a secure/password field: type refuses it, and its value was never emitted. */
  isPassword: boolean
}

export interface SnapshotResult {
  /** The window title shown first (the front window). */
  window: string
  /** The marked-up text. */
  text: string
  /** eN -> what the snapshot remembers about that element, for a later click/type by ref. */
  refs: Map<string, RefInfo>
  /** True if the tree was cut off at maxChars (ask again more narrowly or scroll). */
  truncated: boolean
}

const MAX_NODES = 2500
const MAX_DEPTH = 40

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s
}

function quote(name: string): string {
  // The ref-mark grammar delimits the name with double quotes, so a literal quote inside becomes a single quote.
  return clip(name, 80).replace(/"/g, "'")
}

export function buildSnapshot(windows: readonly UiaWindow[], maxChars: number): SnapshotResult {
  const refs = new Map<string, RefInfo>()
  const lines: string[] = []
  let size = 0
  let nodes = 0
  let n = 0
  let truncated = false

  const add = (s: string): void => {
    if (truncated) return
    if (size + s.length > maxChars) {
      truncated = true
      return
    }
    lines.push(s)
    size += s.length + 1
  }

  const front = windows.find((w) => w.front) ?? windows[0]
  const frontFrame = front?.root.rect

  const walk = (el: UiaElement, depth: number, winFrame?: UiaElement['rect']): void => {
    if (truncated || nodes > MAX_NODES || depth > MAX_DEPTH) return
    nodes += 1
    const name = el.name?.trim() || undefined
    const kr = roleWord(el)
    if (isStaticText(el.controlType)) {
      const v = (el.value ?? name)?.trim()
      if (v) add(clip(v, 300))
    } else if (kr) {
      n += 1
      const ref = `e${n}`
      refs.set(ref, { handle: el.handle, isPassword: el.isPassword })
      let line = `[${ref} ${kr}`
      if (name) {
        line += ` "${quote(name)}"`
      } else if (el.rect && winFrame && winFrame.width > 0 && winFrame.height > 0 && el.rect.width > 0) {
        // A nameless icon button: give its position in the window so Dool2 can match it to the screenshot.
        const x = Math.round(((el.rect.x + el.rect.width / 2 - winFrame.x) / winFrame.width) * 100)
        const y = Math.round(((el.rect.y + el.rect.height / 2 - winFrame.y) / winFrame.height) * 100)
        line += ` ${PC_SNAPSHOT_WORDS.noName} · ${PC_SNAPSHOT_WORDS.position(x, y)}`
      }
      // The value of a text field — but NEVER a password field's value.
      if (isTextField(el.controlType) && !el.isPassword && el.value?.trim()) {
        line += ` ${PC_SNAPSHOT_WORDS.value(clip(el.value.trim(), 120).replace(/"/g, "'"))}`
      }
      if (isToggle(el)) line += ` ${el.checked ? PC_SNAPSHOT_WORDS.on : PC_SNAPSHOT_WORDS.off}`
      if (!el.enabled) line += ` ${PC_SNAPSHOT_WORDS.disabled}`
      add(`${line}]`)
      // Read the text inside list rows/cells too (to know what they are), but not inside leaf controls.
      if (el.controlType !== 'ListItem' && el.controlType !== 'DataItem' && el.controlType !== 'TreeItem') {
        return
      }
    } else if (el.controlType === 'Image' && name) {
      add(PC_SNAPSHOT_WORDS.image(clip(name, 60)))
    } else if (isContainer(el.controlType) && name) {
      add(`## ${clip(name, 80)}`)
    }
    for (const c of el.children) walk(c, depth + 1, winFrame)
  }

  if (windows.length > 1) {
    const titles = windows.map((w) => (w === front ? `${w.title} (front)` : w.title))
    add(`Open windows: ${titles.join(' · ')}. Reading the front one first.`)
  }
  if (front) walk(front.root, 0, frontFrame)
  for (const w of windows) {
    if (w === front || truncated) continue
    add(PC_SNAPSHOT_WORDS.otherWindow(w.title))
    walk(w.root, 0, w.root.rect)
  }

  return {
    window: front?.title ?? '',
    text: lines.join('\n'),
    refs,
    truncated,
  }
}
