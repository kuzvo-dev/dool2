# 0033. Rarely used tools are found and run on demand

- Status: Accepted
- Date: 2026-11-24
- Related: [0018 service connectors](0018-service-connectors.md) (service_find / service_call), [0032 pinned instructions](0032-pinned-instructions.md)

## Context

Every tool the AI can see is sent with every request, with its description and input schema. Dool2 showed 91 tools.
Some carry long descriptions (the motion-graphics video tool alone is several kilobytes) but are used a few times a
week. 6 days of the work log (2,771 turns, 2026-11-19 to 11-24) showed 16 tools used 0 to 15 times, while browser
clicks were used 1,520 times. Another agent harness cut its upfront tool schemas from 40 to 11 the same way and sent
about 29% fewer bytes per request.

## Decision

1. These 16 tools are kept off the visible list: `video_style`, `video_clip`, `video_motion`, `video_make`,
   `image_make`, `file_move`, `file_convert`, `file_print`, `file_pdf`, `file_trash`, `file_download`, `pc_screen`,
   `browser_hover`, `browser_upload`, `show_route`, `goal_delete` (`packages/mcp-tools/src/on-demand.ts`).
2. Two visible tools reach them, like `service_find` / `service_call` for service tools:
   - `tool_find` names all of them in its description, and returns one tool's full description and JSON input schema.
   - `tool_call({ tool, input })` checks the input against the same schema and runs **the same handler**. The daemon,
     the approval gate, the loop guard and the work log see the same call as before.
3. The engine treats `tool_call` as the tool itself (`unwrapToolCall`), so work steps, approval cards (file moves,
   printing, downloads) and records do not change. The eval scorer does the same.
4. Payment, approval, login and hand-off tools stay visible, so they are never a step away.

## Why

- Measured: the visible tool list went from about 153 KB to 107 KB (91 → 75 tools), about 30% less on every request.
- One extra call (`tool_find`) for a video or a PDF merge is cheap next to sending their schemas on every turn.

## Second round (2026-11-25)

The same count again (work log `turn` records, 2,798 turns, 2026-11-19 to 11-24, tool names only). The top 20 by
calls are `browser_click` (1,520), `service_call` (1,011), `service_find` (848), `browser_open` (795),
`conversation_search` (758), `browser_close` (581), `browser_read` (511), `browser_navigate` (446), `connect_ask` (412),
`file_find` (375), `browser_steps` (364), `goal_list` (266), `browser_screenshot` (257), `goal_create` (225),
`library_find` (185), `profile_view` (175), `show_list` (169), `browser_fill_profile` (168), `vault_find` (154) and
`show_cards` (152). These 18 more are kept aside:

| Group                      | Tools                                                                                                                                                                                                         | Calls in 6 days |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| PC app control             | `screen_status`, `screen_apps`, `screen_open`, `screen_read`, `screen_click`, `screen_type`, `screen_login`, `screen_key`, `screen_screenshot`, `screen_request_app`, `screen_request_approval`, `kakao_read` | 2 to 47 each    |
| PC files beyond finding    | `file_read`, `file_write`, `file_render`                                                                                                                                                                      | 18 to 31 each   |
| Sign-up and password reset | `browser_new_password`                                                                                                                                                                                        | 13              |
| Rarely used                | `feed_post`, `idea_suggest`                                                                                                                                                                                   | 0 and 6         |

- PC app control is its own kind of task: the AI first finds the app, then reads and clicks it. `tool_find("screen")`
  returns the whole `screen_` group in full in one call (a query that is the start of tool names brings that group),
  so the task costs one extra call, not one per tool. `screen_request_approval` goes with the group: it is only ever
  used after the other screen tools, so it is never a step further than they are.
- `file_find` stays visible and its description points to `file_read`. Writing and rendering files come after reading
  or planning, so one more call does not slow the first answer.
- `browser_new_password` is used only after the user chose to sign up or reset a password in the login card.
- Kept visible although rarely used: the browser's payment, approval, login and hand-off tools
  (`browser_checkout`, `browser_order_done`, `browser_request_*`, `browser_wait_auth`, `browser_login`,
  `browser_handoff`), the result blocks (`show_*`, the answer shape depends on them), sending a message
  (`phone_sms`, `kakao_send`), and tools other parts of Dool2 name in their own instructions (`feed_tell` for
  proactive checks, `goal_update` in `goal_create` results).

Measured with the test server (Dool2 tools only, no service tools): 76 → 58 visible tools, 108,185 → 91,811 bytes of
tool list (about 15% less on every request).

## Consequences

- Tasks with these tools take one more AI call (one per group for PC app control). If a tool turns out to be used often, move it back by removing it
  from `ON_DEMAND_TOOLS` (check the work log `turn` tool counts).
- Other tool descriptions and results still name hidden tools ("use image_make"); `tool_find`'s description says those
  names run through `tool_call`.
