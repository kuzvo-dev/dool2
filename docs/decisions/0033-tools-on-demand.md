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

## Consequences

- Tasks with these tools take one more AI call. If a tool turns out to be used often, move it back by removing it
  from `ON_DEMAND_TOOLS` (check the work log `turn` tool counts).
- Other tool descriptions and results still name hidden tools ("use image_make"); `tool_find`'s description says those
  names run through `tool_call`.
