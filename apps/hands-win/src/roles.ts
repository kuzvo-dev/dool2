// Maps a UIA ControlType (plus the password/search/toggle flags) to the Korean role word shown in a snapshot mark.
// The mapping mirrors @dool2/hands-mac's roleName(): a macOS AXRole and the matching UIA ControlType resolve to the
// same word (e.g. the button word), so a mark means the same thing on both platforms. English code; the words are data
// in ./locales.
import type { UiaElement } from './backend.js'
import { PC_ROLE_WORDS } from './locales/roles.js'

/** UIA ControlType programmatic names that are actionable, grouped to the same role words hands-mac uses. */
const BUTTON = new Set(['Button', 'SplitButton', 'MenuButton'])
const INPUT = new Set(['Edit', 'Document'])
const SELECT = new Set(['ComboBox'])
const CHECKBOX = new Set(['CheckBox'])
const RADIO = new Set(['RadioButton'])
const SWITCH = new Set(['ToggleButton', 'Switch'])
const TAB = new Set(['TabItem'])
const MENU = new Set(['MenuItem'])
const LINK = new Set(['Hyperlink'])
const ITEM = new Set(['ListItem', 'DataItem', 'TreeItem'])

/** Static text that the snapshot prints as plain text (not as an actionable ref). */
export function isStaticText(controlType: string): boolean {
  return controlType === 'Text'
}

/** Container control types that become a `## title` heading in the snapshot (mirrors hands-mac's window/group header). */
export function isContainer(controlType: string): boolean {
  return (
    controlType === 'Window' ||
    controlType === 'Pane' ||
    controlType === 'Group' ||
    controlType === 'ToolBar' ||
    controlType === 'TabControl'
  )
}

/**
 * The Korean role word for an element, or null when it is not an actionable element (so the walk recurses into it
 * without emitting a ref). A password edit maps to the password word and a search edit to the search word; both still
 * get a ref so Dool2 can focus them, but the password field's VALUE is never emitted (see snapshot.ts).
 */
export function roleWord(el: Pick<UiaElement, 'controlType' | 'isPassword' | 'isSearch'>): string | null {
  if (el.isPassword) return PC_ROLE_WORDS.password
  const t = el.controlType
  if (INPUT.has(t)) return el.isSearch ? PC_ROLE_WORDS.search : PC_ROLE_WORDS.input
  if (BUTTON.has(t)) return PC_ROLE_WORDS.button
  if (SELECT.has(t)) return PC_ROLE_WORDS.select
  if (CHECKBOX.has(t)) return PC_ROLE_WORDS.checkbox
  if (RADIO.has(t)) return PC_ROLE_WORDS.radio
  if (SWITCH.has(t)) return PC_ROLE_WORDS.switch
  if (TAB.has(t)) return PC_ROLE_WORDS.tab
  if (MENU.has(t)) return PC_ROLE_WORDS.menu
  if (LINK.has(t)) return PC_ROLE_WORDS.link
  if (ITEM.has(t)) return PC_ROLE_WORDS.item
  return null
}

/** Whether an actionable element of this type holds editable text (so its value is shown unless it is a password). */
export function isTextField(controlType: string): boolean {
  return INPUT.has(controlType)
}

/** Whether an element is a toggle whose on/off state the snapshot should show. */
export function isToggle(el: Pick<UiaElement, 'controlType'>): boolean {
  return CHECKBOX.has(el.controlType) || SWITCH.has(el.controlType)
}
