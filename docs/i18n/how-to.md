# Moving Korean out of code

How to turn a file with Korean into English code plus locale files ([ADR 0029](../decisions/0029-language-and-region.md)).
Terms follow the [glossary](glossary.md).

## 1. Sort every Korean line into one of six kinds

| Kind | Example | Where it goes |
|---|---|---|
| **UI copy** (people read it on a screen or in a notification) | `'사용 통계를 보내도 될까요?'` | A locale file, in Korean **and** English |
| **Comment** | `// 창을 닫아도 트레이에 남는다` | Translate to English in place |
| **Text for the AI** (prompts, tool names/descriptions, tool results, errors the AI reads) | `'지역이나 가게 이름'` | Translate to English in place. The AI replies in the user's language |
| **Korean data the code matches** (text on Korean sites, Korean date words, phone/address formats) | `/로그인|로그아웃/` | A `region/kr/` module next to the code, keep the Korean |
| **Developer logs and thrown errors nobody sees in the UI** | `throw new Error('토큰이 없어요')` | English in place |
| **Tests and fixtures** | `expect(x).toBe('찾아보기')` | Leave as is. If the test checks UI copy, it now checks `ko` output, and add an `en` case when cheap |

When a string is shown to people **and** read by the AI (for example a tool result that is also displayed), keep the
AI part English and render the people part from a locale file.

## 2. Locale files

- Put catalogs in `locales/<area>.ts` next to the code. One catalog per screen or feature, not one giant file.
- Write Korean first (it is the reference copy, keep the existing wording exactly), then English.
- Use functions for anything with values: `count: (n: number) => \`${n}곳\``. Use `plural`, `list`, `formatMoney`,
  `formatDate` from `@dool2/i18n` for numbers, lists, money and dates.
- English copy follows the same voice as Korean: short, plain, friendly, result first. "Approve", not "allow". No
  competitor names. Brand and service names stay as they are.
- Do not change behavior. Only the source of the text changes.

```ts
// apps/desktop/src/renderer/locales/stats-ask.ts
import { messages } from '../i18n.js'

export const statsAsk = messages({
  ko: { title: '사용 통계를 보내도 될까요?', yes: '보낼게요' },
  en: { title: 'Send usage stats?', yes: 'Send' },
})

// renderer.ts
import { lang } from './lang.js'
const m = statsAsk(lang)
el('strong', 'ask-title', m.title)
```

## 3. Where the language comes from

| Runtime | Import | Language |
|---|---|---|
| Desktop window (`apps/desktop/src/renderer`, not bundled) | `from '../i18n.js'` or `'./i18n.js'` (copied file, see `i18n.d.ts`) | `lang` from `./lang.js`, settled from settings before the first render |
| Desktop main process (`apps/desktop/src/*.ts`) | `from '@dool2/i18n'` | `userLang(settings)` |
| Phone (`apps/phone`, bundled) | `from '@dool2/i18n'` | `lang` from `./lang.js` (the phone's own choice) |
| Extension (`apps/extension`, bundled) | `from '@dool2/i18n'` | `lang` from `./lang.js` |
| Daemon (`apps/daemon`) | `from '@dool2/i18n'` | `userLang(settings)` from `./lang.js` for text people read |
| Shared packages (`packages/protocol` and others) | `import type { Lang } from '@dool2/i18n'` only, plain objects for catalogs | Take `lang: Lang` as a parameter, default `'ko'` |

Shared packages must not import `@dool2/i18n` at runtime from files the desktop window copies (`connect-text`,
`rich`, `blocks`, `blocks-view`, `work-steps`, `schedule`, `ideas`, `paging`). Write the catalog as a plain object
typed with `import type`, so the copied file has no new runtime import.

Apps start in the language the user picked; otherwise Korean when the region is Korea, otherwise the device
language (`initialLang` in `@dool2/i18n`). To see English on a Korean machine, pick English in Settings or set
`language: "en"` (`PATCH /api/settings`).

## 4. Check

```bash
pnpm lint && pnpm build && pnpm typecheck && pnpm test
node scripts/check-hangul.mjs --update   # lower the baseline after cleaning files
```

A file you cleaned completely drops out of `scripts/hangul-baseline.json`, and from then on any Hangul in it fails CI.
