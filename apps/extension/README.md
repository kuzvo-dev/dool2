# @dool2/extension

The **Dool2 extension**, installed in the Chrome the user already uses ([ADR 0006](../../docs/decisions/0006-user-chrome-extension.md)). It lets Dool2 do web tasks with the user's usual logins.

The extension is a **thin hand that does not make decisions**. The Dool2 daemon (the approval gate) decides what may be done, and the extension only does what it is told.

```
Dool2 daemon ─ local socket ─ native messaging host ─ connectNative ─ this extension ─ chrome.debugger ─ Dool2 tab
```

## What it guarantees

- **It only touches tabs Dool2 opened.** Dool2 tabs are collected in a green tab group inside a separate "Dool2" window. It never reads or clicks tabs the user opened. Only a tab opened from a Dool2 tab through a new-window link is taken over as a Dool2 tab.
- **It only opens http and https addresses.** `file:`, `chrome:`, `javascript:`, and `data:` are not opened.
- **Input is real input.** Clicks and keys go in through `chrome.debugger` (CDP `Input.*`). It does not use clicks imitated by page scripts.
- **The page cannot see Dool2's markers.** The page is read in an extension-only space (isolated world), and the click-target markers (`e12`) live only inside it.
- **The AI cannot type into password fields.** They are filled only from the Dool2 vault (`fill`), and even then the current page address must match the saved site ([ADR 0011](../../docs/decisions/0011-login-vault.md)).
- The debugger is attached only while in use and detached after 2 minutes of no use. Meanwhile Chrome shows a "being controlled" bar. If the user presses **Cancel** on the bar, that tab is not handled again.

## What it can do

| Command      | What it does                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `open`       | Opens a new tab in the Dool2 window and waits until it has fully loaded                                |
| `navigate`   | Changes the address of a Dool2 tab                                                                     |
| `snapshot`   | Reads the page as text. Marks clickable things like `[e3 button "검색"]` (button "Search"), and detects CAPTCHA screens |
| `click`      | Scrolls the marked element to the center of the screen and clicks it with the mouse. Reports if a new tab opens |
| `type`       | Types into the marked field (replacing existing text). With `submit`, presses Enter                    |
| `press`      | Enter, Tab, Esc, arrow keys, and so on                                                                 |
| `scroll`     | One screen up or down                                                                                  |
| `screenshot` | The visible screen as JPEG (up to 1280px wide)                                                         |
| `back`       | Go back                                                                                                |
| `focus`      | Brings the Dool2 window and tab to the front when handing off to a person                              |
| `fill`       | Fills a Dool2 vault value (checks address and field)                                                   |
| `close`      | Closes a Dool2 tab                                                                                     |

## Development

```bash
pnpm build                       # → apps/extension/dist (the folder to load into Chrome)
```

- To test in the user's Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → `apps/extension/dist`. Then start the Dool2 app with `DOOL2_REGISTER_HOST=1 pnpm dev:desktop` so that Chrome can find the Dool2 host.
- The extension id is fixed by the `key` (public key) in `manifest.json` (`mgjjgnbhoaalicncjbbcldjffpecocah`). The daemon opens the host only to this id. When the extension is published on the Web Store, fill the store id into `STORE_EXTENSION_ID` in `@dool2/protocol`. Then the desktop app switches to a single [Add to Chrome] click plus external extension registration. For how to submit and the wording, see [docs/store/chrome-web-store.md](../../docs/store/chrome-web-store.md); the zip for submission is made with `pnpm --filter @dool2/extension pack`.

### End-to-end check

This loads the extension into a test Chrome (Chrome for Testing), connects it to the real daemon, and checks open, read, type, click, new tab, scroll, capture, CAPTCHA detection, and forbidden actions on a test page. It does not touch the user's Chrome or profile. Regular Chrome 137 and later cannot load extensions from the command line, so it uses Chrome for Testing.

```bash
npx @puppeteer/browsers install chrome@stable --path ~/.cache/dool2-test
pnpm build
DOOL2_TEST_CHROME="<Chrome for Testing executable>" pnpm --filter @dool2/extension e2e
# → apps/extension/out/e2e-search.jpg, e2e-snapshot.txt
```

## Tuned from measurements

- **A background tab does not receive input.** When a new-window link brought another tab to the front, clicks on the original tab were dropped. So before input, it switches that tab back to the front tab within the Dool2 window (it does not bring the window itself to the front).
- **If focus stays on a password field**, Chrome's password suggestion popup swallows the next click. After filling from the vault, it removes the focus.
- If the tab is not being drawn (`visibilityState: hidden`), mouse input is dropped. In that case it focuses the element and presses it with Enter or Space. Only elements that cannot take focus are clicked from inside the page. **Behavior on a PC with its screen off has not yet been verified in practice (a QA item).**

## Known limits

- It cannot yet read inside iframes (payment windows, maps, and so on). It will be widened per frame when needed.
- If the Dool2 window is covered by another window, Chrome does not draw the screen. So the waits that confirm mouse moves and scrolls are kept short.
