# Dool2

**dool² · Ask from your phone, the work happens on my computer.** Dool2 is an AI assistant that handles bookings, grocery shopping and mail cleanup in the logged-in browser on my own computer. You ask from your phone, and anything that costs money is approved on the phone. The colors and character directly continue the current dool2.com (mint outlet face, black chat bubble, white app, navy landing), and on top of that we organized the structure, voice and state rules. It is the standard that gives the landing page, desktop app and mobile app the same face.

## v2 (2026-11-15): soft surfaces

After real use, we redecided the screens. The reference screens are [`../screens/soft/`](../screens/soft). Where this differs from the v1 content below, this section wins.

- **Background**: instead of white, a very pale gray `bg #F5F6F8` (dark `#0D0F12`). Cards and sheets float as white `surface`.
- **Floating glass**: only the menu circle and "my PC" pill in the header, the input field, the tab bar and sheets use `glass` (translucent + blur) + `shadow-float`. Everything else is surfaces and 0.5px lines.
- **Header**: menu on the left, Dool2 in the middle (round character + a name tag showing what it is doing now), the "my PC" connection state on the right.
- **Chat bubbles**: Dool2 is gray `raise`, I am **pale mint `me #D4F1E3`** (dark `#1B4733`). The black "me" bubble of v1 is not used.
- **Approval**: instead of a yellow card, a white approval card + a large amount + a **deep mint approve button** (`approve #13885A`). Yellow (`butter`) is only for the waiting dot, badges and the "please do this yourself" card.
- **Tabs**: 4 floating pill slots at the bottom (Chat · Tasks · Ideas · Connections). Only the current tab expands its name. Dool2 itself (activity, permissions, schedule, memory) is a panel opened by tapping the character.
- **Cards**: live screen card (gray plate + address line + live indicator + enlarge), result list, file, bottom-sheet details. Three dots while answering, quick replies under a question it asked.
- **Login**: IDs and passwords go through the login card (vault); only robot checks and identity verification use the live screen.
- **Corners**: chat bubbles and cards 20, buttons and inputs 14, sheets and drawers 32. The floating tab bar, input field and quick replies are pills. The primary button is not a pill.
- **Motion**: a sent message appears on screen immediately (without waiting for the reply), replies stream in as they are written, tab switch 0.22 s, sheet 0.28 s.

## One-line direction

**One mint friend on a clean white tool.** Keep the screens tidy with white, black and gray lines. Concentrate cuteness only in the mint character and the "working" indicator. The screen is not cute; Dool2 is cute.

### Principles

1. **You trust what you can see being done.** Always show where and what it is doing, with "the screen Dool2 is looking at" and a step log. Do not use vague indicators like "thinking...".
2. **A person presses money and messages.** Payment and sending must stop at an approval card (butter). The approve button is the heaviest element on the screen.
3. **Mint is Dool2's color.** `brand` is only for the character, the ² in the wordmark, the "working" dot and spinner. Buttons and the user's bubble are ink (black).
4. **Lines over cards.** Divide with `line` 1px hairlines and `surface-sunken` gray panels. Shadows (`shadow-sheet`) only for floating things (approval sheet, popovers).
5. **State is promised by color.** Mint = working, yellow (`butter`) = you're needed, black check = done, red = stopped or error. Do not use color for any other meaning.

## Brand

- **Wordmark** `dool²`: lowercase dool + mint superscript ², with a small "두리" beside it. The original logo file is the standard (the wordmark SVG is not yet in this system and needs to be added).
- **Name**: "Dool2" (두리) inside the app, "dool²" for the domain and logo. The two-ness means the phone and computer work together.

## Voice

This is the Korean voice (see [persona](../../persona.md)). Each language gets its own native voice for the same character (ADR 0029). Korean examples are kept as data, with English glosses in parentheses.

- Polite 해요체 ("~요"), short. One thing per sentence. Dool2 speaks in the first person: "찾아볼게요" (I'll look), "결제 전에 물어볼게요" (I'll ask before paying).
- Give a sense of place: "우리 집에서 일하는 중" (working at our home), "내 컴퓨터가 해요" (my computer does it).
- Numbers, times and prices are exact and come first: "₩59,800 · 내일 09:00 서울→부산" (₩59,800 · tomorrow 09:00 Seoul→Busan).
- Forbidden: "AI가 도와드립니다" (AI will help you), "스마트한" (smart), "혁신적인" (innovative), strings of exclamation marks, emoji as icons.
- Buttons are verbs: `승인하기` (Approve), `대신 해줘` (Do it for me), `내가 할게요` (I'll do it). Do not use only "확인/취소" (OK/Cancel).

| Situation | Good | Avoid |
| --- | --- | --- |
| Starting a task | 좋아요. 내일 7시, 4명, 조용한 한식집으로 찾아볼게요. (Sure. I'll look for a quiet Korean restaurant tomorrow at 7, for 4.) | 요청을 처리하고 있습니다... (Your request is being processed...) |
| In progress | 캐치테이블을 살펴보는 중 (Looking at Catchtable) | 작업 수행 중 (Performing task) |
| Asking approval | ₩59,800 결제할까요? 7호차 12A 창가예요. (Pay ₩59,800? It's car 7, seat 12A, by the window.) | 결제를 진행하시겠습니까? (Do you wish to proceed with payment?) |
| Done | 예매했어요. 승차권은 코레일톡에 있어요. (Booked. Your ticket is in the Korail Talk app.) | 작업이 성공적으로 완료되었습니다! 🎉 (The task was completed successfully! 🎉) |
| Blocked | 본인인증은 직접 해주셔야 해요. 폰에서 열어둘게요. (You need to do the identity verification yourself. I'll open it on your phone.) | 오류가 발생했습니다. (An error has occurred.) |

## Color

White, black and gray make up 90% of the screen, and the state colors share the rest. Both light and dark.

- **bg #ffffff / dark #16181d** App background.
- **surface-sunken #f4f5f7** The "screen Dool2 is looking at" panel, logs, selected rows, shortcut tiles.
- **ink #111214** Text, default buttons, the **user's chat bubble** (white text).
- **brand #4cc98f dool² mint** The character, ², the working dot and spinner. Text on a white background uses `brand-text` #167a4b. Text on mint or yellow uses `on-accent` #0f2a1d.
- **night #1d2846** The landing hero navy. Not used inside the app.
- **butter #ffd66b** Approval and caution.

Text contrast: body at least 4.5:1, `ink-muted` 6:1 on bg.

## Typography

- **Pretendard Variable** only. Body 450, headings 680–760. The larger the text, the tighter the tracking (display −0.035em).
- **JetBrains Mono** only where alignment is needed, such as logs, receipts and domains (`log`). It is the only device that gives the feeling that Dool2 is really working; no decoration.
- Mobile chat `body-lg` 17px, desktop chat `body` 15px.

## Character: Dool2 (3D, since 2026-11-16)

It is the **3D Dool2** of the landing page (dool2.com) as is. A soft mint squarish body (with a slight rainbow sheen on the sides), two vertical capsule eyes, a keyhole mouth and two short feet. The source is the code [`packages/ui/doori3d.js`](../../../packages/ui/doori3d.js), and expressions change only through the **eyes** and a **small prop** at the upper right of the head. The body, mouth and color are the same in every expression.

| Expression | File | Eyes | Prop | When |
| --- | --- | --- | --- | --- |
| Default | idle | Default capsule eyes | None | Standby, home |
| Thinking | thinking | Looks up, head turned slightly | Three dots | Planning (1–3 s) |
| Working | working | Narrowed, strained eyes, faster breathing | Sweat drop | Running in the browser |
| Asking | asking | Enlarged eyes | Yellow question mark | Approval or identity verification needed |
| Done | done | Smiling eyes ^^, pink cheeks | Sparkle star | Task finished |
| Sleeping | sleeping | Closed eyes, slow breathing | Purple Z z | PC is off or offline |

Rules:
- One large visible character per screen. In messages, only small, on the first message of a group.
- Sizes: 22–56px use pre-rendered images (`packages/ui/doori/*.webp`); 64px and above (the Dool2 panel, first screen, pairing, desktop home) use the animated 3D (`mountDoori`).
- Animated 3D: bobs up and down as if breathing, blinks now and then, hops when tapped. It stops when off screen, and draws just one frame under "reduce motion".
- When you change an expression, re-render the expression images with `packages/ui/doori-render.html`.
- The app icon is not cropped from the 3D render; the source is `packages/ui/doori/app-icon.svg`, a separately drawn icon of Dool2's face. The whole tile is the mint body, with only the glossy eyes, keyhole mouth and head highlight stripe on top (no legs). When changed, `packages/ui/icon-render.html` re-renders the desktop, phone, extension and Android icons and the splash screen all at once.
- The logo (`mark.svg`) stays the flat drawing for small display.

## Layout

**One conversation.** We do not create a new room per topic. In the single conversation with Dool2, everyday talk and delegated tasks pile up in sequence by date, and a task is a card inside it. Dool2 speaks first ("점심은요?", "What about lunch?"), and quick-reply buttons let you continue right away. Even when you are on another tab, a "what's happening now" bar floats at the top. Tabs: Chat · Tasks · Explore · My Dool2. The `말하기` (Speak) button on the right of the input starts a voice conversation (it stays as text in the same conversation). Dool2's words are a `raise` bubble, the user's words are an ink-inverted bubble, and Dool2 reacts to a user message with its character face (instead of emoji).

**Dark is the default.** Dark bg #121418, surface #1b1d23, raise #23262d. Light is the same structure on a white background.

**Desktop (≥1024px)** 3 columns: sidebar 248px (task list, connected computer) / conversation max 720px / "Dool2's screen" 400–480px (live preview + step log).

**Mobile (<768px)** Single column, 16px on both sides, input fixed at the bottom. The "Dool2's screen" card is inline in the conversation. Approval is a bottom sheet (`radius-xl`).

**Landing** Dark background + the real app screen inside a `night` hero. Copy is left-aligned, proven with real screens.

**Spacing**: multiples of 4 (`space-*`). 12px for the same speaker, 24px when the speaker changes.

## Icons

Lucide-style line icons, 1.75px, 20px box, rounded ends, ink/ink-muted. No emoji. Shortcuts (restaurant booking, grocery shopping, parcel tracking, mail cleanup) are a sunken tile + a white icon chip (as dool2.com does now). Sites are shown as domain text (catchtable.co.kr).

## Motion

- Default 160ms `cubic-bezier(.2,.8,.2,1)`, bottom sheet 240ms.
- A new message appears rising only 4px. No scroll fade-up.
- The spinner appears only on the in-progress row of the log, as a mint arc.

## Not looking like AI: the prohibition list

- Purple and blue gradients, aurora and blob backgrounds, neon glow, ✨ icons
- Glassmorphism
- Cards inside cards, everything in rounded cards → use lines and gray panels instead
- Overuse of pill buttons → buttons are `radius-md` 12px, send is a square ink button
- A centered hero + 3 feature cards
- Overuse of uppercase eyebrow labels
- Emoji icons
- Meaningless stat blocks ("10x faster")
- Fade-up on every scroll
- Fake OS status bars

## Components

Button · Composer · Message · ApprovalCard · AgentLog · StatusHeader · Avatar · PickCards · ChatBlocks (quick replies, list rows, single result, draft to send). Each folder's README has its rules.
