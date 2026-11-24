# Dool2 Architecture

> Status: **living design document**. It keeps changing as the implementation moves on. Individual decisions and their reasons are in the [decision records (ADR)](decisions/README.md). Security assumptions are in the [threat model](security/threat-model.md).
> Sources are the official docs as of 2026-11-14 (chapter 12).

The baseline is the promise on the landing page (https://dool2.com). You make requests from your phone, and the work happens on your own computer. Anything that spends money is always asked first, and conversations stay on your computer.

## 0. Overview

```
 ┌──────────── Phone (PWA → native later) ────────────┐
 │ Send requests · see results · sign approvals (Face ID/fingerprint) │
 └───────────────▲──────────────────────────────────────┘
                 │ end-to-end encryption (keys exchanged at pairing)
       ┌─────────┴──────────┐
       │  Relay              │  forwards ciphertext only · mailbox for an off PC · content-free push
       │  Cloudflare / self  │
       └─────────▲──────────┘
                 │ the PC only connects outward (no open ports)
 ┌───────────────┴───────────── My PC (Mac · Windows) ─────────────────────────┐
 │  Dool2 app (Electron shell: tray · settings · updates)                       │
 │   └─ dool2d (Dool2 daemon, Node)                                             │
 │        ├─ Engine: runs chats and tasks, common agent interface               │
 │        │    ├─ Claude adapter ──▶ the official `claude -p` the user installed (user's subscription) │
 │        │    └─ Codex adapter  ──▶ `codex app-server` (ChatGPT login)         │
 │        │             └─ both agents can use only the "Dool2 tools (MCP)"      │
 │        ├─ Approval gate: classify risk → check phone signature → run         │
 │        ├─ Hand 1: my browser + Dool2 extension: usual logins · AI cursor · remote view │
 │        ├─ Hand 2: PC screen control: KakaoTalk PC, Hangul, certificate windows, etc. (allowed apps only) │
 │        ├─ Records: SQLite (chats, what was done, per-step screens, approval history) │
 │        └─ Watch and scheduled-run scheduler                                  │
 └──────────────────────────────────────────────────────────────────────────────┘
```

**Five core decisions**
1. **The AI runs on the user's PC with the user's own subscription.** Dool2 only runs the official program. It does not log in on the user's behalf or take tokens (Claude). It uses only the login flow that OpenAI officially allows (Codex).
2. **The agent's default hands (shell, files, web) are turned off.** The agent can use only Dool2 tools. This leaves no way around the approval gate.
3. **The approval gate is code, not a prompt.** `pay` and `contact` actions run only with an approval signed on the phone.
4. **The relay sees only ciphertext.** The official server runs for free, and you can also run your own.
5. **The daemon (dool2d) runs without a screen.** On Mac and Windows it runs inside the Electron app. On the Dool2 Box (a small Linux PC) it runs standalone.

---

## 1. Monorepo layout

We use pnpm workspaces and Turborepo, with TypeScript as the single language (Node 24 LTS). Playwright, the MCP SDK and Electron are all in the Node ecosystem, so there is no reason to split languages.

```
dool2/
  apps/
    desktop/        Electron shell: tray, first-run setup wizard, settings, auto-update, the PC-side chat window
    daemon/         dool2d executable. desktop launches it; on the Dool2 Box it runs as a standalone service
    mobile/         Phone app. Stage 1 is a PWA (Vite + React, porting the UI of the earlier prototype)
    extension/      Dool2 extension (Chrome, Edge, Whale, etc., Manifest V3). A thin hand with no judgment: chrome.debugger + native messaging
    relay/          Relay. Cloudflare Workers + Durable Objects, plus a Node version for self-hosting
    site/           (later) landing page and waitlist. For now it stays in the old repo
  packages/
    protocol/       Phone↔PC message schemas (zod), end-to-end encryption, pairing, version negotiation
    engine/         Chat and task state machine, common AgentRuntime interface, scheduler
    agent-claude/   Claude Code adapter
    agent-codex/    Codex adapter (SIWC login, app-server JSON-RPC)
    mcp-tools/      Dool2 MCP server. The agent starts it as a child process; it connects to dool2d over local IPC
    gate/           Approval gate: risk classification, approval request normalization, signature verification  ← security core
    browser/        Browser control: protocol with the extension, snapshots, actions, network guard, remote view, (exception) dedicated-browser mode
    hands/          PC screen control helper (Rust, Mac and Windows): screen capture, accessibility tree, mouse and keyboard, app allow list
    store/          SQLite schema and migrations, screen capture storage
    skills-runtime/ Reading, checking and signature verification of skills
    ui/             Shared design tokens and components (shared by desktop and mobile)
  skills/           Per-service usage (porting the 40 or so drafts from the old repo)
  docs/             Design, ADRs (decisions/), threat model (security/)
```

- `gate/`, the encryption part of `protocol/`, and the update verification code are grouped separately in CODEOWNERS as the **security core**.
- Tests use Vitest (unit) and Playwright (browser tools, local test site). The approval gate has a fixed regression test that fails if a `pay` action runs without a signature.

## 2. Process structure

```
Electron main ──spawn──▶ dool2d (Node, utilityProcess or child process)
                           │
                           ├─spawn──▶ claude -p … (one chat as segmented sessions, continued with --resume: ADR 0015)
                           │             └─spawn──▶ dool2-mcp (stdio)  ─┐
                           ├─spawn──▶ codex app-server (resident, JSON-RPC)   │ local IPC
                           │             └─spawn──▶ dool2-mcp (stdio)  ─┤ (Unix socket / Windows named pipe,
                           │                                            │  one-time token per session)
                           ◀────────────────────────────────────────────┘
                           ├─ Playwright ──▶ Chrome (Dool2-only profile)
                           └─ WebSocket ──▶ relay
```

- **`dool2-mcp` is a thin forwarder.** It only announces the tool list and passes the real execution to dool2d over IPC. Browser state and the approval gate live in dool2d only. So the gate is the same whichever agent you swap in.
- The IPC token is passed to the agent as an environment variable when it is launched. This keeps other programs on the same PC from calling Dool2 tools.
- Closing the Electron window does not stop dool2d. It keeps running in the tray and starts automatically at login.

## 3. AI agent integration

### 3.1 Common interface (`engine`)

```ts
interface AgentRuntime {
  id: 'claude' | 'codex' | 'opencode'
  detect(): Promise<AgentStatus>
  /** One turn in a fresh program (side chats, the feed, summaries, runtimes without sessions) */
  runTurn(input: TurnInput): AsyncIterable<AgentEvent>
  /** One program kept running for a conversation segment (ADR 0035) */
  openSession?(input: SessionInput): Promise<AgentSession | undefined>
}
interface AgentSession {
  readonly alive: boolean
  send(text: string, signal?: AbortSignal): AsyncIterable<AgentEvent> // one turn, until done or error
  interrupt(): void // the stop button; the session stays usable
  close(): Promise<void>
}
```

`packages/engine/src/runtime.ts` has the full types. Claude Code implements `openSession`; Codex and OpenCode use
`runTurn` for now.

- In settings, the user picks either "Run with Claude Code" or "Run with Codex". If both are connected, Dool2 can switch to the other when one hits its limit (only when the user turns this on).
- Per-service know-how does not use each CLI's skill feature. Instead, Dool2 provides it as Dool2 service tools (connectors, `skills/<id>/tools.json`, ADR 0018). The tools of connected services (`catchtable_search` …) are visible right away, and the rest go through `service_find` → `service_call`. This way both agents use the same tools, and the approval gate and signature check also sit in one place.

### 3.2 Claude Code

**Policy assessment** (the detailed reasons will be recorded in ADR-0002)
- Anthropic prohibits third-party apps from building in claude.ai login directly, or from relaying, collecting or storing subscription credentials. It also says apps built on the Agent SDK should in principle use an API key.
- There is an exception. It states that it does not stop a user from logging in to an **unmodified official Claude Code binary** with their own subscription. There are four conditions.
  - Do not modify the binary
  - Do not block the built-in authentication
  - Do not resell or relay usage
  - Each user logs in with their own credentials
- In 2026 this policy changed several times: block → announced re-allow → on hold. We design **assuming it can change.**

**What we do**
- Find the `claude` the user installed and logged in to, and run it as is. We do not use the binary bundled with the Agent SDK.
- Dool2 does not handle the login screen, tokens or `setup-token`.
  - If the user is not logged in, we guide them to open a terminal and run `claude auth login`.
  - We check login state from the output (JSON) of `claude auth status`.
- We do not use `--bare`, because that mode does not read the subscription login.
- Launch form (checked on 2.1.325; one program per conversation segment, ADR 0035):
  ```
  claude -p
    --input-format stream-json --output-format stream-json --verbose
    --tools ""                                 # turn off all built-in tools (shell, files, web)
    --strict-mcp-config --mcp-config <Dool2 MCP config>
    --allowedTools "mcp__dool2__*"              # auto-approve Dool2 tools only
    --permission-prompt-tool mcp__dool2__permission
    --append-system-prompt-file <Dool2 instructions>
    --resume <session id>                       # when continuing a chat
  ```
  Messages go in as one `{"type":"user",...}` line each and a turn ends at its `result` line. Stop is a
  `control_request` with `subtype: "interrupt"`. Summaries use `--resume <id> --fork-session` in a separate program.
  The working folder is an empty Dool2-only folder (`<app data>/workspace`), because `-p` also runs the `.claude/` settings and `.mcp.json` in the working folder.
- We receive usage from the stream's `rate_limit_event` and show it on the phone, for example "62% used this week".
- In case the limit is reached or a policy change blocks us, we also keep an **API key mode** (`claude-api`), where the user enters their own key.
- The name is written only as plain text, as in "Run with Claude Code". It is not used in the product name or logo.
- To do: tell Anthropic in advance about a usage pattern like Dool2's and ask for approval. The docs mention a "previously approved" path.

### 3.3 Codex

**Policy assessment**
- OpenAI has opened the subscription usage flow of "Sign in with ChatGPT" (SIWC) to **open-source, local apps without an application**. Open-source projects such as OpenCode and T3 are on the official partner list. Dool2 uses this path.
- Paid apps and remotely hosted apps must apply separately. Before launch, we check with OpenAI whether selling the Dool2 Box falls under this.

**What we do**
- Login: Dool2 starts the SIWC OAuth flow itself. The button text is "Continue with ChatGPT", and the callback is a `127.0.0.1` loopback. The received token is stored in the OS keychain (Electron `safeStorage`).
- We follow the UI rules.
  - On first login, show "This uses your ChatGPT plan"
  - While in use, show "Using ChatGPT plan"
  - A link to the usage management page on chatgpt.com
- Run: we ship a verified version of the Codex binary with Dool2 (Apache-2.0). We keep `codex app-server` resident over stdio JSON-RPC.
  - `CODEX_HOME` is split into a Dool2-only folder, so it does not mix with the user's personal Codex settings.
  - `-c` settings are pinned:
    - `features.shell_tool=false`: shell off
    - `web_search="disabled"`
    - `sandbox_mode="read-only"`
    - `mcp_servers.dool2`: `required=true`, so startup fails if the Dool2 tools are missing
  - We must check in practice whether the file-editing tool is turned off along with these (unconfirmed).
  - Protocol types are generated with `codex app-server generate-ts` at a pinned version and committed. The app-server is officially "experimental" and changes between versions.
- Conversations use `thread/start`, `thread/resume`, `turn/start` and `turn/interrupt`. When the token is refreshed, we restart the app-server and continue with `thread/resume`.
- Limit: on a 429 `subscription_sharing_usage_limit_exceeded`, we stop and show "ChatGPT usage is used up" on the phone.
- Windows: runs natively (no WSL needed). Because the shell is off, the Windows sandbox has little effect.

## 4. Approval gate (security core)

### 4.1 Tiers

| Tier | Examples | Handling |
|---|---|---|
| `lookup` | search, look up, screenshot | runs immediately |
| `fill` | add to cart, fill a form, save a draft | runs immediately, recorded |
| `pay` | payment, confirming a booking, a cancellation that incurs a fee | **phone signature required** |
| `contact` | sending a message or email, posting a review or post, phone calls | **phone signature required** |

### 4.2 Layers of blocking
1. **Remove the detours**: turn off the agent's shell, file and web tools (chapter 3). The only thing the agent can do is call Dool2 tools.
2. **Tier per tool**: a tool with a clear tier, like `send_message`, has its tier hard-coded.
3. **Classifying general browser actions**: for tools like `browser_click`, where the tier varies with the action, dool2d judges separately right before execution.
   - The role and text of the element to click: payment, purchase, place order (주문하기), confirm booking, send, post, etc.
   - Risky steps written in the skill
   - Current URL pattern: order form, payment page
   - The intent the agent states itself

   If **any one of these is risky, the action is treated as risky.** It does not change if the agent says "this is just a lookup".
4. **Network guard**: requests going out to payment gateway or easy-pay domains, and form submissions on risky pages, are blocked with Playwright request interception. They pass only with a valid approval.
5. **Last safety net**: most real payments go through one more approval in a payment app such as Naver Pay or Kakao Pay. Dool2 does not handle payment passwords or card numbers.

Classification cannot be perfect. The threat model document states honestly what can slip through.

### 4.3 Approval signature
- dool2d normalizes the approval request: `{what, where, how much, cancellation terms, page URL, screen capture hash, nonce, expiry time}`. Its hash becomes the thing to be signed (the challenge).
- The phone shows the request and the screen capture, and the user signs with biometrics.
- **dool2d verifies the signature itself, using the public key registered at pairing.** Once verified, it creates a one-time approval token used for that one action only. No server takes part in this process.
- The signing method goes in stages.
  - **Stage 1: PWA + passkey (WebAuthn)**: the PC verifies `clientDataJSON` (challenge, origin), `authenticatorData` (RP ID hash, user verification flag) and the signature. The RP ID is the official app domain, or the person's own domain when self-hosting.
  - **Stage 2: native app**: signs with a non-exportable key created in the iOS Secure Enclave or Android StrongBox. The key can be used only with biometrics.
- **Difference from the landing page wording**: a stage 1 passkey is a key synced through an iCloud or Google account. Strictly speaking, "a key in the phone's security chip" is accurate only from stage 2. We will either fix the landing wording or consider using the native app for `pay` signatures from the start (chapter 9, decision 3).

## 5. Dool2's hands: browser and PC control

Dool2 operates the user's PC remotely on their behalf. Some services do the same work in a **cloud browser on the service company's server**, but that triggers foreign or data-center IP login warnings and cannot do anything outside the browser. Dool2 works on the **user's real PC**. It can handle the home IP and programs that are already installed (KakaoTalk PC, Hangul, Excel, certificate and bank security programs).

### 5.0 Use the most precise method first

| Order | Method | Used for | Works with the screen locked? |
|---|---|---|---|
| 1 | Official integration (IMAP, calendar API, etc.) | mail, calendar | Yes |
| 2 | Browser control (CDP, 5.1) | most web services | Yes (an off-screen window) |
| 3 | PC screen control (5.2) | things that exist only as apps: KakaoTalk PC, Hangul and Excel, certificate and security program windows, file organizing | **No**: the screen must be on and unlocked |

We write this order into the agent instructions. Screen control is the slowest and makes the most mistakes, so it is used only when there is no other way. This is the same principle that Claude Code applies to its own computer use.

### 5.0.1 The agents' built-in features cannot be used → Dool2 builds its own

- Claude Code's built-in computer use **cannot be used in `-p` (headless)** and on the CLI it is Mac-only. Its browser access is also at a "view only" tier.
- Codex's computer use is a plugin of the Codex desktop app, and on Windows it runs only in the foreground.
- So Dool2 **builds its own browser tools and screen control tools and provides them over MCP.** This way it behaves the same with Claude or Codex, on Mac or Windows, and the approval gate is applied in one place.

## 5.1 Browser

**Top principle: we must not get blocked in the browser.** Dool2 is not a commercial crawler. It is a **personal assistant that works for the user, with the user's own account, on the user's own PC.** So the site should also see "the browser that person normally uses". The surest way is **to really use the browser that person normally uses.**

### Approach: the user's browser + the Dool2 extension

```
User's Chrome / Edge / Whale / Brave …  (usual profile, usual logins as they are)
   └─ Dool2 extension (installed from the web store, one click)
        └─ native messaging ──▶ dool2d (approval gate · skills · records)
```

- We install the **Dool2 extension** in the browser the user normally uses. The extension talks to dool2d through native messaging.
  - It does not open a remote debugging port. So it is not affected by Chrome 136's "remote debugging is disabled on the default profile".
  - Other products from AI companies use the same approach: an extension plus native messaging, supporting Chrome, Edge, Brave, Arc, Vivaldi and Opera.
- **It uses the usual logins as they are.** If the user is already logged in to Naver or Coupang, there is no need to log in again. The landing page's "uses your usual logins as they are" becomes simply true.
- **It gets blocked least.** What the site sees is the person's real browser. The real cookies, history, extensions and home IP are all there.
- **Input goes in as real input.** Clicks and typing are sent with `chrome.debugger` (CDP `Input.dispatch*`), so the browser treats them as real user input. Clicks faked by page scripts can be told apart by sites, so we do not use them.
  - While `chrome.debugger` is attached, a "Dool2 is controlling this browser" bar shows at the top of the browser. The bar is visible only to the user, not to the site. We attach it only while working and detach it when done.
- **AI work is grouped separately.** Tabs that Dool2 opens are gathered in a "Dool2" tab group (color-marked) or a separate window. The user's own tabs are not touched without approval.
- **Remote view** (6.4): `chrome.debugger`'s `Page.startScreencast` sends only that tab's screen to the phone.
- The AI cursor and the "what I'm doing now" indicator show in two places.
  - The extension side panel and the toolbar badge
  - A transparent window of the Dool2 app laid over the tab. It does not touch the page's code.

**What we do not use**: a Chromium fork (we cannot keep up with security patches alone), and dedicated AI browsers from others (the core is closed or tied to one OS, and the user would have to switch browsers).

### Browser: unified on Chrome (Dool2 installs it if missing)

**Decision (2026-11-14): the officially supported browser is Chrome only.** If it is missing, Dool2 installs it.
- Skill verification, the block map, store review and customer support can focus on one browser. Most Korean PC users already use Chrome.
- Edge, Whale and Brave will probably work with the same extension, but we label them "beta" only and do not guarantee them separately.

| Situation | Handling |
|---|---|
| Chrome is present | Connect the extension to that Chrome |
| No Chrome (Mac, Windows) | Say "Dool2 works in Chrome. I'll install it now", then **download the official Google installer and install it for the user.** We verify the signature before installing, and install in the user's location with no admin rights. We do not change the default browser |
| Company policy blocks Chrome or extension installs | Go to dedicated-browser mode (below), or tell the user it is not supported |

**Installing the extension (one user click)**
- Dool2 places the Dool2 extension in Chrome's "external extensions" registration location. On Mac it is the `External Extensions` folder, on Windows it is the user registry, and it uses the web store update URL.
- Chrome then shows "New extension added · [Enable]", and the user only has to click once.
- In environments where this does not work, we open the web store page and have the user press [Add to Chrome]. Either way it is one click.
- On a consumer PC there is no way to install an extension without a user click. Chrome blocks that on purpose.

### Dedicated-browser mode (optional)

This is a mode for users who are uneasy about the AI using their usual browser.
- Install the extension in a **separate "Dool2" profile of the same browser.** It is real Chrome as is, and the user only needs to log in separately once. This is the most recommended alternative.
- Only in environments where extension installs are blocked, Dool2 runs Chrome normally with a separate data folder and attaches with CDP. Even then, we leave no automation marker (`--enable-automation`).

**Considered and removed from the default plan: our own Chromium + importing logins from the existing browser**
- Mac: if the user allows reading the "Chrome Safe Storage" key in the keychain, cookies can be decrypted and moved. This does work.
- Windows: because of Chrome 127+ App-Bound Encryption, other programs cannot normally unlock the cookie key. Getting around it uses the same techniques as info-stealing malware, so antivirus flags it. It is **practically impossible.**
- Moved cookies work less and less.
  - Chrome's Device Bound Session Credentials (DBSC) tie the session to that device and that browser, starting with Google login.
  - Korean sites may also see it as a new environment and show a "new device login" alert or ask for re-authentication (needs checking per site).
- It is a one-time copy, so afterwards the login state drifts apart from the original browser.
- A "program that reads the browser's cookie key" does not fit Dool2's trust, which rests on security.

→ We will consider it later only as an **optional feature** for Mac users who want "complete separation from my usual browser". The default is the extension approach.

### Things to watch

- **If the user is using the browser at the PC**, Dool2 works in a separate window. If the user touches that window, Dool2 stops and asks "Shall I continue what I was doing?"
- **Extension permissions are broad** (read and control all sites). So the extension stays a thin hand that decides nothing. Judgment and the approval gate live only in dool2d. The extension code is public, and we make it possible to verify that the store build matches the public code.
- **The extension's service worker is cut off when idle.** We keep it awake with the native messaging connection, and dool2d reconnects if it drops. Other extension-based products document the same problem.
- **Store review**: we must pass the Chrome Web Store, Edge Add-ons and Whale Store reviews. In case review is delayed, we also keep developer-mode install instructions in the docs.

### 5.1.1 Not getting blocked: design principles

Dool2's advantages are already settled: home IP, a real PC, real Chrome, the person's own account. The key is not to ruin these advantages.

| Principle | In practice |
|---|---|
| One person, one browser | Keep using one profile. Cookies and history build up as usual. Do not create a new profile for each task |
| Human speed | Leave human-like gaps between typing and clicks. Scroll to look, then click. Do not open several tabs on the same site at once |
| Repeated lookups go slowly | For repeated lookups such as watching for cancellations, write a minimum interval per service in the skill and obey it (default 1 minute or more) |
| Minimize automation traces | Do not turn on CDP features that are not needed. Do not inject scripts into the page. Test regularly with the main bot-detection check pages |
| Keep logins | A person logs in once and the session is kept for a long time. Dool2 does not log in repeatedly (repeated logins are the most common reason for suspicion) |
| Stop when blocked | When a CAPTCHA, a block or an "abnormal access" screen appears, stop immediately and hand off to the person (6.4). Do not keep hitting it |
| What we do not do | We do not use CAPTCHA-solving services, browser fingerprint spoofing, or IP changes through proxies. They carry a high risk of account suspension and throw away our own advantage of being "the browser the person uses" |

**We maintain a "block map" for each skill**
- Per site, we record in the skill doc where CAPTCHAs appear, how many lookups lead to a block, and how many days a login lasts.
- If the user agrees, we send only anonymous success, failure and block statistics. We do not send content or account information.
- If blocks increase in the statistics, we fix that skill first. This is how we keep the Korea-focused harness alive.
- We implement the tools ourselves but refer to the approach of Playwright MCP (Apache-2.0): number the elements in an accessibility snapshot, and click by that number.
  - Tool list: `browser_open / snapshot / click / fill / select / press / scroll / wait / tabs / screenshot`
  - For screens that a snapshot cannot capture, such as seat maps or calendars, we assist with screenshots and coordinates.
- **Login, identity verification and CAPTCHAs are done by the person.**
  - When at the PC, they can do it right in the Dool2 browser window.
  - When away, we hand off through remote view (6.4).
  - We do not try to get around them.
- We keep only one profile by default (sharing logins like a normal browser). Per-service separation is an option. One profile can be used by only one Chrome at a time, so tasks on the same profile are processed in order.
- (Later, advanced option) Attaching to the usual Chrome with Chrome 144+ auto-connect. The user turns it on themselves and must allow it each time it connects.

## 5.2 PC screen control (desktop app)

**Structure**: a small helper program per OS (`dool2-hands`). On Mac it is Swift (`apps/hands-mac`), and on Windows we build a separate UI Automation helper ([ADR 0013](decisions/0013-hands-mac-swift.md)). It is signed and bundled in the app, and dool2d launches it as a child process and calls it with one-line JSON.

| Function | Mac | Windows |
|---|---|---|
| Seeing the screen | ScreenCaptureKit | Windows.Graphics.Capture |
| Reading UI structure | Accessibility API (AXUIElement) | UI Automation |
| Mouse and keyboard | CGEvent | SendInput |
| Opening apps, arranging windows | NSWorkspace | Shell / Win32 |

**Tools**: `screen_status`, `screen_apps` (find running and installed apps), `screen_open`, `screen_read` (accessibility tree + element numbers), `screen_click`, `screen_type` (Korean is entered by pasting), `screen_key`, `screen_screenshot` (a reduced image), `screen_request_app` (ask to allow an app used for the first time), `screen_request_approval` (send, pay, delete, messenger Enter).
- Like the browser, **read the UI structure first**, and use screenshots and coordinates only for screens where no structure can be captured.
- We refer to open-source implementations that use the accessibility tree. Whether we can take any of them as is will be decided after checking the license.

**Safety measures**
- **App allow list**: only apps the user has allowed are operated. When an app comes up for the first time, we ask on the phone: "May I operate KakaoTalk?"
- **Apps blocked by default**: terminal, system settings, file manager (Finder, Explorer), password manager. Otherwise turning off the shell would be pointless. The user can turn them on, but a large warning is shown.
- **The browser is not handled by screen control.** Browser work uses only the 5.1 tools. This keeps the network guard and the gate from being bypassed.
- **Tier judgment**
  - Pressing the send button or Enter in KakaoTalk, deleting files, and transfer or confirm buttons in a bank app count as `contact` or `pay`. App-specific rules are written in the skill, and buttons of an unknown app that look like "send, confirm, delete" are treated as risky.
  - A screen capture from right before the risky action is attached to the approval request.
- **People can step in**: during screen control, a "Dool2 is using the PC · Esc to stop" indicator shows on the PC screen. If the user moves the mouse, Dool2 stops immediately and tells the phone.
- **Secure screens are not touched**: the Windows UAC window, the Mac password prompt, and the joint certificate (공동인증서) password input are handed to the person.

**Practical limits (told to the user in advance)**
- **Screen control stops when the screen is locked.** On both Mac and Windows, you cannot see or click other apps on the lock screen. Browser work (5.1) and official integrations continue.
  - When a request needs app work, the phone shows "Please unlock your PC".
  - We do not recommend "turn off auto-lock". A home PC left on with no lock is itself a risk. We mention it as an option only to users with a lot of app work.
- **Mac permissions**: the user must turn on the "Accessibility" and "Screen Recording" permissions themselves, once. The app cannot turn them on for them. The first-run setup wizard guides them with pictures and an [Open Settings] button. Windows has no permission to turn on separately.
- **On Windows the screen is shared**: while Dool2 is operating, the user cannot do other things on the same screen. If the user is at the PC, we ask before starting app work.

## 6. Phone ↔ PC connection

**Principle: only a paired phone can make requests to this PC.** Neither the relay, nor the Dool2 team, nor another device on the same Wi-Fi can connect. The PC accepts only messages signed with the public key of the phone registered at pairing, and discards everything else without even opening it.

### 6.1 Pairing
1. The PC settings screen shows a QR code. The QR contains the PC public key (X25519), the relay address, a one-time pairing secret, and the PC id.
2. The phone scans the QR and creates its own key pair. It sends a pairing request containing the one-time secret, encrypted with the PC public key. The two sides each derive a 6-digit confirmation code from the same shared secret, and a person compares them. The relay cannot see the content of this process.
3. In the same place, it registers a passkey (or a native signing key). The PC stores that public key.
4. If a family shares it, several phones are registered, and permissions are set per phone (for example, `pay` approvals only from the owner's phone).

A new phone can be added in only one of two ways.
- Scan the QR directly at the PC. The PC screen shows "Connect a new phone? Confirmation code 4821", and it finishes only when the person checks that the phone shows the same code and clicks on the PC.
- An already connected phone approves it with a signature.

There is no other way. This keeps anyone from secretly attaching a new device remotely.

If a phone is lost
- The phone can be revoked right away from the PC.
- To revoke it from another phone, a signature from a remaining phone is needed.

Honest limit: if someone sits at an unlocked PC, they can attach a new phone. So when a new phone is connected, we send a notification to the existing phone. If wanted, a PC-side PIN can be required.

### 6.2 Encryption
- We use only the browser and Node built-in cryptography (WebCrypto): X25519 → HKDF-SHA256 → AES-256-GCM, and Ed25519 for approval signatures ([ADR 0012](decisions/0012-phone-link.md)). This replaces libsodium and Noise from the first draft. The ADR notes the lack of forward secrecy.
- All the relay can know is the device id, message size and time.
- The protocol is in `packages/protocol` and published as `docs/protocol.md`. A version field lets the phone and PC negotiate even when their versions differ.

### 6.3 Relay
- Built with **Cloudflare Workers + Durable Objects**. Each paired group (one PC and its phones) gets one Durable Object.
  - It uses WebSocket Hibernation. The connection is kept, but nothing is billed while there are no messages.
  - Requests for a PC that is off are stored as ciphertext in the Durable Object's SQLite. They are kept 7 days by default and then deleted. When the PC comes on, it receives and processes them. This is the landing page's promise of "handled when it turns on".
  - The cost is about $0.15 per million requests and $0.20 per GB-month of storage. We expect a few won or less per user per month (needs measurement).
- Push
  - The PWA gets Web Push. On iOS it works only if the app was added to the Home Screen.
  - Native uses APNs and FCM.
  - Push bodies contain no content ("Dool2 needs you to check something").
- Self-hosting: we also provide a Node version (Docker image) that uses the same protocol.

### 6.4 The person's turn: handing off CAPTCHAs, identity verification and login

Dool2 does not do CAPTCHAs, identity verification or login for the user. **It shows the browser screen to the user and points out what to do.**

**Flow**
1. **Notice**: Dool2 stops immediately when it hits one of these.
   - A signal written in the skill (for example Naver's "자동입력 방지" (automatic input prevention), SRT's security text (보안문자))
   - General signals: a reCAPTCHA or hCaptcha frame, "비정상적인 접근" ("abnormal access"), being bounced to the login screen, an identity verification popup
2. **Alert**: send a push to the phone. "Coupang needs your check · Takes 10 seconds"
3. **Show**: when the user taps it on the phone, a live view of that tab opens.
   - One line of guidance shows at the top. For example: "Select all the traffic lights in the picture below and tap [Confirm]", "Finish verifying in the PASS app and come back"
   - The place to act is highlighted with an outline.
   - There are zoom, keyboard and paste buttons.
4. **Confirm it is done**: when the screen moves to the next step, Dool2 notices and shows "I'll continue". The user can also tap [Done].
5. **When at the PC**: instead of the phone, the Dool2 browser window is brought to the front of the PC screen, with the same guidance overlaid.
6. **When there is no response**: if there is no answer after the set time (10 minutes by default), the task pauses and stays in the task list as "Waiting for your check". For time-limited things such as a payment deadline, we warn in advance.

Identity verification (PASS, Kakao certificate, text message) is mostly finished on the phone. Dool2 only says "Please finish verification on your phone" and waits. When a code arrives by text message, the user types it into the remote view themselves. Dool2 does not read the text message and enter it for them.

**Remote view technology**
- It is turned on only when this feature is needed. The screen is received as JPEG frames with CDP `Page.startScreencast` and sent on, and touch and key input go in with `Input.dispatch*`. Korean is entered with `Input.insertText`.
- It is video, so traffic is high. At first it goes through the relay at low quality and frame rate. Later we switch to WebRTC P2P, and the relay handles only the connection signaling.
- Limits: payment popups, new windows and native dialogs must be attached separately. Bank security keypads may block remote input.

### 6.5 How Dool2 is different

The basic feature of "ask from your phone and your PC does the work" is appearing in many places. Dool2 does not compete on "remote chat" or "PC control" themselves. Dool2 is different in these ways.
1. `pay` and `contact` are blocked by a **phone signature that the PC checks directly.**
2. Conversations stay only on my PC with **end-to-end encryption**, not as records on a service company's server. This differs from remote features that use only transport encryption (TLS).
3. It has **Korean service skills**: SRT, CatchTable, Coupang, Hometax, KakaoTalk PC and more.
4. It uses **either subscription**, Claude or ChatGPT.
5. It is **screens and installation for ordinary people**, not a developer tool.

These five should be the center of the landing page message.

## 7. Desktop app

- We use **Electron**. Tauri makes a smaller installer, but because of Playwright it would still bring a Node sidecar and a browser, so there is almost no size advantage. It only adds complexity, such as updating the sidecar.
- Staying resident and power: 7.1
- Records and keys
  - Records are in `<app data>/dool2.db` (SQLite).
  - The pairing key, the Codex token and the DB encryption key are in the OS keychain (`safeStorage`).
  - Per-step screen captures are saved as files with a set retention period.
- Updates
  - App: we use electron-updater. The source is GitHub Releases, and only signed updates are installed.
  - Skills: received as a signed bundle separate from the app. They take effect only after approval on the phone.
- Code signing
  - Mac: sign and notarize with the Apple Developer Program ($99 per year).
  - Windows: Microsoft Artifact Signing cannot be signed up for in Korea. Instead, buy an OV code signing certificate ($150 to $500 per year), or apply for free open-source signing such as the SignPath Foundation (conditions not confirmed).
  - Without signing, a SmartScreen warning appears and ordinary users find it hard to install.

### 7.1 Always awake: "When the PC is off, Dool2 rests too"

If the PC sleeps or is off, Dool2 cannot work either. So **we ask the user during installation and change only the settings they allow.** We do not change anything secretly, and everything can be reverted at any time in settings.

**The "Keep Dool2 from resting" step in the first-run setup wizard**
```
When your PC sleeps, Dool2 rests for a while. It will continue your tasks when the PC wakes up.

[✓] Keep the PC from sleeping while Dool2 works        (the screen can still turn off)
[✓] Start Dool2 automatically when the PC starts
[ ] Mac: turn the PC back on when power returns after an outage   (admin password once)
[ ] Laptop: keep working with the lid closed while plugged in

                                   [Do this]  [Later]
```

| Setting | How | Admin rights | Notes |
|---|---|---|---|
| Do not sleep while working | Mac power assertion, Windows `SetThreadExecutionState` (Electron `powerSaveBlocker`) | Not needed | On by default. The screen turns off and only the system stays awake. When there are no tasks or watches, we release it so it does not get in the way of normal power saving. "Always stay awake" is also an option |
| Start Dool2 when the PC starts | Mac login item, Windows user startup program | Not needed | On by default |
| Power on after an outage (Mac) | `pmset autorestart` | Needed (one password prompt) | Optional. For desktop Macs and Mac minis |
| Keep working with the lid closed (laptop) | Mac: the OS allows it only when power and an external display are connected. Windows: the lid action in power options | Windows: needs checking | Optional. On Mac we only explain the conditions |
| Windows update restarts | Guide to the "active hours" setting | — | After a restart, we recover with the flow below 7.1 |

**What we do not change**
- Screen lock, auto-login, and FileVault and BitLocker are not touched, because those settings lower security.
- The price is that after a reboot, Dool2 does not start until the user logs in. We tell the user this honestly.

**State shown on the phone**

| State | Phone screen | When the user makes a request |
|---|---|---|
| Awake | "PC connected" (green) | Handled right away |
| Resting (sleeping or off) | "Your PC is resting · Last connected 3:12 PM" | Held as "I'll do it when your PC wakes up" (the relay mailbox, 6.3). When it returns, a push says "Your PC is back, starting your task" |
| Disconnected for long (6 hours or more by default) | "Your PC needs to connect" + what to check: power, internet, whether you logged in after a reboot | Held, but for time-limited tasks (such as bookings) we warn in advance: "It may not happen in time" |
| Screen locked | "I can do browser work · App work needs your PC unlocked" | Browser and integration work is handled, and only app work waits |

- PC state is judged from the "last connected time" the relay knows and the encrypted status signals the PC sends.
- Right before the PC goes to sleep, it sends a "going to sleep" signal. This lets the phone tell a breakdown from a rest.

## 8. Installation and setup: anyone, no terminal

**Goal**: run the installer once and press a few buttons, and you are done. Words like terminal, admin rights, reboot and "container" are never shown to the user. **This is the most important experience in Dool2.**

### 8.0 One-touch install: the user touches it five times

| # | What the user does | What Dool2 does for the rest |
|---|---|---|
| 1 | On dool2.com, press **[Download]** → run the downloaded file | Picks the OS automatically. On Windows it installs and runs right away with no install screen (user location, no admin rights). On Mac, when run, it shows "Move to the Applications folder?" and moves itself |
| 2 | Press **[Get started]** once | Automatically goes in order: check and install Chrome, install Claude Code or prepare Codex, power settings (with a consent screen), register the extension. Only the progress is shown |
| 3 | AI login: press **[Approve]** in the official login window in the browser | If already logged in to Claude or ChatGPT, one button finishes it |
| 4 | Press **[Enable extension]** once in Chrome | When connected, a green light comes on |
| 5 | **Scan the QR** with the phone → Face ID or fingerprint | Does phone pairing and registering the approval key in one go |

**What is postponed (not asked at first install)**
- Mac "Accessibility and Screen Recording" permissions: asked when the user first requests PC app work (5.2).
- Service logins: with the extension approach, usual logins are used as they are. Only services that are not logged in are handled then, through handing off (6.4).

**What blocks installation, and the response**

| Blocker | Response |
|---|---|
| Windows SmartScreen "unknown publisher" | Code signing is required. Prepare a signing certificate before the first release (chapter 7). Warnings may appear early on, before reputation builds up, so the download page includes a picture guide for [More info] → [Run anyway] |
| Mac "unidentified developer" | Does not appear once Apple notarization is done |
| User opened dool2.com on a phone | Show "Dool2 installs on a PC" and offer [Send link to PC] (KakaoTalk "send to me", email). Waitlist signups get the install link by email |
| Internet drops during install | Downloads resume step by step. On failure, one [Try again] restarts from that step |

### 8.1 Why we do not use containers

The appeal of a container is that "everything needed is inside and it is isolated". But on Mac and Windows it is a heavy burden for the user.

| | Container (Docker, etc.) | All-in-one app (adopted) |
|---|---|---|
| Install | A container runtime is needed first. Mac needs a Linux VM, Windows needs WSL2, and admin rights, a reboot or a BIOS virtualization setting may be involved | One installer. No admin rights needed |
| Size and resources | The VM image is GBs and uses memory all the time | A few hundred MB |
| Browser | Linux Chrome runs inside the VM. Seeing the screen needs a separate remote view, and bot detection catches it more | The real Chrome on my PC. To log in, you just look at the window |
| AI login | The OAuth browser flow gets tangled inside the VM | The official login flow opens as is in the default browser |
| Phone key and keychain | The OS keychain cannot be used inside the VM | Uses the OS keychain |

**So we get the benefits of containers without containers.**
- **Everything inside**: Dool2 downloads the needed parts itself and puts them in a Dool2-only folder (8.2).
- **Isolation**: turn off the agent's shell, files and web and let it use only Dool2 tools. The working folder is also confined to a Dool2-only folder (chapters 3 and 4).
- **Heals itself when broken**: check the state of the parts regularly, and when a problem comes up, one "Fix" button downloads them again (8.4).

Containers are provided only for the **Dool2 Box (Linux) and for developers who host it themselves.** We provide Docker images of dool2d and the relay.

### 8.2 Parts Dool2 prepares by itself

| Part | If missing | Where | Notes |
|---|---|---|---|
| Node runtime | Not needed | Included in Electron | dool2d runs on Electron's Node |
| Codex | Included in the installer | Inside the app | Apache-2.0, so it can be shipped together. Pinned to a verified version |
| Claude Code | **Dool2 runs the official installer for the user** | Official default location (`~/.local/bin/claude`) | Its proprietary license means we cannot put it in the Dool2 installer. Getting it from the official path also keeps the "unmodified official binary" condition. Claude Code updates itself |
| Browser | Use the user's own Chrome, Edge, Whale, etc. as is. Windows always has Edge. If a Mac has only Safari, install the official Google Chrome installer for them | Browser default location (`~/Applications` on Mac) | No admin rights needed |
| Dool2 extension | The wizard opens the web store page. The user clicks [Add] once | Inside the browser | Dool2 writes the native messaging registration file to the user folder |

- All downloads are installed in the user folder with **user rights**. No admin rights window appears. The native Windows install of Claude Code also needs no admin rights. Git Bash is not needed either.
- A downloaded file is run only after checking the official source and its signature and checksum.
- If the user already uses Claude Code, we use that as is. If already logged in, we skip login.

### 8.3 First-run wizard

```
① Run the installer (Windows: double-click to install and run right away / Mac: run → auto-move to the Applications folder)
② "Which AI subscription do you use?"
     [ Claude ]  [ ChatGPT ]  [ Both ]  [ I don't have one yet → subscription guide ]
③ "Keep Dool2 from resting" consent screen (7.1) → [Do this]
④ [Get started] → automatic preparation (the checklist turns green one by one)
     ✓ Check Chrome ................. install from the official Google installer if missing
     ✓ Install Claude Code ............ running the official installer (progress shown)
     ◻ Claude login  [Log in] → Anthropic's official login window in the default browser
     ◻ Dool2 extension → press [Enable] shown in Chrome
     ✓ Power settings applied
     ✓ Test request "Hi?" → got a reply, 3% used this week
⑤ Connect phone: scan the QR → register the approval key with Face ID/fingerprint on the phone
⑥ Done — "Now try making a request from your phone"
```

- **Claude login**: Dool2 runs `claude auth login` in an invisible terminal (node-pty), and Anthropic's official login window opens in the default browser. When the user finishes logging in there, we confirm with `claude auth status`.
  - The user never sees a terminal.
  - Dool2 neither sees nor stores the token. The login information stays where Claude Code keeps it (Mac keychain, Windows `~/.claude`).
- **ChatGPT login**: pressing "Continue with ChatGPT" opens OpenAI's official login window in the browser, and when it finishes, control returns right away.
- **Keep Dool2 from resting**: we ask about power settings and change only what is allowed (7.1).
- **Mac permissions** (Accessibility, Screen Recording) are not asked here. They are asked with a picture guide and [Open Settings] when PC app work is first requested.

### 8.4 Keeping it running well (self-check)

- **Dool2 diagnostics screen**: shows the state of each part as a traffic light (AI install, login and version, browser, relay connection, phone connection, free disk space). A red light has a **[Fix]** button next to it.
- It checks regularly, and right before handling a request.
  - If Claude Code was updated and its flags changed, Dool2 runs in compatibility mode and tells the user.
  - If the login has expired, it sends "Claude login is needed on your PC" to the phone.
- **Export a diagnostics bundle** for support requests: it holds only versions and error logs. It does not include chat content or personal information.

### 8.5 Cases where a problem cannot be solved without a terminal (honest limits)

- When a management policy blocks install or running, as on a company PC
- When antivirus blocks the Claude Code or Codex binary: we show how to add an exception
- Very old OS: below Windows 10 1809, or a macOS that is no longer supported

## 9. Key decisions

Decisions that are settled are moved to the [decision records (ADR)](decisions/README.md) and managed with their reasons. The table below is a full summary.

| # | Question | Recommendation |
|---|---|---|
| 1 | How to integrate Claude | Run the official `claude -p` the user installed + API key mode alongside + ask Anthropic in advance |
| 2 | Codex login method | The official SIWC flow (Dool2 handles login, Codex binary bundled). The alternative is reusing the user's `codex login`, but its official basis is weak |
| 3 | Form of the phone app at the start | Start with a PWA and validate fast. But to keep the "security chip" promise for `pay` signatures, bring native (Expo) forward early. Adjust the landing wording too |
| 4 | PC app framework | Electron (confirmed 2026-11-14) |
| 4-1 | Install method | All-in-one app with no containers. Codex is bundled, and Dool2 downloads Claude Code and the browser through official paths. Docker only for the Dool2 Box and self-hosting (chapter 8) |
| 5 | Agent | **Support both Claude Code and Codex** (confirmed 2026-11-14). Connect both from the start through the common interface |
| 5-1 | Skill license | **CC BY-SA 4.0** (confirmed 2026-11-14, open-source.md 3.5) |
| 5-2 | Browser | The user's Chrome + the Dool2 extension (5.1). **Unified on Chrome, and Dool2 installs it if missing** (confirmed 2026-11-14) |
| 6 | Landing wording | Keep "your usual logins as they are", since it becomes true with the extension approach. "Turn off sleep" → Dool2 sets it with consent at install (7.1) |

## 10. Phased plan (rough)

**Ordering principle (confirmed 2026-11-14): build the PC side all the way first, and build the phone app (the client) last.** Until the phone connects, the PC app screen stands in for the phone. Requests are made in the PC window, and approvals are taken on the PC screen. The phone joins later with the same protocol.

| Stage | Content | Done when |
|---|---|---|
| M0 Skeleton ✅ | Monorepo, CI, `protocol`, `store`, `engine`, Claude and Codex adapters, chat in the PC window, persona | A request in the PC window gets an answer from the chosen AI using only Dool2 tools, and a record is kept |
| M1 Install and first setup | First-run wizard, Claude login button (invisible terminal), automatic Claude Code install, Chrome check and install, power setting consent, tray residency and auto-start, self-check and [Fix] | On a clean Mac: run the installer → a few buttons → the first request succeeds |
| M1+ Pay-as-you-go mode | OpenCode (API key) with Claude, OpenAI, Google, OpenRouter and local models, spend display and monthly limit ([ADR 0010](decisions/0010-pay-as-you-go-opencode.md)) | The first request succeeds with only an API key and no subscription, and the cost of this chat is shown on screen |
| M2 Browser hand | Dool2 Chrome extension + native messaging, browser tools, handing off (PC screen), first skills (mostly lookups), Dool2 vault login filling ([ADR 0011](decisions/0011-login-vault.md)) | A lookup on a real Korean site succeeds with the usual login as is, and when a CAPTCHA appears it stops and hands off to the person |
| M3 Approval gate | Risk classification, per-task permission levels (read-only, protected, full) and a final confirmation switch, network guard, approval on the PC screen (replaced by phone signature later), gate regression test | That no payment button is pressed without approval is fixed by a test, and one real booking succeeds |
| M4 PC screen control and more skills | `hands` helper (Mac → Windows), app allow list, port and verify the existing skills, block map | Sending a message through KakaoTalk PC (after approval), main skills "verified" |
| M5 Release | Windows build, code signing and notarization, auto-update, one-touch installer, Codex Sign in with ChatGPT | Download from dool2.com and install on Mac and Windows with no warnings |
| M6 Phone (last) | Relay, pairing (QR), phone app, biometric signing, push, mailbox for an off PC, remote view | Request from outside with the phone → sign → booking done. Private beta starts |

## 11. Risks

| Risk | Response |
|---|---|
| A change in Anthropic's subscription policy blocks use of `claude -p` | Keep the principle of running the official binary unmodified. Keep API key mode and Codex as alternatives. Ask in advance |
| app-server protocol changes | Pin the Codex version, generate types and commit them, run compatibility tests before updating |
| Bot detection and CAPTCHAs | Real Chrome with a visible window, human-like speed. When blocked, hand off to the person and do not get around it |
| Missed classification of a risky action | Layer the network guard and the second approval in the payment app. Disclosed in the threat model |
| Malware on the PC | State clearly that this is beyond what Dool2 can block. Keys are kept in the OS keychain |
| The official PWA is tampered with (a fake approval screen) | What is signed is a hash made by the PC, so the content cannot be swapped. But the risk of deceiving the displayed screen remains. So we prioritize moving `pay` to the native app |
| Windows signing cost and process | Budget for an OV certificate, or apply for free open-source signing |

## 12. Sources (checked 2026-11-14)

- Claude Code legal notice (authentication and credential use): https://code.claude.com/docs/en/legal-and-compliance
- Claude Code headless and CLI: https://code.claude.com/docs/en/headless , https://code.claude.com/docs/en/cli-reference
- Agent SDK overview (third-party login wording): https://code.claude.com/docs/en/agent-sdk/overview
- Sign in with ChatGPT (open-source apps): https://developers.openai.com/siwc/token-sharing-open-source.md
- SIWC + app-server: https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server.md
- Codex app-server: https://learn.chatgpt.com/docs/app-server.md
- Codex approvals and security: https://learn.chatgpt.com/docs/agent-approvals-security.md
- Chrome remote debugging change: https://developer.chrome.com/blog/remote-debugging-port
- Playwright MCP: https://github.com/microsoft/playwright-mcp
- Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- WebAuthn spec: https://www.w3.org/TR/webauthn-3/
- Windows code signing options: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
