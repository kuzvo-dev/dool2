# Chrome Web Store listing

How to publish the Dool2 extension to the Chrome Web Store, and what to put in the submission screens. The desktop app's "Add the Dool2 extension from Chrome (one click)" and the external extension registration only work once it is on the store ([architecture 5.1](../architecture.md), 8.0).

The store listing text is Korean data (the listing is Korean-language). It is kept as is, with an English translation next to it. Only the surrounding instructions are English.

## Steps

1. **Create a developer account**
   - Go to the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole) with the Google account used for running Dool2.
   - Pay the one-time registration fee.
   - Finish the seller information (name, address, contact email) and verification.
2. **Build the zip for submission**

   ```sh
   pnpm --filter @dool2/extension build
   pnpm --filter @dool2/extension pack        # apps/extension/out/dool2-extension-<version>.zip
   ```

   - The development `key` is left out of the zip. The store assigns a new id on first upload.
   - The code is not minified, so that reviewers can read it.
3. **New item → upload the zip**
   - Fill in the "Listing" and "Privacy practices" fields below.
   - You may upload as an **Unlisted link first**. External registration and [Add to Chrome] are reported to work for unlisted items too. Confirm this in the first test.
4. **Review**
   - The `debugger` permission and access to all sites may trigger an in-depth review. It takes from several days to several weeks.
   - If rejected, get the reason, fix this doc and the permission explanations, and resubmit.
5. **Fill in the id** (submitted 2026-11-17: `ogpbnlgnijmebpeiaceeepemcngiocif`, not yet registered, auto-published after review passes)
   - Put the item id (32 characters) shown in the dashboard into `STORE_EXTENSION_ID` in `packages/protocol/src/index.ts`.
   - The connection channel (native messaging) allows exactly that id.
   - Once it passes review and is published, change `STORE_EXTENSION_PUBLISHED` to `true`. From then on the desktop app switches to the web store method ([Add to Chrome] and external registration).
6. **Verify (real Chrome)**
   - Mac: first-run screen → [How to add] → on the page opened in Chrome, [Add to Chrome] → check that the green light comes on.
   - Mac: with the extension removed, restart Chrome and check that [Enable] appears.
     - External registration was confirmed on 2026-11-17 on Mac Chrome 157 with a public extension. It was installed from the web store as "waiting to be enabled".
   - **Windows:** be sure to check that external registration in the user registry (HKCU) works. The official docs mention only HKLM. If it does not work, use only the [Add to Chrome] method.

## Publishing a new version

1. Raise the version in `apps/extension/package.json` (the store does not accept the same version again).
2. `pnpm --filter @dool2/extension build && pnpm --filter @dool2/extension pack` → `apps/extension/out/dool2-extension-<version>.zip`
3. Dashboard → the Dool2 item → Package → [Upload new package] → submit. After review finishes, Chrome replaces users' extensions within a few hours.
4. If the desktop app truly needs a new extension feature, raise `MIN_CONNECTOR_EXTENSION` (older extensions will not use that feature).

| Version | Submitted | Status |
|---|---|---|
| 0.2.0 | 2026-11-17 | Published (confirmed 2026-11-23) |
| 0.3.0 | 2026-11-23 | Published, unlisted (confirmed 2026-11-24). Contents: screen viewing, mouse, tab cleanup, build fingerprint, artwork tile slot (@center), new permission `contentSettings` |
| 0.3.1 | 2026-11-24 | Published, unlisted (confirmed 2026-11-25). Contents: a page is ready when its content shows, not after every ad (#437); no new permission |
| 0.3.2 | 2026-11-25 | Published (installed from the store on the test PC, confirmed 2026-11-27). Contents: `open` can open a tab in the background, so a lookup task reads beside a running task without bringing its tab to the front (#525); no new permission |
| 0.3.3 | 2026-11-27 | Published (same day). Contents: `pdf` prints a tab as a PDF through the existing `debugger` permission (Page.printToPDF) so certificates and statements in a viewer can be kept as files (#617); no new permission |
| 0.3.4 | 2026-11-27 | Published (same day). Contents: `eval` runs a side-effect-free script on a Dool2 tab (Runtime.evaluate with throwOnSideEffect) and `cdp` calls a fixed list of read-only DevTools methods (print to PDF, page archive, full capture, accessibility tree, loaded resources), both through the existing `debugger` permission (ADR 0045); no new permission |
| 0.3.5 | 2026-11-27 | Published (same day). Contents: 0.3.4 plus `update`, which asks Chrome for a newer store version now (`runtime.requestUpdateCheck`) and reloads when it is ready, asked by the daemon only while idle; and site alerts a popup showed right before closing go to the tab that opened it (a verification window's "details do not match"). No new permission |
| 0.3.6 | 2026-11-27 | Submitted, publishes itself after review. Contents: `pdf` prints only the document a viewer shows (its page canvases, images or SVGs, one per A4 sheet) instead of the whole tab with the viewer's toolbar and buttons; `only: 'page'` keeps the whole tab. No new permission |

### Permission reason (Privacy practices tab)

Submitted text (Korean) with an English translation.

- **contentSettings** (added in 0.3.0):

  > 두리가 사용자 대신 일하는 사이트에서 결제 창·본인인증 창이 새 창(팝업)으로 열릴 때, Chrome 팝업 차단 때문에 빈 화면만 남는 문제를 막으려고 씁니다. 두리가 지금 작업 중인 탭의 그 사이트(같은 사이트 범위)에만 contentSettings.popups를 '허용'으로 바꾸고, 다른 콘텐츠 설정(쿠키·자바스크립트·위치·카메라 등)은 읽거나 바꾸지 않습니다. 사용자가 주소창의 '팝업 허용'을 직접 누르던 것과 같은 동작이며, 결제·제출 같은 마지막 단계는 여전히 사용자 승인을 받은 뒤에만 진행합니다.
  >
  > (English: Used so that, when a payment window or identity-verification window opens as a new window (popup) on a site where Dool2 is working for the user, Chrome's popup blocker does not leave only a blank screen. It changes contentSettings.popups to "allow" only for that site (same-site scope) in the tab Dool2 is currently working in, and does not read or change any other content setting (cookies, JavaScript, location, camera, etc.). It does the same thing as the user pressing "Allow popups" in the address bar by hand, and final steps such as payment or submission still proceed only after the user approves.)

### Artwork (new, 2026-11-23)

Edit `docs/store/art/store-art.html`, capture `#s1` to `#s5` (1280×800), `#tile` (440×280) and `#marquee` (1400×560) at those sizes,
convert to JPEG without transparency (`sips -s format jpeg`) and upload → `docs/store/art/out/`. The listing is locked while
under review, so cancel the review, edit, and resubmit.

## Listing

The fields contain Korean text to be pasted as is. An English translation follows each Korean text.

| Field | Content |
|---|---|
| Name | 두리 (Dool2) |
| Summary (up to 132 characters) | 내 컴퓨터의 두리가 이 브라우저에서 대신 일할 수 있게 연결해요. 두리 PC 앱이 있어야 동작해요. (English: Connects Dool2 on my computer so it can work in this browser on my behalf. Requires the Dool2 desktop app.) |
| Category | Productivity |
| Language | Korean |
| Icon | `apps/extension/static/icons/icon128.png` |
| Screenshots (1280×800) | The "Add the Dool2 extension" screen from the desktop app's first setup, the screen where Dool2 works in the conversation, and a Chrome screen showing the Dool2 tab group |
| Homepage | https://dool2.com |
| Support | Public repo issues or the main contact email |

**Detailed description**

> 두리는 내 컴퓨터에 사는 AI 비서예요. 폰이나 PC에서 "이번 주 토요일 저녁 성수에서 4명 식당 찾아 줘"처럼 부탁하면, 내 컴퓨터의 두리가 평소 쓰는 이 브라우저에서 대신 찾아보고 정리해 드려요.
>
> 이 확장은 두리 PC 앱과 이 브라우저를 이어 주는 연결 고리예요. 두리 PC 앱이 설치돼 있어야 동작해요.
>
> - 평소 로그인 그대로: 이미 로그인해 둔 사이트는 다시 로그인하지 않아도 돼요.
> - 두리가 연 탭만 다뤄요: 두리 탭은 "두리" 탭 그룹에 모이고, 사용자가 연 탭은 건드리지 않아요.
> - 결제·예약 확정·보내기 같은 마지막 버튼은 누르기 전에 꼭 사용자 승인을 받아요.
> - 페이지 내용은 사용자 컴퓨터의 두리 앱에만 전해져요. 두리 팀 서버로 보내지 않아요.
> - 오픈소스예요. 코드를 누구나 볼 수 있어요.

English translation:

> Dool2 is an AI assistant that lives in my computer. When you ask from your phone or PC, such as "find a restaurant for 4 in Seongsu this Saturday evening", Dool2 on my computer looks it up and sorts it out for you in the browser you normally use.
>
> This extension is the link between the Dool2 desktop app and this browser. It only works with the Dool2 desktop app installed.
>
> - Your usual logins: sites you are already logged in to do not ask you to log in again.
> - It only handles tabs Dool2 opened: Dool2's tabs gather in a "두리" (Dool2) tab group, and tabs you opened are left alone.
> - Final buttons such as payment, booking confirmation and sending always get your approval before they are pressed.
> - Page content goes only to the Dool2 app on your computer. It is not sent to the Dool2 team's servers.
> - It is open source. Anyone can read the code.

## Privacy practices tab

**Single purpose**

> 사용자 컴퓨터에 설치된 두리 PC 앱이, 사용자의 부탁에 따라 이 브라우저에서 탭을 열고 페이지를 읽고 누르고 입력할 수 있게 연결한다.
>
> (English: Lets the Dool2 desktop app installed on the user's computer open tabs, read pages, click and type in this browser according to the user's request.)

**Why each permission is used**

The "Reason" column is pasted into the submission field as is (Korean); the English column is a translation for reference.

| Permission | Reason (Korean, pasted as is) | English |
|---|---|---|
| `nativeMessaging` | 같은 컴퓨터에 설치된 두리 PC 앱과만 이야기하는 통로예요. 원격 서버와 통신하지 않아요. | A channel that talks only to the Dool2 desktop app installed on the same computer. It does not communicate with remote servers. |
| `debugger` | 사이트가 진짜 사용자 입력으로 받아들이는 클릭·타이핑을 넣고, 승인 화면에 보여 줄 캡처를 찍는 데 써요. 두리가 연 탭에만 붙이고, 2분 동안 안 쓰면 떼요. | Used to send clicks and typing that sites accept as real user input, and to take the capture shown on the approval screen. Attached only to tabs Dool2 opened, and detached after 2 minutes of no use. |
| `tabs` | 두리가 일할 탭을 열고 닫고, 두리가 연 탭인지 확인해요. | Opens and closes the tabs Dool2 works in, and checks whether a tab was opened by Dool2. |
| `tabGroups` | 두리가 연 탭을 "두리" 그룹으로 모아 사용자 탭과 구분하고, 다 쓴 탭을 정리해요. | Gathers tabs Dool2 opened into a "두리" (Dool2) group to tell them apart from the user's tabs, and cleans up tabs it is done with. |
| `scripting` | 두리가 연 탭의 화면을 글로 읽고, 누를 위치를 찾아요. | Reads the screen of tabs Dool2 opened as text, and finds where to click. |
| `webNavigation` | 페이지 로딩이 끝났는지, 두리 탭에서 새 창이 열렸는지 알아요. | Knows whether a page has finished loading and whether a new window opened from a Dool2 tab. |
| `alarms` | 두리 PC 앱과 연결이 끊기면 다시 잇고, 오래 안 쓴 두리 탭을 정리해요. | Reconnects when the connection to the Dool2 desktop app drops, and cleans up Dool2 tabs unused for a long time. |
| `storage` | 두리가 연 탭 목록 같은 작은 상태를 브라우저 안에 저장해요. | Stores small state, such as the list of tabs Dool2 opened, inside the browser. |
| Site access (`http://*/*`, `https://*/*`) | 사용자가 부탁하는 사이트가 정해져 있지 않아서(식당 예약·장보기·택배 조회 등) 두리가 연 탭이면 어느 사이트든 읽고 누를 수 있어야 해요. 사용자가 연 탭은 다루지 않아요. | The sites users ask about are not fixed (restaurant booking, grocery shopping, parcel tracking, etc.), so Dool2 must be able to read and click on any site in a tab it opened. Tabs the user opened are not touched. |

**Remote code**: not used. All code is inside the extension package.

**Data usage disclosure**

| Item | Answer | Explanation |
|---|---|---|
| Website content | Handled | Passes the page text of tabs Dool2 opened to the Dool2 app on the user's computer. The Dool2 app sends the request to the AI the user chose (Claude, Codex, etc. on the user's own account) to process. It is not sent to the Dool2 team's servers. |
| Personally identifiable information, authentication information | Handled (Dool2 vault) | Fills login info that the user saved in the Dool2 app only into that site's login fields. The values stay only on the user's computer and are not sent to the AI either. |
| Sale or transfer to third parties | Not done | |
| Use for unrelated purposes, credit evaluation | Not done | |

This table is a draft matched to the actual behavior. The person submitting makes the final choices to match the checkbox names in the dashboard.

## Content to add to the privacy policy

Right now dool2.com/privacy limits its scope to "only the information collected on the beta signup site". Add the section below to meet store review. The policy page is Korean, so the text to add is Korean data; an English translation follows.

> **두리 앱과 브라우저 확장**
> - 두리 PC 앱과 두리 브라우저 확장은 사용자 컴퓨터 안에서 동작해요. 대화, 기록, 브라우저에서 읽은 페이지 내용은 사용자 컴퓨터에만 저장되고 두리 팀 서버로 보내지 않아요.
> - 두리 확장은 두리가 연 탭에서만 페이지를 읽고 누르고 입력해요. 읽은 내용은 같은 컴퓨터의 두리 앱에만 전해요.
> - 두리 앱은 사용자의 부탁을 처리하려고 사용자가 고른 AI 서비스(사용자 본인 계정)에 부탁과 필요한 페이지 내용을 보내요. 이 내용은 그 AI 서비스의 개인정보 처리방침을 따라요.
> - 사이트 로그인 정보는 두리 금고(사용자 컴퓨터의 암호화된 저장소)에만 있고, 그 사이트의 로그인 칸에만 채워요. AI 서비스에도 보내지 않아요.
> - 폰과 컴퓨터 사이 메시지는 종단간 암호화돼서 중계 서버도 내용을 볼 수 없어요.
> - 두리는 이 정보를 팔거나 광고에 쓰지 않아요.

English translation:

> **The Dool2 app and browser extension**
> - The Dool2 desktop app and the Dool2 browser extension run on the user's computer. Conversations, records and page content read in the browser are stored only on the user's computer and are not sent to the Dool2 team's servers.
> - The Dool2 extension reads, clicks and types on pages only in tabs Dool2 opened. What it reads goes only to the Dool2 app on the same computer.
> - To process the user's request, the Dool2 app sends the request and the needed page content to the AI service the user chose (the user's own account). This content follows that AI service's privacy policy.
> - Site login information exists only in the Dool2 vault (encrypted storage on the user's computer) and is filled only into that site's login fields. It is not sent to AI services either.
> - Messages between the phone and the computer are end-to-end encrypted, so even the relay cannot see their content.
> - Dool2 does not sell this information or use it for advertising.

## Edge

- Edge accepts the Chrome Web Store address as is for external registration, so the desktop app registers for it too.
- It would be good to also publish to [Edge Add-ons](https://partner.microsoft.com/dashboard/microsoftedge/) so Edge users can find and install it themselves.
  - The id you get there is different, so add it to `EXTENSION_IDS`.
  - This is postponed to the next stage.
