# 0007. Finish the PC side first and attach the phone last

- Status: Accepted
- Date: 2026-11-14

## Context

Dool2 has two sides: the phone (requests and approvals) and the PC (execution). Building both at once would need the relay, pairing and encryption all together, which would delay verifying the part that actually "gets the job done".

## Decision

The order is: install and first setup (M1) → browser (M2) → approval gate (M3) → PC control and skills (M4) → distribution (M5) → phone and relay (M6).

Until the phone is attached, the desktop app's screen stands in for the phone. Requests are made in the PC window, and approvals are also taken on the PC screen.

## Why

- Dool2's value (its moat) is the PC-side ability to carry Korean services through to the end. That has to be proven first.
- The phone link can be added later on top of the same protocol in `packages/protocol`.

## Consequences

- The approval gate is first built as approval on the PC screen and is replaced with a phone signature in M6. The gate interface is designed on the assumption of this swap.
- Until M5, only developers can try it.
