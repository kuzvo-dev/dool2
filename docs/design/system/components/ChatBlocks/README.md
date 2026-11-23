# ChatBlocks
**Result blocks** and **quick replies** attached right under Dool2's reply. Only a few fixed shapes are used, only at moments when plain text would lose out.
Code: shapes and cleanup in `@dool2/protocol/blocks`, drawing in `@dool2/protocol/blocks-view` (shared by phone and PC), styles in `.cb-*` of `packages/ui/ui.css`.

Cards in the conversation are split in two.
- **Work in progress**: work log · approval · login · connection · proactive check (separate)
- **Result of the work**: the blocks below + photo cards (PickCards) + tables. **Only one** per reply.

## Kinds

| Kind | Tool | When |
| --- | --- | --- |
| Quick reply | One line at the end of the reply `[[답: a \| b \| c]]` (`답` = "reply") | Only when Dool2 asks the user to choose. 2 to 4 items, each within 14 characters (drop it if over 20). The first is Dool2's recommendation (ink) |
| List rows | `show_list` | Lists where a photo is not the reason for choosing: listings, orders, mail, schedules, documents, job postings |
| List rows · pick several | `show_list` `pick: multi` | Several at once, like groceries, gifts or documents. Dool2 pre-checks them, and the user only unchecks what they want to leave out |
| Single result | `show_result` | Proof something is done (booking or order number), amount totals, delivery or application steps, deadlines |
| Draft to send | `show_draft` | Text used word for word: text messages, chat messages, mail, complaints, reviews |
| Photo cards | `show_cards` | Things where the photo is the reason for choosing (PickCards) |

## Shared frame
- White `surface` + 0.5px `line`, corner `radius-lg` (20). No shadow. Max width 420px.
- **Header line** (12.5px `ink-muted`): title · on the right, source and count (`ink-faint`). A finished result gets an ink check circle + mint text.
- **Buttons**: up to 2 in the bottom row. The last is the primary (ink), the one before is secondary (outline). Names are verbs. Money, contact and delete are not done directly from a block: the button sends Dool2 a request in words, and Dool2 asks through an approval card. Names like "pay", "transfer" and "delete" (결제·송금·삭제) are dropped during cleanup.
- No inner scroll. A list shows up to **5 rows** and expands in place with `N개 더 보기` ("show N more"). Horizontal swipe is only for photo cards.
- Inside a block, divide only with lines and `surface-sunken` panels. No cards inside cards.
- Colors keep the state promise: mint = in progress (the current slot of a step), yellow = waiting or deadline (`D-4`), red = stopped. No decorative color.

## List rows
- Row: 40px lead · title (14.5 bold, one line) · small line (12.5 `ink-muted`) · value on the right (bold, fixed-width digits) or a status text.
- Use just one lead: `img` small photo (fetched and passed on by the PC daemon) · `date` date tile (day, month, weekday) · `file` file type (PDF) · `logo` circle · `check` check · `none`.
- On tap: with `pick: one`, send "이걸로 할게: …" ("I'll go with this: …"); otherwise open that row's address.
- One button below: something done for the whole list, like "캘린더에 3개 넣기" ("Add 3 to the calendar").

### Picking several
- Checkbox (20px, ink when on) + (shopping and groceries only) a 32px small photo + title and quantity + amount.
- Items Dool2 picked are pre-checked. Doubtful ones (almost out of stock, bought last year) are left off, with the reason on the small line.
- Unchecked rows are dimmed (45%). On the right of the header: `3/5개 고름` ("3 of 5 selected").
- The button text changes with each selection: `3개 담기 · 25,860원` ("Add 3 · 25,860 won"; the total only when every amount is known). On tap it sends "고른 것: …(뺀 것: …)" ("Chosen: … (left out: …)"). Adding to a cart does not spend money, so it goes immediately; payment goes through an approval card.
- After sending (or after the user then says something else) it locks: rows cannot be tapped and the button reads `골라서 보냈어요` ("Sent my picks").

## Single result
- One big value (24px 760, when or how much) + small text beside it (4명 · 룸, "4 people · private room") + a yellow `D-6 결제` ("D-6 payment") if there is a deadline.
- 3 to 6 info rows (name `ink-muted` · value bold on the right). Numbers use `code` → JetBrains Mono.
- 2 to 6 progress steps: past steps ink, current step mint, remaining steps `raise`. Step names below, only the current one in ink.
- Dool2 re-reads the finished screen to fill it in (no invented numbers).

## Draft to send
- One line `받는 사람 집주인 김OO · 문자` ("Recipient: landlord Kim OO · text message") → the text word for word on a `surface-sunken` panel (line breaks kept, selectable and copyable).
- Buttons: `복사` (Copy; outline) · `문자 보내기` / `카톡 보내기` / `메일 보내기` / `올리기` (Send text / Send via KakaoTalk / Send mail / Post; ink). Sending asks Dool2 → approval right before sending.
- Edits are just asked in conversation.

## Quick replies
- Pill buttons (34px) under Dool2's bubble. The first button is the recommendation (ink), the others are white surfaces.
- On tap, that text goes as my words and the others dim (38%). They also dim if the user then says something else. Replying in plain text is fine too.
- Not attached to greetings or explanations. Not attached for "what to do next" either: **only when asking the user to choose**.

## 9 rules
1. Text is the default. Use UI only when choosing, confirming or finding something later is clearly easier than text.
2. One result block per reply (progress cards are counted separately). The engine also keeps only the last one.
3. The block sits right under the reply bubble. The bubble is 2 to 4 sentences with only the reason and next step, and does not repeat the block's content in text.
4. At most 2 buttons, as verbs. Money, contact and delete lead to an approval card.
5. No inner scroll. 5 rows + expand in place. Horizontal swipe only for photo cards.
6. No cards inside cards. Only lines and gray panels.
7. Colors keep the state promise.
8. The AI supplies only data; the app decides the shape. Unknown kinds fall back to text.
9. Do not stand out: appear once after the reply has fully streamed, rising 4px (160ms). Do not steal focus, and with reduce-motion, no movement.

## Tables
- Only when comparing two or three options by condition. The first column is the condition (`ink-muted`), and on the phone at most **3 columns and 6 rows**. Beyond that, use photo cards or list rows.
