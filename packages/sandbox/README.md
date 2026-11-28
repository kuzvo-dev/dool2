# @dool2/sandbox

Dool2 v2's code-execution hand — the "big hand" of **few tools, big hands** (ADR 0045). The brain writes JavaScript;
the sandbox runs it in QuickJS (WebAssembly) inside the daemon, with read-only host bridges to the page, the vault
(masked), PC apps, and files. New site abilities arrive as skills, not as new tools.

## What runs

```ts
import { Sandbox, makeFakeBridges } from '@dool2/sandbox'

const box = new Sandbox({
  bridges, // the daemon's real page/vault/pc/fs; tests use makeFakeBridges()
  limits: { timeMs: 10_000 },
  onAction: (action) => gate.weigh(action), // the daemon's autonomy gate (ADR 0047)
})

const result = await box.run(`
  const snap = await page.snapshot()
  const login = (await vault.listItems()).find((i) => i.site === 'naver.com')
  if (login) await vault.fillLogin(login.id)
  snap.title
`)
// result.printed  -> console.log/console.error lines
// result.value    -> the final expression, or the 'result' global
// result.images   -> references passed to display(...)
box.dispose()
```

- One QuickJS runtime per `Sandbox` instance. Variables persist across `run` calls (bare assignment or `globalThis`),
  so a session can build up state.
- Each `run` has a time limit (an interrupt stops a synchronous runaway; a wall-clock guard stops an endless
  `await`) and a memory limit.
- Only `console.log`/`console.error` text, a completion value, and a few image **references** come back. Image bytes
  are never inlined.

## Safety guarantees

- **Nothing of the host is reachable** from inside QuickJS — no network, file system, process, or timers — except
  through the injected bridges. Those four objects are the only host surface, and the sandbox injects exactly the
  methods listed in `BRIDGE_METHODS`.
- **Host objects are read-only.** Writing a property, defining/deleting one, or reaching for
  `constructor`/`__proto__`/`prototype` throws `host objects are read-only`, so there is no path back to the host
  realm's constructors.
- **Secrets never reach the AI.** The vault bridge has no method that returns a secret value: `listItems()` returns
  masked summaries (`{ id, site, username, hasTotp }`), and `fillLogin(id)`/`fillTotp(id)` act by opaque `id` while
  the daemon places the real value into the page.

## The gate seam

When sandbox code calls an **acting** bridge method (`page.click`, `vault.fillLogin`, `fs.write`, …), the sandbox
classifies the call into a `GatedAction` (`{ tier, label }`, from `@dool2/core`) and passes it to the `onAction`
hook **before** the method runs, so the daemon's autonomy gate (ADR 0047) can weigh it. Throwing from `onAction`
stops the action. The gate itself is **not** implemented here — this package only keeps the seam clean. The default
tier is conservative (`act`); the daemon refines it with page/skill context (a click on a pay button becomes `pay`).

Read-only methods (`snapshot`, `fetch`, `listItems`, `read`, `list`) are never gated.
