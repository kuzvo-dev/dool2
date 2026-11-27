// code_run (ADR 0045, threat model T32): JavaScript Dool2 writes runs in QuickJS compiled to WebAssembly, inside the
// daemon. Nothing of the host goes in except a function that collects printed text: no file system, network, process,
// timers or Dool2 API. Memory and run time are capped. For computing, converting and shaping data when no tool does it
import variant from '@jitl/quickjs-singlefile-mjs-release-sync'
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSHandle,
  type QuickJSWASMModule,
  shouldInterruptAfterDeadline,
} from 'quickjs-emscripten-core'

export interface CodeRunResult {
  ok: boolean
  /** What console.log printed, line by line */
  printed: string[]
  /** The value of the last expression (as JSON), or the error */
  value?: unknown
  error?: string
  ms: number
}

/** Limits (tests shrink them) */
export interface CodeRunLimits {
  timeMs: number
  memoryBytes: number
  /** Characters of printed text kept */
  printedMax: number
}

const LIMITS: CodeRunLimits = { timeMs: 10_000, memoryBytes: 128 << 20, printedMax: 50_000 }

let module: Promise<QuickJSWASMModule> | undefined

/**
 * Runs the code once in a fresh runtime. `input` is put in as the global `input` (the data the code works on, already
 * read by another tool). The value of the last expression comes back as JSON
 */
export async function runCode(
  code: string,
  input?: unknown,
  limits: Partial<CodeRunLimits> = {},
): Promise<CodeRunResult> {
  const lim = { ...LIMITS, ...limits }
  module ??= newQuickJSWASMModuleFromVariant(variant)
  const qjs = await module
  const started = Date.now()
  const rt = qjs.newRuntime()
  rt.setMemoryLimit(lim.memoryBytes)
  rt.setMaxStackSize(1 << 20)
  rt.setInterruptHandler(shouldInterruptAfterDeadline(started + lim.timeMs))
  const vm = rt.newContext()
  const printed: string[] = []
  let size = 0
  const show = (h: QuickJSHandle) => {
    const v = vm.dump(h)
    return typeof v === 'string' ? v : JSON.stringify(v)
  }
  try {
    const log = vm.newFunction('log', (...args) => {
      const line = args.map(show).join(' ')
      size += line.length
      if (size <= lim.printedMax) printed.push(line)
    })
    const consoleObj = vm.newObject()
    vm.setProp(consoleObj, 'log', log)
    vm.setProp(consoleObj, 'error', log)
    vm.setProp(vm.global, 'console', consoleObj)
    log.dispose()
    consoleObj.dispose()
    if (input !== undefined) {
      const set = vm.evalCode(`globalThis.input = ${JSON.stringify(input)};`)
      if (set.error) set.error.dispose()
      else set.value.dispose()
    }
    const r = vm.evalCode(code, 'code.js')
    if (r.error) {
      const e = vm.dump(r.error) as { name?: string; message?: string } | string
      r.error.dispose()
      const msg = typeof e === 'string' ? e : `${e?.name ?? 'Error'}: ${e?.message ?? ''}`
      const late = Date.now() - started >= lim.timeMs
      return {
        ok: false,
        printed,
        error: late ? `Stopped after ${lim.timeMs / 1000} s (${msg})` : msg,
        ms: Date.now() - started,
      }
    }
    const value = vm.dump(r.value)
    r.value.dispose()
    return { ok: true, printed, ...(value !== undefined ? { value } : {}), ms: Date.now() - started }
  } catch (e) {
    return { ok: false, printed, error: (e as Error).message, ms: Date.now() - started }
  } finally {
    vm.dispose()
    rt.dispose()
  }
}
