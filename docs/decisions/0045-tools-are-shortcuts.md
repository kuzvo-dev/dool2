# 0045. Dool2 thinks for itself: broad hands, tools as shortcuts, safety at the action

- Status: Accepted
- Date: 2026-11-27
- Related: [0003 Dool2 tools only](0003-dool2-tools-only.md), [0027 finish check](0027-finish-check.md),
  [0040 instructions as files](0040-instructions-as-files.md), threat model T1, T2, T3, T20, T31, T32

## Context

On the test PC (11-27) Dool2 gave up on a family certificate PDF. It gave up the same way on Sonnet and on Opus, so
the model was not the cause. The tool layer was:

- **A tool's error text told it to stop.** `browser_save_pdf` said "tell them you will save it once the extension
  updates", and `file_find` says "do not try other ways".
- **One missing action blocked the whole request.** Printing a page to PDF needed a new extension version, and that
  version waits days for store review.
- **Fixed lists capped what it could try.** The PC key tool takes only a dozen keys, so the print shortcut could not
  be pressed.
- **The retry limit cut it off** while the judge still named an untried way (fixed in #622).

The maintainer's direction: Dool2 should keep trying until there is really no way, without becoming slow. Tools
should not be Dool2's limits. A Dool2 that can do only what its tools spell out is a fixed chatbot, not an AI that
thinks for itself. Tools are there to make it faster.

ADR 0040 and AGENTS.md said "fix by sharpening tools". That kept the global prompt small, which stays right. But it
also grew narrow tools whose texts decide for the AI, and each gap became a new release.

## Decision

1. **Broad hands as the base.** Dool2 gets a few general capabilities and works out its own way with them:
   - **Reading and producing from a page, without acting** (`browser_eval`, `browser_cdp`, extension 0.3.4):
     - `browser_eval` runs JavaScript on a tab Dool2 opened. Chrome evaluates it side-effect free
       (`Runtime.evaluate` with `throwOnSideEffect`), so it can read and compute anything on the page but cannot
       click, type, submit, change the page or call the network.
     - `browser_cdp` calls Chrome DevTools methods from a fixed list of ones that only read or produce: print to
       PDF, save the page as an archive, full-page capture, the accessibility tree, the resources the page already
       loaded. Large results are saved as files in Dool2's folder.
     - A missing "save as X" or "read Y" no longer waits for a release.
   - **Code in a sandbox** (`code_run`): JavaScript in a WebAssembly engine with no access to the PC, the network
     or secrets, with time and memory limits. For computing, converting and shaping data when no tool does it.
     Its output goes back to the AI, and files are made with `file_write`.
   - **Pressing what it sees** (`browser_click` with `at`): a spot on the screenshot (0-1000), for icons in a
     document viewer, drawn screens and other sites' frames that reading cannot mark. What is at the spot is
     measured first with the side-effect-free evaluation, so pay, send and delete buttons still go to approval and a
     print button still goes to the print path.
   - **A site's own print, saved as a PDF** (`browser_save_pdf` with `print`, or `browser_click` on a print
     button): Dool2 presses the site's print button, and the daemon's Mac helper picks "Save as PDF" in Chrome's print
     window and saves into Dool2's folder. Certificates and receipts are printed the way the site lays them out,
     not captured from the screen. Chrome stays refused to the AI's own PC hands (T20); this one fixed sequence is
     the daemon's, and it only chooses the PDF destination and the save place (no printer, nothing sent out).
   - **Wider PC keys** (`screen_key`): letters, digits and function keys with modifiers in allowed apps. Combos
     that delete or quit are refused.
2. **Tools are shortcuts.** Service tools (connectors), lookups and recipes stay the fast path. They are tried first,
   and when one fails Dool2 falls back to the broad hands instead of stopping. A shortcut that fails says what
   happened, not what to give up.
3. **Tool results state facts, not verdicts.** A result says what happened, why, and what is possible next. It does
   not say "stop", "do not try other ways" or "tell the user to do it". The only orders a tool gives are the safety
   ones: approvals, hand-offs for CAPTCHAs and identity checks, never typing secrets. A test keeps such phrases out
   of tool texts.
4. **Safety sits at the action, not at the capability.** Paying, contacting people, deleting, sending out and signing
   up go through the approval gate exactly as before (T2, T3, T25). Secrets never reach the AI (T15, T22). The new
   hands cannot act on a page (side-effect-free evaluation and a read-only DevTools list), cannot reach the PC or the
   network (sandbox), and cannot press destructive key combos. The agent's own shell, file and web tools stay off
   (T1).
5. **Speed is measured, not assumed.** Shortcuts run first, so common requests stay as fast. Keeping at it applies to
   tasks (conversation answers stay one reply, ADR 0027). Each step is checked on the test PC with the failed
   scenarios, before and after: how often Dool2 gave up and how long it took.

ADR 0040 still holds for where the instructions live and for keeping the global prompt small. The AGENTS.md line
"fix by sharpening tools" becomes: first ask what would let Dool2 find its own way (a broad hand or a fact in a result);
add a narrow tool when it makes a common path faster.

## Why

- The failures were in the tool layer, and a bigger model did not help.
- Broad but non-acting hands keep the same safety model: the AI can still be fooled, so code decides what may act.
  Side-effect-free evaluation is enforced by Chrome's V8, not by pattern matching on the script. The sandbox is a
  separate WebAssembly engine with nothing of the host passed in.
- Other options considered:
  - **Turn the agent's own shell back on.** Rejected: it bypasses the gate and the work log (T1).
  - **Let page scripts act** (click and submit from JavaScript). Rejected: a script could press a payment button
    without the gate (T3).
  - **Keep adding narrow tools.** Rejected as the main way: each gap waits for a release, and narrow texts decide for
    the AI.

## Consequences

- Extension 0.3.4 carries `eval` and `cdp`; until the store copy updates, the tools say the extension is older and
  Dool2 uses the other ways.
- `code_run` adds a WebAssembly JavaScript engine to the daemon (`quickjs-emscripten`, pinned in the lock file).
- Tool texts are rewritten where they decided for the AI. Domain tips stay in tool and card descriptions.
- Revisit if the test PC shows the broad hands being slower than the shortcuts they replace, or if a way to act
  through them is found (then the list or the evaluation mode is tightened and T31 or T32 updated).
