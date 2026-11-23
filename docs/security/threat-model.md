# Threat model

This is an honest account of what Dool2 protects, what it blocks, and **what it cannot block**. We update it whenever a feature is added.

> Current stage: **M0 to M1 (early development)**. The "Status" column in the table below separates what is actually implemented from what is only planned. We do not describe plans as if they were implemented.

## 1. What we protect

| Asset | Description |
|---|---|
| The user's money | Payments, booking confirmations, cancellations that incur fees |
| The user's relationships | Sending messages, mail and posts in the user's name |
| Accounts and login state | Services logged in in the browser, AI subscriptions |
| Conversations and records | Request contents, what was done, screen captures, approval history |
| The user's PC | Files, installed programs |

## 2. Trust boundaries

```
[User] ─ phone (M6) ─ relay (M6, not trusted) ─┐
                                               ▼
[User's PC] ── Dool2 app and daemon dool2d (trusted) ── local API 127.0.0.1 + token
                  │
                  ├── agent (Claude Code / Codex): half trusted
                  │     └ AI judgment can be wrong and can be fooled by web page content
                  ├── Dool2 tools (MCP) → approval gate → browser and PC control
                  └── content of web pages and external apps: not trusted
```

Core assumption: **we do not trust the AI agent.** AI makes mistakes and can be fooled by instructions hidden in web pages (prompt injection). So safety is kept by code (tool restrictions and the approval gate), not by the AI's judgment.

## 3. Threats and responses

| # | Threat | Response | Status |
|---|---|---|---|
| T1 | The AI bypasses the gate through shell, file or web features | Turn off the agent's built-in tools and allow only Dool2 tools. Check the tool list at startup, and stop if a dangerous item is detected while running ([ADR 0003](../decisions/0003-dool2-tools-only.md)) | ✅ Implemented |
| T2 | A prompt injection in a web page attempts a payment or contact | The `pay` and `contact` tiers cannot run without user approval. Dool2, not the AI, decides the tier. Once approved, **the daemon, not the AI, presses just that one button**, and right before pressing it re-checks that the button text and URL match what was approved. Valid only once and only within 10 minutes. Because an amount written by the AI can be wrong, the approval card also shows an actual screen capture. The approval endpoint can only be called with the screen token | ✅ PC approval (phone signing is M6) |
| T3 | A generic click presses a payment button | Judge risk from the element text, URL and skill label right before the click; if any one is risky, it is risky. Block requests to payment domains. **The daemon looks at the button text (결제 "pay", 구매 "buy", 주문 "order", 보내기 "send", 삭제 "delete", etc.) and the checkout-step URL, and if it is risky the AI cannot press it; it can only request approval (T2) or hand off to a person.** Enter and form submission are also blocked on checkout-step pages. The [OK] button of a site's confirm dialog gets the same judgment from the dialog text (주문 "order", 예약 "booking", 결제 "payment", 보내기 "send", 삭제 "delete", etc.) and URL; if risky, approval is requested and the daemon presses only that dialog (re-checking that the dialog text is the same right before pressing). The extension closes alert dialogs immediately and only tells the AI the text. The extension refuses input into password fields | ✅ Implemented (network guard later) |
| T4 | Another program or web page calls the local API | Open only on 127.0.0.1, and require a token freshly generated on each run (constant-time comparison) | ✅ Implemented |
| T5 | Another program calls the Dool2 tools (MCP) directly | Each time the daemon starts, it creates a **tool-only token** different from the screen token and gives it only to the tool server. This token can call only `/api/tools/*` | ✅ Implemented |
| T6 | Leak of the Claude subscription credentials | Dool2 never reads or stores Claude login info or tokens. The login button launches the official `claude auth login` and only relays the pasted code to that program; the login output is discarded when it ends ([ADR 0002](../decisions/0002-official-agent-binaries.md)) | ✅ Implemented |
| T7 | Leak of conversation history | Records are stored only in SQLite on the user's PC. No remote transmission | ✅ Implemented |
| T7-1 | Work logs kept to find problems (connections, tools, one turn of replies, images of stalled screens) pile up or leak | Kept only in the data folder on the user's PC (`logs/`), with no remote transmission. Text logs are deleted after 7 days and screen images after 3 days; if the total exceeds 40 MB, the oldest are deleted first. IDs, passwords, verification codes and tool inputs (search terms, etc.) are not written; emails and long numbers mixed into text, values in fields, and everything after the question mark in URLs are masked. Readable only through the daemon API (`/api/logs`, screen token) (`apps/daemon/src/journal.ts`) | ✅ Implemented |
| T8 | Automatically bypassing CAPTCHAs or identity verification gets accounts suspended | We do not bypass; we hand the screen to a person (when the extension recognizes a CAPTCHA screen it tells the AI, and `browser_handoff` brings the Dool2 tab in front of the user; the app has a [Done] button). We do not accept bypass code or skills | ✅ Implemented |
| T9 | The relay peeks at or alters content | End-to-end encryption (X25519 → AES-256-GCM, with the header bound as AAD so altering it prevents decryption), sequence numbers block replays, and the PC verifies approvals directly with the phone's Ed25519 public key. No forward secrecy ([ADR 0012](../decisions/0012-phone-link.md)) | 🚧 M6 (encryption, pairing and signature verification implemented; phone app in progress) |
| T10 | A forged approval screen (what is shown differs from what is signed) | The signed target is the request hash made by the PC. For `pay`, native app signing comes first | 🗓 M6 |
| T11 | Tampered installers or updates | Build only in GitHub Actions, code signing and notarization, build provenance, install only signed updates | 🗓 M5 |
| T12 | Malicious skill contributions | Skills cannot turn off the gate. CI checks for tier labels and forbidden instructions, plus maintainer review | 🗓 M4 |
| T14 | A tampered file is installed during component setup | Claude Code is downloaded from the official distribution server (HTTPS), and the official `claude install` runs only if the manifest's SHA-256 and size match (manifest signature verification is not done yet). Codex is downloaded from the official npm registry and used only if it matches the **SHA-512 pinned in Dool2's code**; the pay-as-you-go runner is checked against `SHA256SUMS` of a pinned release. Chrome is downloaded from Google's official address and installed only after checking the code signature, team ID and Gatekeeper notarization on Mac, or the Authenticode signer (Google LLC) on Windows | ✅ Implemented |
| T13 | Dependency supply chain attacks | Pinned lock file, CI actions pinned to commits, dependency alerts, pinned Codex version | ✅ Partly |
| T15 | Login info saved in the vault is typed into the wrong site | The AI never receives the values; the daemon types into the password field directly, and only when the current address matches the saved site. Only the origin (https) of the site is stored, so look-alike addresses (`shop.example.phish.io`) are not filled. The daemon checks, and the extension checks once more right before filling. Filled fields read as "filled from the vault" (금고로 채워짐) instead of the value in page reads. The vault API is reachable only with the screen token and never returns passwords. The last-used time is recorded. Per-site "ask before filling" arrives in M3. Values received through an in-chat login card also go only to the vault without passing through the AI, and the site is determined only by the current address of the Dool2 tab (the AI cannot set it) ([ADR 0011](../decisions/0011-login-vault.md)) | ✅ Implemented |
| T17 | Another program connects to the browser bridge (local socket) and sends commands to the extension | Each time the daemon starts, it creates a new token and keeps it in a file only the user can read (0600); a connection that does not send the token as its first line is dropped. The socket file is also 0600. Chrome launches the host only for the Dool2 extension listed in `allowed_origins` of the registration file | ✅ Implemented |
| T18 | Phone notifications (web push) leak content, or the PC is made to call an unintended address | Notification content is encrypted per RFC 8291 so only the phone browser can decrypt it (the push service cannot read it either). Subscriptions are accepted only through an encrypted message from the paired phone, and sent only to https addresses of known push services. On a 410 response the subscription is deleted | ✅ Implemented |
| T19 | Remote screen used to spy on or control the user's tabs | Only tabs that Dool2 handed to a person (login and CAPTCHA hand-offs, tabs opened to connect a service from the phone), and only for 30 minutes after the hand-off, allow screen and input (checked separately by the daemon and the extension). The screen is ciphertext only the PC and phone can open, and the relay does not store it. Characters entered remotely are not kept in conversation history or given to the AI. The keys that can be pressed are limited to a few | ✅ Implemented |
| T20 | The AI uses PC apps to run shell, settings or files, or sends messages from instructions shown in an app screen (prompt injection) | Only apps the user has allowed (a first-time app needs approval). Terminal, system settings and Finder are blocked by default and allow requests are not even accepted. Browsers, password managers and Dool2 itself are refused even by the helper. Send, pay and delete buttons and Enter in messengers are re-read by the daemon after approval and pressed only if it is the same button. Password field values are neither read nor entered. Nothing is done while the screen is locked | ✅ Implemented (Mac) |
| T21 | The AI reads sensitive files with PC file tools and sends them out, or damages the user's files | File tools exist only as Dool2 tools (the built-in file tools stay off). Only real paths inside Desktop, Documents, Downloads, Pictures and Movies (refused if `../` or a shortcut leads outside); hidden files, joint certificates (NPKI), keys, certificates and password files are not read. Writing is only creating new files (a same-name file gets (2) added, never overwritten), and there is no delete. Move and rename stay within the same folder boundary, never overwrite (a same-name file gets (1)), and for 2 or more files approval is requested with a list made by the daemon, and a move can be undone from its record. Photo format conversion only creates new files. Printing always needs approval because paper comes out. PDF merge and split only create new files. For the trash, only find and restore (no emptying or permanent delete; 2 or more need approval). Downloads accept only https and outside-internet addresses (addresses of this PC or the home network, and addresses that redirect there, are refused to prevent SSRF), up to 2 GB; executables need approval before downloading, and downloaded files are marked "downloaded from the Internet". Screen lock and sleep come after approval; there is no power-off ([ADR 0024](../decisions/0024-pc-file-move-convert-print.md)). Because what is read goes to the AI company just like a web page, actions that send it out (send, pay) are blocked by the approval gate of T2 and T3. Uploading a file to a website (browser_upload) accepts only files inside the same fence, and the first time needs approval with a file list made by the daemon, the site and a screen capture (the same file and site for 30 minutes). Find, read and create leave only the path in the work log ([ADR 0022](../decisions/0022-pc-file-tools.md)) | ✅ Implemented |
| T22 | The list of my payment methods leaks, or a wrong method is charged | We store only "what to pay with": the type of easy-pay service, a masked label of what is used within it (e.g. `신한카드(1234)`, Shinhan Card ending 1234), the card company, a nickname and the last 4 digits. Card numbers, expiry dates, CVC and payment passwords are neither accepted nor stored (refused if it contains 5 or more digits). Kept only in the PC daemon's settings, and the phone asks over the encrypted connection. At payment time, Dool2 only picks the matching method among those the site accepts as the **default** on the approval card; choosing and approving is up to the user, and the choice is bound into the phone signature (T2). Reading an easy-pay screen takes only the masked labels visible on the screen ([ADR 0023](../decisions/0023-my-pay-methods.md)) | 🗓 In progress |
| T16 | API key leak or runaway billing in pay-as-you-go mode | The key is kept in the OS keychain and passed as an environment variable only at run time; when the monthly limit is exceeded, Dool2 stops and asks. Dool2 cannot block system-wide admin settings on a company PC ([ADR 0010](../decisions/0010-pay-as-you-go-opencode.md)) | 🗓 M1+ |

## 4. What we cannot block

- **A PC already infected with malware.** Malware running with the same user privileges can see Dool2's memory, records and browser.
- **When the user approves without checking.** Dool2 shows clearly on the approval screen what, where, how much and the cancellation terms, but the final judgment is the user's.
- **Problems on the AI company's side.** Outages or security incidents of the Claude Code or Codex services themselves.
- **Service terms.** Some services forbid automation. Dool2 operates at human speed on the user's behalf, but how terms apply differs by service. We write known restrictions into skills.

## 5. Pinned security tests

These tests must not be deleted or weakened. To change them, you must also edit this doc and state the reason.

- If an agent announces a tool outside the Dool2 tools, execution stops (`packages/agent-claude`, `packages/agent-codex`)
- Calling the local API without a token is refused (`apps/daemon`)
- (M3) If a `pay` or `contact` tool runs without approval, the test fails (`packages/gate`)

If you find a vulnerability, please report it privately following the [security policy](../../SECURITY.md).
