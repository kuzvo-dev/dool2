# 0042. Recipes: keep the steps that got a request done, and offer them on the next request like it

- Status: Accepted
- Date: 2026-11-26
- Related: [0034 remembered routes](0034-remembered-routes.md), [0031 quick checks](0031-quick-check-watch.md),
  [0033 tools on demand](0033-tools-on-demand.md), [0038 task sessions](0038-task-sessions.md),
  [0027 finish check](0027-finish-check.md)

## Context

People ask Dool2 for the same kinds of things again and again: "when does my Coupang order arrive", "what's on my
card this month", the same booking site every week. Each time, the AI works the job out from scratch: it looks the
service tool up (`service_find`), reads its inputs, calls it, and picks how to show the result.

The work log on the maintainer's PC (2,821 turns, 2026-11-19 to 11-25) shows how much repeats. It records tool names
only, never what was asked or the inputs, so this counts identical tool sequences, not identical requests:

- Of 1,807 turns with three tool calls or more, 448 had exactly the same tool sequence as an earlier turn.
- The most common sequences all start with a lookup: `service_find → service_call → show_cards` (22 turns, 16 s at
  the median), `service_find → service_call → service_call → show_cards` (8 turns, 27 s).
- `service_find` was called 848 times in 6 days. On a request the person made before, that call and the AI round
  trip after it find nothing new.

Remembered routes (ADR 0034) already cut the AI round trip between clicks on a known site path. They work inside one
site and stop at the first typed word. Nothing kept how a whole request got done.

## Decision

1. **Gather the steps of a request.** From the person's message (or a task's start) to the answer that ends it, the
   daemon keeps each tool call as a step (`apps/daemon/src/recipes.ts`):
   - a `service_call` is kept as the service tool it called;
   - short inputs (up to 40 characters, at most 6 fields) are kept; message text, recipients, passwords, codes, card,
     account and phone fields are never kept, nor values that look like a phone, card or account number or an email.
     Dates and times are kept (they show the format a tool takes);
   - `browser_open` / `browser_navigate` keep only host + path (no query, no path with member numbers); other browser
     and PC app actions keep only their kind, since they point at refs that change each time; `browser_route` keeps its
     route id;
   - looking tools up, reading, remembering and the answer's shape are not steps (`service_find`, `tool_find`,
     `browser_read`, `memory_*` …); the last `show_*` is kept as the last step;
   - calls that failed are dropped; repeats in a row fold into one step (`browser_click ×3`).
   A request that is sent back by the finish check or waits for the person (approval, sign-in) goes on over several
   turns, and its steps keep gathering.
2. **Keep the steps of a request that ended done**: answered, not waiting for the person, not sent back, not failed,
   not stopped short by the finish check, not handed to a task (the task keeps its own). Steps worth keeping are two or
   more, or one service tool the AI had to look up. The same tools in the same order on the same sites are one recipe;
   its inputs and the person's words are refreshed (last 3 requests). Kept in `recipes.json` in the data folder, up to
   60 recipes, the least recently used first out.
3. **Offer after twice.** A recipe that got requests done twice (`MIN_OK`) is ready. When the person's message reads like
   one of its requests (shared character pairs, so Korean works without splitting words; `MIN_LIKE` 0.34), up to 2
   recipes ride on that message for the AI (the same `aside` that carries ended tasks), with their steps and inputs.
   A new task gets the recipes that match its title and goal in its first message.
4. **The AI decides.** The note says the steps come from what was done before, not rules: follow one if it fits, change
   the inputs to this request, skip looking tools up again, and work as usual where it does not fit. Nothing is run
   for the AI in this step.
5. **Adapt.** A recipe offered on a request counts as followed when the request ends done with its steps. A failing
   step of an offered recipe counts against it (once per request); one that fails 3 times and more often than it
   worked is forgotten. A recipe that keeps getting things done stays and is refreshed.
6. **Measure.** The work log gets `recipe` records: `offered` (how many on a message), `done` (time from the request to
   its end, tool calls, steps kept, how many times the steps had got a request done before, whether a recipe was
   offered and followed) and `forgot`. `pnpm report:harness` shows time and tool calls per request for new steps, steps
   seen before and requests with a recipe offered.
7. **Only on this PC.** Recipes never leave the PC; usage stats are unchanged. The `recipes` setting set to `false` stops
   offering.

## Why

- It removes the part of a repeated request that finds nothing new (the lookup and the AI round trip after it) without
  changing the agent program, the tool list or the approval gate.
- It learns from what each person does, so it gets faster for what that person asks often, on services no one wrote a
  shortcut for.
- The AI still judges each request (a hint, not a script), so a recipe that does not fit costs a few lines, not a wrong
  action.
- Other options:
  - Replaying the steps without the AI (`recipe_run`). Faster again, but it needs the inputs mapped to the new request
    and a rule for when to stop. It comes after the numbers from this step show recipes are followed.
  - Putting recipes in the pinned instructions. They change as recipes are kept, which would break the cache (ADR 0032);
    on the message they change nothing else.
  - Sharing recipes between people to seed new users. Left out: it would send sites and steps off the PC.

## Consequences

- Messages that match a recipe carry a few more lines (2 recipes at most).
- `recipes.json` holds the person's last words for each recipe (up to 120 characters each), short tool inputs and site
  paths, on this PC only. Threat model T30.
- A recipe can be offered on a request that reads alike but is not the same; the AI judges, and a step that fails counts
  against the recipe.
- Revisit when the work log shows how often recipes are offered and followed and how much time requests with one take.
  Next steps: a screen to see and delete recipes, inputs as slots in remembered routes (search words), and running a
  recipe's lookup steps without the AI.
