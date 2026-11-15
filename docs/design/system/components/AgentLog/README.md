# AgentLog
A running, monospaced list of what 두리 actually did, one row per action — it replaces spinners and "생각 중…".

- Row = status icon · **site or verb** + detail · time. Done rows are quiet (`ink-muted`, ink check), the live row sits on `brand-soft` with a slowly rotating mint arc, a waiting-for-you row sits on `butter-soft`.
- Always name the real domain (`letskorail.com`, `coupang.com`) — it is the proof the work happens on the user's own computer.
- Collapsed by default inside a chat message (show the live row only); expanded in the PC right panel.
- Uses `log` (JetBrains Mono 12.5px). Consumer loads JetBrains Mono from Google Fonts.
