# @dool2/ui — the Dool2 design system

Tokens and components shared by the desktop app, the phone app, and the Chrome extension. The design source is in [docs/design](../../docs/design/README.md); if this differs, follow the source and fix it here.

- `ui.css` — tokens (color, type, spacing, corners, shadows) and components
- `doori3d.js` — the 3D Dool2 character (the same shape as the landing page) and 6 expressions. For large spots (64px and up), the app build bundles it with three and mounts it so it moves with `mountDoori()`
- `doori/` — pre-rendered images (webp) of the 3D Dool2 for each expression, and the logo (SVG). `.doori` in `ui.css` loads them. To re-render, use `doori-render.html`
- `fonts.css`, `fonts/` — Pretendard variable font ([SIL OFL 1.1](fonts/OFL.txt)). Included only in the desktop app and extension; the phone uses the device font
- `preview.html` — a sample page with every component on one screen. Open it in a browser and switch dark and light at the top
- `copy.mjs` — used by app builds to copy `ui.css`, `doori/` (and fonts) into their own `dist` (`copyUi`), and to bundle the 3D Dool2 (`bundleDoori3d`)

```js
import { copyUi } from '../../../packages/ui/copy.mjs'
copyUi('dist/renderer', { fonts: true }) // desktop app and extension
copyUi('dist') // phone app
```

```html
<html lang="ko" data-theme="auto"> <!-- follow the device setting. Fix with "dark" or "light"; light if absent -->
<link rel="stylesheet" href="fonts.css" /> <!-- desktop app and extension only -->
<link rel="stylesheet" href="ui.css" />
<link rel="stylesheet" href="style.css" /> <!-- the app's screen layout -->
```

## Principles

**One mint friend on a soft surface (v2).** White cards and gray bubbles on a pale gray background; only the things the hand touches (header buttons, the input field, the tab bar, sheets) float like glass. Cuteness is concentrated in the Dool2 character and the "working" indicator. Reference screens: [docs/design/screens/soft](../../docs/design/screens/soft).

1. **You trust what you can see being done.** The Dool2 name tag in the header (`.agent-tag`) shows what it is doing now, a live screen card (`.livecard`) sits inside the conversation, and there are step logs (`.log`, `.worklog`). Vague indicators like "thinking…" are not used.
2. **A person presses for money and messages.** Payment and sending stop at the approval card (`.approve`). The approve button (`.btn-approve`, deep mint) is the heaviest thing on the screen.
3. **Mint is Dool2's color.** The character, working, the approve button, and my bubble in pale mint (`--me`).
4. **Surfaces over boxes; floating things are glass.** Divide with gray surfaces (`--raise`, `--surface-sunken`) and 0.5px lines. Only header buttons (`.fbtn`, `.fpill`), the input field (`.composer.float`), the tab bar (`.tabs`), and sheets float, using `--glass` + `--shadow-float`. Do not put cards inside cards.
5. **State is promised by color.** Mint = working, yellow (`--butter`) dot or badge = you are needed, ink check = done, red = stopped or error.

Other rules:

- End buttons with a verb (`승인하기` "Approve", `대신 해줘` "Do it for me", `내가 할게요` "I'll do it"). One primary button per screen, 14px corners, never pill-shaped (only the floating tab bar, input field, and quick replies are pills).
- Use Pretendard only. Titles at 680–760, body at 450. The larger the text, the tighter the letter spacing (display −0.035em).
- Monospace (`.mono`, `--font-mono`) only where lines must align, such as logs, receipts, and domains.
- Korean breaks lines at word boundaries (`keep-all`), and numbers use tabular figures. Both are built into the base styles.
- Icons are SVG (`svg.i`) on a 24 grid with a 1.75 stroke. Do not use emoji or characters like `›` or `✓` as icons.
- Write copy in everyday words: "approve" instead of "permit", "encrypted" instead of "locked envelope".
- Banned: purple-blue gradients, glow, glass effects used on anything that is not floating, cards inside cards, overuse of pill badges, emoji icons, meaningless stat blocks, fade-up on every scroll.

## Tokens

Colors get both themes from a single `light-dark()`. Follow the values in [docs/design/system/tokens.json](../../docs/design/system/tokens.json) and the screen examples.

| Name                                      | Light / Dark                         | Used for                                                                                                                                    |
| ----------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--bg`                                    | #ffffff / #121418                    | App background                                                                                                                              |
| `--surface`                               | #ffffff / #1b1d23                    | One level raised: input, approval sheet, side panel                                                                                         |
| `--surface-sunken`                        | #f4f5f7 / #0b0c0f                    | Sunken areas: Dool2's screen, logs                                                                                                          |
| `--raise`                                 | #f1f2f4 / #23262d                    | Dool2's bubble, selected menu, icon tiles                                                                                                   |
| `--line` / `--line-strong`                | #e6e8eb / #2a2d35, #8b9099 / #5c616b | Dividing lines / borders of inputs and secondary buttons                                                                                    |
| `--ink` / `--ink-muted` / `--ink-inverse` |                                      | Body, primary button, my bubble / descriptions, times / text on ink                                                                         |
| `--brand`                                 | #4cc98f                              | Dool2 mint (`--brand-text`, `--brand-soft`)                                                                                                 |
| `--butter`                                | #ffd66b                              | You are needed (`--butter-soft`; text on it is `--on-accent`)                                                                               |
| `--danger`                                | #d0342c / #ff7a72                    | Stop, reject, error. Text only (`--danger-soft`)                                                                                            |
| `--space-1…12`                            | 4·8·12·16·24·32·48px                 | 12 for the same speaker, 24 when the speaker changes                                                                                        |
| `--radius-sm/md/lg/xl/full`               | 6·12·20·28·999px                     | Chips / buttons and inputs / bubbles and cards / bottom sheets / characters and dots only                                                   |
| `--shadow-sheet`                          |                                      | Floating things only                                                                                                                        |
| `--text-display` … `--text-log`           |                                      | Font sizes used with a single `font:` line (display 44, title-1 28, title-2 20, body-lg 17, body 15, label 14, caption 12.5, log 12.5 mono) |

The old names (`--ink2` `--sub` `--faint` `--line2` `--side` `--fill` `--duri` `--warn` …) remain only while app screens are moved to the new components. Do not use them in new code.

## Components

| Component        | Classes                                                                                                                                 | Used for                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Dool2 character  | `.doori` + `.thinking` `.working` `.asking` `.done` `.sleeping` (size `--s`, `.bob`)                                                    | Status header, speaker, empty screens, approvals                  |
| Wordmark         | `.wordmark` (`dool<sup>2</sup> <small>두리</small>`)                                                                                    | Above the desktop menu, samples                                   |
| Status           | `.dot` (`.work` `.ask` `.done` `.stop`, `.pulse`), `.spin`, `.shimmer`, `.pill` (`.ask` `.work`), `.count`                              | Connection, progress, waiting for approval                        |
| Buttons          | `.btn` `.btn-ghost` `.btn-text` `.btn-danger` (`.sm` `.lg`), `.btn-link`, `.icon-btn` (`.lg`), `.send`                                  |                                                                   |
| Choosing         | `.chip` (`.on` `.quiet`) `.chips`, `.seg`, `.switch`, `.field`                                                                          | Quick replies and example requests, picking an AI, on/off, input  |
| Text             | `.display` `.title` `.title-2` `.over` `.cap` `.meta` `.mono` `.rich`                                                                   |                                                                   |
| Conversation     | `.who`, `.bubble` (`.me`), `.react`, `.sep`, `.done-row`, `.msg.note`, `.composer` + `.cbtn` (`.go`)                                    | One conversation, the input field                                 |
| Work             | `.livebar` (`.ask`), `.workcard` (`-head` `-foot`), `.screen` + `.urlbar`, `.stepbar`, `.log` + `.log-row` (`.live` `.ask`), `.worklog` | What it is doing now, Dool2's screen, step logs                   |
| Approval         | `.approve` (`-top` `-q` `-amount` `-body` `-actions` `-note`), `.btn-approve`, `.kv` (`dd.money` `dd.host`)                             | Payment and send approvals                                        |
| Lists and cards  | `.list` (`.boxed`), `.row` (`.row-t` `.row-d`), `.tile`, `.card` (`.quiet` `.ask`), `.task` (`.live`)                                   | Settings, tasks, logs                                             |
| Frames           | `.navi`, `.tabs` + `.tab` (`.tab-label`, `.badge`), `.sheet` (`.float`), `.drawer`, `.scrim`, `.toast`, `.rise`                         | Desktop menu, floating mobile tabs, bottom sheets, menu drawer    |
| Floating header  | `.fbtn`, `.fpill`, `.agent` + `.agent-av` + `.agent-tag` (`span.ask`), `.composer.float`, `.quick`, `.typing`                           | Menu, Dool2, my PC, floating input, quick replies, answering      |
| Live screen      | `.livecard` + `.screen` + `.urlbar` + `.live-badge`                                                                                     | What Dool2 does in the PC's Chrome, shown inside the conversation |
| Icon tile colors | `.tile.blue` `.mint` `.amber` `.rose` `.violet`                                                                                         | Ideas, activity logs                                              |

Open [preview.html](preview.html) to see the exact looks.

## When building a new screen

1. Check [docs/design/screens](../../docs/design/screens/README.md) for the same screen, and read the values from the original HTML.
2. Look in [preview.html](preview.html) to see whether the component already exists.
3. Put only layout (grid, spacing, position) in the app's `style.css`. Use tokens for color, corners, and shadows.
4. If a new look is needed, first add it to `docs/design`, then promote it to `ui.css` and add a sample to `preview.html` too.
5. Capture both dark and light and view them next to the mockup to check that nothing breaks the principles.
