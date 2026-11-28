/**
 * A pure in-memory {@link UiaBackend} for tests and the offline smoke — NO real Windows or UI Automation. It holds a
 * set of fake apps with element trees, records every acting call, and (for setValue) updates the tree so a re-snapshot
 * reflects the change. The real UIA backend (backend.ts) is the only Windows-only part of the helper; everything this
 * fake stands in for is exercised in CI on any platform.
 */
import type {
  UiaApp,
  UiaBackend,
  UiaElement,
  UiaInstalledApp,
  UiaShot,
  UiaStatus,
  UiaWindow,
} from './backend.js'

let handleSeq = 0

/** Build a {@link UiaElement} with sensible defaults, auto-assigning a handle when one is not given. */
export function uiaEl(partial: Partial<UiaElement> & { controlType: string }): UiaElement {
  handleSeq += 1
  return {
    handle: partial.handle ?? `h${handleSeq}`,
    controlType: partial.controlType,
    isPassword: partial.isPassword ?? false,
    enabled: partial.enabled ?? true,
    children: partial.children ?? [],
    ...(partial.name !== undefined ? { name: partial.name } : {}),
    ...(partial.value !== undefined ? { value: partial.value } : {}),
    ...(partial.isSearch !== undefined ? { isSearch: partial.isSearch } : {}),
    ...(partial.checked !== undefined ? { checked: partial.checked } : {}),
    ...(partial.rect !== undefined ? { rect: partial.rect } : {}),
  }
}

/** A fake app the backend knows about. */
export interface FakeApp {
  /** Opaque app id (process image name / AUMID). */
  app: string
  name: string
  pid: number
  /** Owns the foreground window. */
  active?: boolean
  /** In the running list (apps()). When false it is only in installed(). Defaults to true. */
  running?: boolean
  /** Still being installed (installed() marks it, open() of it is up to the backend). */
  installing?: boolean
  windows?: UiaWindow[]
}

/** Every acting call the fake received, for assertions. */
export interface RecordedActions {
  launched: string[]
  clickedElements: string[]
  clickedPoints: Array<{ app: string; x: number; y: number }>
  focused: string[]
  setValues: Array<{ handle: string; text: string }>
  typedText: Array<{ app: string; text: string }>
  keys: Array<{ app: string; key: string; modifiers: string[] }>
}

export class InMemoryUiaBackend implements UiaBackend {
  readonly actions: RecordedActions = {
    launched: [],
    clickedElements: [],
    clickedPoints: [],
    focused: [],
    setValues: [],
    typedText: [],
    keys: [],
  }

  status_: UiaStatus = { uiAutomation: true, locked: false }

  constructor(private readonly fakeApps: FakeApp[] = []) {}

  private find(app: string): FakeApp | undefined {
    return this.fakeApps.find((a) => a.app === app)
  }

  private allElements(): UiaElement[] {
    const out: UiaElement[] = []
    const walk = (el: UiaElement): void => {
      out.push(el)
      for (const c of el.children) walk(c)
    }
    for (const a of this.fakeApps) for (const w of a.windows ?? []) walk(w.root)
    return out
  }

  private element(handle: string): UiaElement {
    const el = this.allElements().find((e) => e.handle === handle)
    if (!el) throw new Error(`no element ${handle}`)
    return el
  }

  async apps(): Promise<UiaApp[]> {
    return this.fakeApps
      .filter((a) => a.running !== false)
      .map((a) => ({ app: a.app, name: a.name, pid: a.pid, active: a.active ?? false }))
  }

  async installed(): Promise<UiaInstalledApp[]> {
    return this.fakeApps.map((a) => ({
      app: a.app,
      name: a.name,
      ...(a.installing ? { installing: true } : {}),
    }))
  }

  async launch(app: string): Promise<void> {
    this.actions.launched.push(app)
    const a = this.find(app)
    if (a) a.running = true
  }

  async tree(app: string): Promise<UiaWindow[]> {
    return this.find(app)?.windows ?? []
  }

  async clickElement(handle: string): Promise<void> {
    this.element(handle)
    this.actions.clickedElements.push(handle)
  }

  async clickPoint(app: string, x: number, y: number): Promise<void> {
    this.actions.clickedPoints.push({ app, x, y })
  }

  async focus(handle: string): Promise<void> {
    this.element(handle)
    this.actions.focused.push(handle)
  }

  async setValue(handle: string, text: string): Promise<void> {
    const el = this.element(handle)
    el.value = text
    this.actions.setValues.push({ handle, text })
  }

  async typeText(app: string, text: string): Promise<void> {
    this.actions.typedText.push({ app, text })
  }

  async sendKey(app: string, key: string, modifiers: readonly string[]): Promise<void> {
    this.actions.keys.push({ app, key, modifiers: [...modifiers] })
  }

  async screenshot(app: string, maxWidth: number): Promise<UiaShot> {
    const front = (this.find(app)?.windows ?? []).find((w) => w.front)
    const width = Math.min(maxWidth, 800)
    // A 1x1 JPEG stand-in; the real backend returns the encoded window capture.
    return {
      mime: 'image/jpeg',
      data: '/9j/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf',
      window: front?.title ?? '',
      width,
      height: Math.round(width * 0.625),
    }
  }

  async status(): Promise<UiaStatus> {
    return this.status_
  }
}

/**
 * A small seeded backend: a login window (with a password field) and a messenger-like window, enough for the offline
 * smoke and for eyeballing the snapshot output. Tests build their own trees; this is a convenience, not the test data.
 */
export function makeFakeUiaBackend(): InMemoryUiaBackend {
  const loginWindow: UiaWindow = {
    title: 'Sign in',
    front: true,
    root: uiaEl({
      controlType: 'Window',
      name: 'Sign in',
      rect: { x: 0, y: 0, width: 400, height: 300 },
      children: [
        uiaEl({ controlType: 'Text', value: 'Welcome back' }),
        uiaEl({ controlType: 'Edit', name: 'Email', value: 'a@b.com' }),
        uiaEl({ controlType: 'Edit', name: 'Password', isPassword: true, value: 'super-secret' }),
        uiaEl({ controlType: 'CheckBox', name: 'Keep me signed in', checked: false }),
        uiaEl({ controlType: 'Button', name: 'Sign in' }),
      ],
    }),
  }
  return new InMemoryUiaBackend([
    { app: 'demo.exe', name: 'Demo', pid: 4242, active: true, windows: [loginWindow] },
  ])
}
