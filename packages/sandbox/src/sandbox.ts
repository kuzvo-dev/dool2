// The code-execution hand (v2 "few tools, big hands"). Model-written JavaScript runs in QuickJS compiled to
// WebAssembly, inside the daemon. Nothing of the host process is reachable from inside — no network, file system,
// process, or timers — except through the read-only host bridges (page/vault/pc/fs). Host objects are read-only
// proxies: writing one, or reaching for `constructor`/`__proto__`/`prototype`, throws. Per call there is a time and
// memory limit; the scope persists across calls within one session; only `console.log`/`console.error` text, a
// completion value, and a few image references come back. (Aside's REPL design, research/aside/REPORT §3, §8.1.)

import type { GatedAction } from '@dool2/core'
import type {
  InterruptHandler,
  QuickJSContext,
  QuickJSHandle,
  QuickJSWASMModule,
} from 'quickjs-emscripten-core'
import { BRIDGE_METHODS, type BridgeMethodMeta, type BridgeName, type HostBridges } from './bridges.js'

/** An image produced by the run, returned as an opaque reference rather than inline bytes. */
export interface ImageRef {
  id: string
  alt?: string
}

export interface SandboxLimits {
  /** Wall-clock budget for a single `run` call. */
  timeMs: number
  /** Heap cap for the QuickJS runtime. */
  memoryBytes: number
  /** Characters of `console` output kept. */
  printedMax: number
  /** Image references kept. */
  maxImages: number
}

export const DEFAULT_LIMITS: SandboxLimits = {
  timeMs: 10_000,
  memoryBytes: 128 << 20,
  printedMax: 50_000,
  maxImages: 4,
}

export interface SandboxOptions {
  /** The host implementations. The daemon provides the real ones; tests provide fakes. */
  bridges: HostBridges
  limits?: Partial<SandboxLimits>
  /**
   * Called just before an acting bridge method runs (page.click, vault.fillLogin, …) with the {@link GatedAction}
   * that classifies it, so the daemon's autonomy gate (ADR 0047) can weigh it. The gate is NOT implemented here.
   * Throwing/rejecting from this hook stops the action (the bridge call rejects), which is how a blocked or
   * unsigned action surfaces to the model.
   */
  onAction?: (action: GatedAction) => void | Promise<void>
}

export interface SandboxResult {
  ok: boolean
  /** `console.log`/`console.error` lines, capped at `printedMax` characters. */
  printed: string[]
  /** Completion value: the final expression when the whole snippet is one expression, else the `result` global. */
  value?: unknown
  /** Image references passed to `display(...)`, capped at `maxImages`. */
  images: ImageRef[]
  error?: string
  ms: number
}

interface Engine {
  qjs: QuickJSWASMModule
  deadline: (at: number) => InterruptHandler
}

/** The engine (~3 MB) loads on the first run, never eagerly: shared across every Sandbox in the process. */
let enginePromise: Promise<Engine> | undefined
const loadEngine = async (): Promise<Engine> => {
  const [core, variant] = await Promise.all([
    import('quickjs-emscripten-core'),
    import('@jitl/quickjs-singlefile-mjs-release-sync'),
  ])
  return {
    qjs: await core.newQuickJSWASMModuleFromVariant(variant.default),
    deadline: core.shouldInterruptAfterDeadline,
  }
}

function getEngine(): Promise<Engine> {
  enginePromise ??= loadEngine()
  return enginePromise
}

type EvalOutcome =
  | { kind: 'ok'; value: unknown }
  | { kind: 'syntax'; error: string }
  | { kind: 'error'; error: string }

/**
 * One sandbox session. Keep an instance alive to run several code snippets with a shared scope (variables set with a
 * bare assignment or on `globalThis` persist across `run` calls). Call `dispose()` when the session ends.
 */
export class Sandbox {
  readonly #bridges: HostBridges
  readonly #limits: SandboxLimits
  readonly #onAction: ((action: GatedAction) => void | Promise<void>) | undefined

  #context: QuickJSContext | undefined

  // Reset at the start of each run; the injected console/display close over these.
  #printed: string[] = []
  #printedSize = 0
  #images: ImageRef[] = []

  constructor(opts: SandboxOptions) {
    this.#bridges = opts.bridges
    this.#limits = { ...DEFAULT_LIMITS, ...opts.limits }
    this.#onAction = opts.onAction
  }

  /** Run one code snippet. Resolves to printed text, a completion value, and image references. */
  async run(code: string): Promise<SandboxResult> {
    const { vm, engine } = await this.#ensure()
    const started = Date.now()
    this.#printed = []
    this.#printedSize = 0
    this.#images = []
    vm.runtime.setInterruptHandler(engine.deadline(started + this.#limits.timeMs))

    // Clear the reserved `result` output channel so a prior call's value does not leak in.
    const clear = vm.evalCode('globalThis.result = undefined', 'reset.js')
    if (clear.error) clear.error.dispose()
    else clear.value.dispose()

    let value: unknown
    let errorMsg: string | undefined
    try {
      // Expression form first: it captures a bare final expression (including top-level `await`). If the snippet is
      // not a single expression it fails to compile, and we fall back to statement form.
      const expr = await this.#evalAsync(vm, `(async () => (\n${code}\n))()`, started)
      if (expr.kind === 'ok') {
        value = expr.value
      } else if (expr.kind === 'syntax') {
        const stmt = await this.#evalAsync(vm, `(async () => {\n${code}\n})()`, started)
        if (stmt.kind === 'ok') value = this.#readResult(vm)
        else errorMsg = stmt.error
      } else {
        errorMsg = expr.error
      }
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e)
    } finally {
      vm.runtime.removeInterruptHandler()
    }

    const ms = Date.now() - started
    if (errorMsg !== undefined) {
      return { ok: false, printed: this.#printed, images: this.#images, error: errorMsg, ms }
    }
    return {
      ok: true,
      printed: this.#printed,
      images: this.#images,
      ...(value !== undefined ? { value } : {}),
      ms,
    }
  }

  /** Free the QuickJS context and runtime. The instance cannot run afterwards. */
  dispose(): void {
    this.#context?.dispose()
    this.#context = undefined
  }

  // --- internals --------------------------------------------------------------------------------------------------

  async #ensure(): Promise<{ vm: QuickJSContext; engine: Engine }> {
    const engine = await getEngine()
    if (this.#context) return { vm: this.#context, engine }
    const runtime = engine.qjs.newRuntime()
    runtime.setMemoryLimit(this.#limits.memoryBytes)
    runtime.setMaxStackSize(1 << 20)
    const vm = runtime.newContext()
    this.#context = vm
    this.#installConsole(vm)
    this.#installBridges(vm)
    return { vm, engine }
  }

  #installConsole(vm: QuickJSContext): void {
    const log = vm.newFunction('log', (...args: QuickJSHandle[]) => {
      const line = args.map((h) => this.#show(vm, h)).join(' ')
      this.#printedSize += line.length
      if (this.#printedSize <= this.#limits.printedMax) this.#printed.push(line)
    })
    const consoleObj = vm.newObject()
    vm.setProp(consoleObj, 'log', log)
    vm.setProp(consoleObj, 'error', log)
    vm.setProp(vm.global, 'console', consoleObj)
    log.dispose()
    consoleObj.dispose()

    const display = vm.newFunction('display', (refHandle: QuickJSHandle) => {
      const v = vm.dump(refHandle)
      if (this.#images.length < this.#limits.maxImages) this.#images.push(toImageRef(v))
    })
    vm.setProp(vm.global, 'display', display)
    display.dispose()
  }

  #installBridges(vm: QuickJSContext): void {
    for (const name of Object.keys(BRIDGE_METHODS) as BridgeName[]) {
      const raw = vm.newObject()
      const methods = BRIDGE_METHODS[name]
      const impl = this.#bridges[name] as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
      for (const method of Object.keys(methods)) {
        const meta = methods[method] as BridgeMethodMeta
        const fn = vm.newFunction(`${name}.${method}`, (...argHandles: QuickJSHandle[]) => {
          const args = argHandles.map((h) => vm.dump(h))
          const promise = vm.newPromise()
          this.#invoke(name, method, meta, impl, args).then(
            (res) => {
              const h = this.#push(vm, res)
              promise.resolve(h)
              if (h !== vm.undefined) h.dispose()
            },
            (err: unknown) => {
              const e = vm.newError(err instanceof Error ? err.message : String(err))
              promise.reject(e)
              e.dispose()
            },
          )
          // Pump the QuickJS job queue once the host settles, so an awaiting snippet continues.
          promise.settled.then(() => vm.runtime.executePendingJobs())
          return promise.handle
        })
        vm.setProp(raw, method, fn)
        fn.dispose()
      }
      vm.setProp(vm.global, `__raw_${name}`, raw)
      raw.dispose()
    }

    // Wrap each raw bridge in a read-only Proxy: writes throw, and `constructor`/`__proto__`/`prototype` are blocked
    // so there is no path from a host object back to the host realm's constructors.
    const boot = `(() => {
  const readonly = (target) =>
    new Proxy(target, {
      get(t, prop, receiver) {
        if (prop === 'constructor' || prop === '__proto__' || prop === 'prototype') {
          throw new Error('host objects are read-only')
        }
        return Reflect.get(t, prop, receiver)
      },
      set() { throw new Error('host objects are read-only') },
      defineProperty() { throw new Error('host objects are read-only') },
      deleteProperty() { throw new Error('host objects are read-only') },
      setPrototypeOf() { throw new Error('host objects are read-only') },
    })
  for (const name of ['page', 'vault', 'pc', 'fs']) {
    globalThis[name] = readonly(globalThis['__raw_' + name])
    delete globalThis['__raw_' + name]
  }
})()`
    const r = vm.evalCode(boot, 'bootstrap.js')
    if (r.error) {
      const dumped = vm.dump(r.error)
      r.error.dispose()
      throw new Error(`sandbox bootstrap failed: ${JSON.stringify(dumped)}`)
    }
    r.value.dispose()
  }

  async #invoke(
    name: BridgeName,
    method: string,
    meta: BridgeMethodMeta,
    impl: Record<string, (...a: unknown[]) => Promise<unknown>>,
    args: unknown[],
  ): Promise<unknown> {
    // Acting calls are reported to the gate seam before they run; a throw here stops the action.
    if (meta.acting && meta.classify && this.#onAction) {
      await this.#onAction(meta.classify(args))
    }
    const fn = impl[method]
    if (typeof fn !== 'function') throw new Error(`bridge ${name}.${method} is not implemented`)
    return await fn.apply(impl, args)
  }

  /**
   * Drive an async snippet to completion. Returns `syntax` when the wrapper fails to compile (so the caller can try
   * the other form), `error` on a runtime error or the time limit, and `ok` with the resolved value otherwise.
   */
  async #evalAsync(vm: QuickJSContext, wrapped: string, started: number): Promise<EvalOutcome> {
    const res = vm.evalCode(wrapped, 'code.js')
    if (res.error) {
      const dumped = vm.dump(res.error) as { name?: string; message?: string } | string
      res.error.dispose()
      const name = typeof dumped === 'object' ? dumped.name : undefined
      const msg = this.#errMsg(dumped, started)
      return name === 'SyntaxError' ? { kind: 'syntax', error: msg } : { kind: 'error', error: msg }
    }

    const handle = res.value
    let settled: { error?: QuickJSHandle; value?: QuickJSHandle } | undefined
    let done = false
    vm.resolvePromise(handle).then(
      (r) => {
        settled = r
        done = true
      },
      () => {
        done = true
      },
    )
    // The deadline interrupt handler stops a synchronous runaway during executePendingJobs; this wall-clock guard
    // stops a snippet that awaits a host promise that never settles.
    while (!done) {
      vm.runtime.executePendingJobs()
      if (Date.now() - started > this.#limits.timeMs) break
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    handle.dispose()

    if (!settled) return { kind: 'error', error: `Stopped after ${this.#limits.timeMs / 1000} s` }
    if (settled.error) {
      const dumped = vm.dump(settled.error) as { name?: string; message?: string } | string
      settled.error.dispose()
      return { kind: 'error', error: this.#errMsg(dumped, started) }
    }
    const value = settled.value ? vm.dump(settled.value) : undefined
    settled.value?.dispose()
    return { kind: 'ok', value }
  }

  #readResult(vm: QuickJSContext): unknown {
    const r = vm.evalCode('globalThis.result', 'result.js')
    if (r.error) {
      r.error.dispose()
      return undefined
    }
    const v = vm.dump(r.value)
    r.value.dispose()
    return v
  }

  #show(vm: QuickJSContext, handle: QuickJSHandle): string {
    const v = vm.dump(handle)
    return typeof v === 'string' ? v : JSON.stringify(v)
  }

  /** Convert a host value to a QuickJS handle via JSON (only data, refs and text cross the boundary). */
  #push(vm: QuickJSContext, value: unknown): QuickJSHandle {
    if (value === undefined) return vm.undefined
    const r = vm.evalCode(`(${JSON.stringify(value)})`, 'value.js')
    return vm.unwrapResult(r)
  }

  #errMsg(dumped: { name?: string; message?: string } | string, started: number): string {
    const base = typeof dumped === 'string' ? dumped : `${dumped.name ?? 'Error'}: ${dumped.message ?? ''}`
    const late = Date.now() - started >= this.#limits.timeMs || /interrupt/i.test(base)
    return late ? `Stopped after ${this.#limits.timeMs / 1000} s (${base})` : base
  }
}

function toImageRef(v: unknown): ImageRef {
  if (typeof v === 'string') return { id: v }
  if (v && typeof v === 'object' && 'id' in v) {
    const o = v as { id: unknown; alt?: unknown }
    return { id: String(o.id), ...(typeof o.alt === 'string' ? { alt: o.alt } : {}) }
  }
  return { id: String(v) }
}
