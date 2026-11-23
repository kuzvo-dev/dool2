# 0029. Language and region are separate settings; the repo is English, the product is multilingual

- Status: Accepted
- Date: 2026-11-23

## Context

Dool2 started Korean-only: the UI, the assistant persona, the service catalog, the docs and even some data
values are Korean. We now want users in Japan and Taiwan as well, and an open-source project that people
outside Korea can read and contribute to. Measured on 2026-11-23, about 27,000 lines in the repo contain
Hangul:

| Where | Lines with Hangul |
|---|---|
| String literals in code (UI copy, AI instructions, tool descriptions) | ~9,000 |
| Code comments | ~5,100 |
| Service catalog (`skills/*/connect.json`, `tools.json`) | ~7,100 |
| `docs/` (incl. ADRs) | ~2,300 |
| `evals/` | ~1,400 |

There is no i18n library; copy is inline. One data value is Korean too: the approval tier enum
(`'찾아보기' | '채워 두기' | '돈 내기' | '연락하기'`), used 795 times in `tools.json` and stored on users' PCs.

Two things are easy to mix up and must not be:

- **Language** decides which words the user reads and the assistant speaks.
- **Region** decides which services, identity checks, currencies and local apps make sense.

A Korean living in Tokyo wants Korean words and Japanese services. A visitor in Seoul may want English words and
Korean services.

## Decision

### 1. Two independent settings

- `language`: `ko` | `en` now; `ja` and `zh-TW` next. BCP 47 tags.
- `region`: `KR` now; `JP` and `TW` next. ISO 3166-1 alpha-2. Services that work everywhere are `global`.
- On first run both are guessed from the device (OS language; region from OS locale, then time zone) and shown
  on the setup screen so the user can change them. Both can be changed later in Settings.
- The PC holds the user's `region`. Each device (PC app, phone app, extension) shows its UI in its own
  `language` setting. Until the user picks one, the default is **Korean when the region is Korea** (a Korean PC
  with an English OS still starts in Korean), **otherwise the device's OS language**, falling back to English.
  The desktop app saves the language it settled on at first run, so the daemon and the phone agree.
  The assistant answers in the language the user writes in.
  (Amended 2026-11-23: the Korea rule protects existing Korean users on English OSes.)

### 2. The repository is English

- Code, comments, identifiers, log messages for developers, docs, ADRs, commit messages, PR titles and bodies,
  and issue templates are written in English from this ADR on.
- Existing Korean docs are translated. The Korean originals move to `docs/ko/` as a frozen archive. They are not
  kept in sync. `README.md` becomes English, and the Korean README becomes `README.ko.md`.
- Korean stays where it is **data**: Korean copy in locale files, Korean service cards, fixtures that test Korean
  pages, and Korean eval scenarios.

### 3. User-facing copy goes through `@dool2/i18n`

- A small in-house package (typed keys, plural rules, `Intl` for dates, numbers and money). The UIs are
  framework-free TypeScript in three runtimes (Electron, Capacitor, Chrome extension), so a typed dictionary is
  lighter than a framework. The extension's name and store text use Chrome's `_locales/` as Chrome requires.
- **Korean is the reference copy** for now because it is the most-used and most-polished version. English must
  be complete: a missing key fails CI. Other languages fall back to English.
- A CI check fails when Hangul appears outside the allowed places (locale files, `region/kr` code, Korean service
  cards, marked test fixtures, `docs/ko/`, Korean evals). That keeps new inline Korean from creeping back.
- Copy rules apply in every language. Use plain, real-world words (say "approve", not "give permission"). No
  competitor product names.

### 4. Stable English keys for data

- Approval tiers become `lookup` | `fill` | `pay` | `contact` (`찾아보기`, `채워 두기`, `돈 내기`, `연락하기`).
  Labels come from the locale files. `pay` and `contact` still require phone approval.
- Stored values are migrated on first start of the new version. Old values are still accepted when read, for one
  minor release.
- Any future enum shared between packages uses English keys.

### 5. The AI layer

- System prompts, tool names and tool descriptions are English. The prompt tells the assistant to reply in the
  user's language for that request.
- The persona is written once per language (`docs/persona/ko.md`, `docs/persona/en.md`, ...). It is not a word-for-word
  translation. The character (dependable, warm, a little witty, honest, serious about money and messages) stays
  the same, and the voice is native to each language.
- Judging pages (logged in or not, which button to press, whether the task is done) moves from Korean keyword
  rules to the model looking at the page. Keyword lists remain only as safety rails, kept per language.

### 6. The service catalog is regional

- `connect.json` gets `regions` (for example `["KR"]` or `["global"]`) and `lang` (the language its text is
  written in). Translations go in an optional `i18n` map of partial overrides: `{ "en": { "name": ..., "summary": ... } }`.
  Existing cards are `regions: ["KR"]`, `lang: "ko"`.
- The connect screen first lists services for the user's region plus `global`. "Other regions" shows the rest.
- Brand names are not translated (Coupang stays Coupang). Romanized names go in `i18n.en.name`.

### 7. Region-specific features are modules

- Korean identity checks, joint certificates, KakaoTalk PC, Hangul (HWP) files, Gov24 and similar live under
  `region/kr` in the package that owns them. The core must run without any region module. Japan and Taiwan modules
  go in the same place later.

### 8. Name

- The product is **Dool2** in every language except Korean, where it stays **두리**. The repo, packages and
  domains stay `dool2`.

## Why

- Splitting language from region is the only model that is right for both expats and travelers. Mixing them
  forces one of the two to fight the app.
- An English repo is the norm for open source. Contributors from Japan and Taiwan, our next markets, read
  English far more often than Korean.
- Keeping Korean as the reference copy protects the quality of the current product while English catches up.
  The CI checks make the cost of a missing translation visible right away, instead of letting it pile up.
- English keys for data remove the riskiest kind of Korean: values that code compares against.
- Other options considered:
  - Translate everything in place with no archive. This was rejected because Korean history and context would be lost.
  - Adopt i18next. This was rejected for now because it adds weight to three runtimes for features we do not need yet.
    We can revisit this if we need ICU message syntax at scale.
  - Make English the reference copy now. This was rejected because English copy is not yet as tested as the Korean copy.

## Consequences

- Rollout order: repo docs and rules → English data keys → `@dool2/i18n` and string extraction per app → AI layer
  → regional catalog → region modules → landing, legal, store listings → English evals. Then `ja` and `zh-TW`.
- Every UI PR now touches locale files in at least `ko` and `en`.
- Contributors who only write Korean can still add Korean service cards and Korean copy. Maintainers fill
  in the English.
- Revisit this ADR when a third language ships (fallback chain, reference copy) or when a region needs per-user
  service sets beyond `regions`.
