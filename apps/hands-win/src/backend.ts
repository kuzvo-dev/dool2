/**
 * The native seam. Everything above this interface is the pure protocol + safety logic that CI exercises with
 * {@link InMemoryUiaBackend}; everything the interface promises is the real Windows UI Automation (UIA) work, done by a
 * backend implemented when building on a real Windows machine (a native N-API addon over `IUIAutomation`, or a
 * PowerShell / C# helper over `System.Windows.Automation`). The protocol layer never calls Win32 directly — it only
 * calls these methods — so the helper builds and is fully unit-tested on macOS/Linux CI, and only this file's real
 * implementation is Windows-only.
 *
 * What a real UIA backend implements, method by method, is documented on each member below.
 */

/** A running top-level application, as the UIA/Win32 process list sees it. */
export interface UiaApp {
  /**
   * The opaque app identifier the protocol passes back as `app` in every command. On Windows this is the process image
   * name (e.g. `slack.exe`) or an AUMID for a packaged app — the Windows analog of a macOS bundle id. The daemon treats
   * it as an opaque string, so the command shapes stay identical to @dool2/hands-mac (which carries a bundle id here).
   */
  app: string
  /** Human-readable window/app title. */
  name: string
  pid: number
  /** True if this app currently owns the foreground window. */
  active: boolean
}

/** An installed (not necessarily running) application, for looking an app id up by name. */
export interface UiaInstalledApp {
  app: string
  name: string
  /** True while the app is still being installed (e.g. a Store app mid-download): present but not yet launchable. */
  installing?: boolean
}

/**
 * One element of a UIA tree. Field names are UIA concepts mapped to plain data; the protocol layer turns this into the
 * Korean-worded `[eN role "name"]` marks and decides what is actionable and what must be redacted.
 */
export interface UiaElement {
  /** A stable handle the backend can act on later (click/focus/setValue). Opaque to the protocol layer. */
  handle: string
  /** UIA ControlType programmatic name, e.g. `Button`, `Edit`, `CheckBox`, `ComboBox`, `Text`, `Window`. */
  controlType: string
  /** UIA Name property, if any. */
  name?: string
  /** The control's text value (UIA ValuePattern / LegacyIAccessible value). NEVER read for a password field. */
  value?: string
  /** UIA IsPassword: a secure field. Its value is never read or emitted, and type refuses it. */
  isPassword: boolean
  /**
   * A hint that this edit is a search box (UIA has no distinct search ControlType; a backend may set this from the
   * localized control type, an automation id, or a placeholder). Only affects the role word shown.
   */
  isSearch?: boolean
  /** UIA IsEnabled. A disabled element is shown but marked "cannot press". */
  enabled: boolean
  /** For a toggle/checkbox: UIA Toggle/SelectionItem state, true when on/checked. */
  checked?: boolean
  /** Screen-pixel bounding rectangle (UIA BoundingRectangle), used for a nameless icon button's position hint. */
  rect?: { x: number; y: number; width: number; height: number }
  children: UiaElement[]
}

/** A top-level window of an app, with its UIA subtree. */
export interface UiaWindow {
  title: string
  /** True if this is the foreground window of the app. */
  front: boolean
  root: UiaElement
}

/** A captured image of an app window. */
export interface UiaShot {
  /** Base64 of the encoded image bytes. */
  data: string
  mime: string
  window: string
  width: number
  height: number
}

/** UIA/host capability + lock state, the Windows analog of @dool2/hands-mac's permission status. */
export interface UiaStatus {
  /** Whether UI Automation can read/drive other apps' trees right now. */
  uiAutomation: boolean
  /** Whether the workstation is locked (no acting can reach an app). */
  locked: boolean
}

/**
 * The native UI Automation surface. A real implementation drives `IUIAutomation` (or `System.Windows.Automation`); the
 * fake {@link InMemoryUiaBackend} implements the same shape for tests. All methods are async so the real backend can do
 * out-of-process UIA calls.
 */
export interface UiaBackend {
  /** Enumerate running top-level apps. Real: walk the desktop's child windows / the process list. */
  apps(): Promise<UiaApp[]>
  /** Enumerate installed apps (Start menu shortcuts, Store AUMIDs, Program Files). Real: Shell / registry scan. */
  installed(): Promise<UiaInstalledApp[]>
  /** Launch an app by its id and wait briefly for a window. Real: ShellExecute / `explorer.exe shell:AppsFolder\\…`. */
  launch(app: string): Promise<void>
  /** Bring an app's foreground window up and return its windows + trees. Real: SetForegroundWindow + a UIA tree walk. */
  tree(app: string): Promise<UiaWindow[]>
  /** Invoke an element (UIA InvokePattern, else a click at its center). Real: pattern or SendInput mouse click. */
  clickElement(handle: string): Promise<void>
  /** Click a screen point (app-relative is resolved by the caller). Real: SendInput mouse move + click. */
  clickPoint(app: string, x: number, y: number): Promise<void>
  /** Give an element keyboard focus. Real: UIA SetFocus. */
  focus(handle: string): Promise<void>
  /** Set an element's text (UIA ValuePattern.SetValue, else focus + paste). Real: ValuePattern or clipboard paste. */
  setValue(handle: string, text: string): Promise<void>
  /** Type text into whatever is focused in the app. Real: SendInput unicode / clipboard paste. */
  typeText(app: string, text: string): Promise<void>
  /** Send one key with modifiers to the app. Real: SendInput key down/up with the modifier flags. */
  sendKey(app: string, key: string, modifiers: readonly string[]): Promise<void>
  /** Capture the app's largest on-screen window. Real: PrintWindow / Windows.Graphics.Capture, encoded to JPEG. */
  screenshot(app: string, maxWidth: number): Promise<UiaShot>
  /** UIA availability + lock state. Real: a cheap UIA probe + WTSQuerySessionInformation / lock detection. */
  status(): Promise<UiaStatus>
}
