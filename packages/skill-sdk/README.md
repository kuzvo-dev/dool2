# @dool2/skill-sdk

The skill system core. Site knowledge in Dool2 lives as skills (a `SKILL.md`
file plus functions), delivered as signed resource packs. This package parses a
skill's frontmatter and resolves **which** site skills to auto-inject into a
turn, so only the relevant one reaches the brain instead of the whole library.

It is pure and dependency-free: no network, no filesystem in the core. The
optional directory loader lives behind the `./loader` entry point.

## What it does

| Export                                                   | Description                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseSkillMarkdown(md)`                                 | Parse a `SKILL.md` string into `{ frontmatter, body }`. Typed frontmatter: `name`, `description`, `site?`, `autoInject? { url?, keywords? }`, `regions?`, `disabled?`, `login? { username?, password?, submit?, totp? }`. Tiny built-in YAML-subset parser (no dependency). |
| `resolveSkills(input, skills, options?)`                 | Score each skill by URL glob match on the tab URL and by whole-word keyword match in the user's message, returning the matches sorted by score with the reasons.                                                                                                            |
| `urlMatchScore` / `keywordMatchScore`                    | The two scoring helpers, usable on their own.                                                                                                                                                                                                                               |
| `matchUrlGlob(url, pattern)`                             | URL-glob matcher: `*.gov.kr`, `coupang.com/np/*`, `coupang.com/*`.                                                                                                                                                                                                          |
| `tokenize(text)`                                         | Hangul-aware word tokenizer used by the keyword matcher.                                                                                                                                                                                                                    |
| `loadSkillsFromDir(dir)` (via `@dool2/skill-sdk/loader`) | Scan `<dir>/<id>/SKILL.md` and return parsed skills.                                                                                                                                                                                                                        |

## Keyword matching (Korean-first)

Korean writes a phrase without internal spaces and fuses particles and verb
endings onto a word (a stem keyword followed by a Korean ending becomes one
token). The matcher tokenizes on non-letter/digit boundaries, then accepts a
keyword when it is a whole token, or when it is the **start** of a token whose
next character is Hangul (a particle or ending). So a payment stem matches even
when an ending is fused onto it, while a Latin keyword stays a strict whole word
(`pay` does not match inside `payment`), and a keyword that appears only in the
middle of a bigger token does not falsely match. The exact Korean examples live
in the resolver tests.

## How the daemon uses it later

On each turn the daemon calls `resolveSkills({ url, message }, skills)` with the
active tab URL and the user's message. The top match's `SKILL.md` body is
injected into the turn's context (its tips and block map), and its functions
become available to the `code` tool. Skills that do not match are never loaded,
keeping the prompt small. Korean keyword lists are **data** and live in each
skill's frontmatter, not in this package's code.

## The `login` block (vault field hints)

A skill may name the fields to fill for a login on its site:

```yaml
login:
  username: # role+name hint
    name: 아이디
    role: textbox
  password: 비밀번호 # bare string == { name: 비밀번호 }
  submit: # clicked after the fields are filled
    name: 로그인
    role: button
  totp: # the one-time-code field, when the site asks for one
    name: 인증번호
    role: textbox
```

Each field is either a `selector` (a robust CSS selector or snapshot ref, used
as-is) or a role+name hint (`name` is the visible/accessible label — Korean
names are data and belong here, not in a locale, per ADR 0029). A bare string is
shorthand for `{ name }`. Only `password` is required for a fill.

The **vault** (daemon-side, `apps/agentd`) reads these hints for the skill that
matches the real tab URL, locates the fields on the page's accessibility
snapshot, and types the stored secret straight in — the AI never sees the
password, TOTP seed or code. The fill still passes URL binding (the login fills
only on its own site, over http(s)) and the account's agent-access policy.

**Data path first.** Prefer a login through the site's own API under the user's
live session (the `page.fetch` data path, ADR 0046) when one exists; the UI
`login` fill here is the fallback for sites that only offer a form. Human steps
(간편인증 / 공동인증서 / CAPTCHA) are always handed off to the person — the vault
fills only machine fields, never those.
