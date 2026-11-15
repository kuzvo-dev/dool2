# Message
Chat messages: the user speaks in a black (ink) bubble on the right; 두리 speaks as plain text on the left, no bubble.

- 두리 messages have no container — that keeps the screen card-free and lets logs and approval cards sit inline.
- Show the 24px avatar + name + time only on the first message of a 두리 group. The avatar's mood follows the current state.
- User bubble: `ink` ground, `ink-inverse` text, `radius-lg` with a 6px bottom-right corner.
- Gap 12px within a speaker, 24px when the speaker changes.
- Text: `body` (15px) on PC, `body-lg` (17px) on mobile.
