# Example screens

> **The v2 reference screens are in [`soft/`](soft)** (soft surfaces, 2026-11-15). Below are the v1 (dark, line-based) screens; where they differ from v2, v2 is the standard.

These are the actual screens made in the design tool. View them as images (PNG), and read exact values (color, size, spacing, corners) from the HTML in `src/`. The HTML is a design-tool frame (`<x-dc>`), so it does not open directly in a browser. Do not paste it into app code as is; move it into [`packages/ui`](../../../packages/ui) components.

Dark is the default, and light is the same screen with only the light theme swapped (the `theme` value in the HTML).

| Screen | Dark | Light | Source HTML | What it shows |
| --- | --- | --- | --- | --- |
| PC · one conversation + Dool2's screen | [pc-dark](pc-dark.png) | [pc-light](pc-light.png) | [PC.dc.html](src/PC.dc.html) | 3 columns: left menu, what is happening now, connected computer / center: one conversation / right: "Dool2's screen" (tasks in progress, what's next) |
| Mobile · chat | [m-thread-dark](m-thread-dark.png) | [m-thread-light](m-thread-light.png) | [MThread.dc.html](src/MThread.dc.html) | Dool2 speaks first, quick reply buttons, task cards in the chat, voice input in the composer, 4 bottom tabs |
| Mobile · talking by voice | [m-voice-dark](m-voice-dark.png) | [m-voice-light](m-voice-light.png) | [MVoice.dc.html](src/MVoice.dc.html) | Screen during a voice conversation: large character, waveform, what was heard, mute, view as text, end |
| Mobile · payment approval | [m-approve-dark](m-approve-dark.png) | [m-approve-light](m-approve-light.png) | [MApprove.dc.html](src/MApprove.dc.html) | Bottom-sheet approval card: amount question, name and value rows, approve with Face ID / I'll do it myself / decline |
| Mobile · tasks | [m-tasks-dark](m-tasks-dark.png) | [m-tasks-light](m-tasks-light.png) | [MTasks.dc.html](src/MTasks.dc.html) | Bar of what is happening now, approvals waiting for me, things Dool2 does on its own every day (toggle on and off), finished tasks |
| Mobile · explore | [m-explore-dark](m-explore-dark.png) | [m-explore-light](m-explore-light.png) | [MExplore.dc.html](src/MExplore.dc.html) | What Dool2 found (subscriptions, points, returns), requests delegated most this month, things it does on its own once turned on, things I must do myself |
| Mobile · my Dool2 | [m-me-dark](m-me-dark.png) | [m-me-light](m-me-light.png) | [MMe.dc.html](src/MMe.dc.html) | State of the home computer, what was done and time saved this week, services logged in, promises (it asks first before spending money) |

`MThreadLight.dc.html` is a frame that loads `MThread` in light.
