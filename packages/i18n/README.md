# @dool2/i18n

Language and region for Dool2 ([ADR 0029](../../docs/decisions/0029-language-and-region.md)).

- **Language** (`ko`, `en`): which words the user reads. Until the user picks one, Korean when the region is Korea, else the device's OS language. The user picks
  one in Settings. Unshipped languages fall back to English.
- **Region** (`KR`, `JP`, `TW`): which services and local features make sense. The PC holds it. It is guessed from
  the locale and time zone on first run and confirmed on the setup screen.

The package is one file with no imports, so screens that load modules without a bundler can copy `dist/index.js`
next to themselves.

## Messages

```ts
import { messages } from '@dool2/i18n'

const m = messages({
  ko: { title: '연결', count: (n: number) => `${n}곳 연결됨` },
  en: { title: 'Connections', count: (n: number) => (n === 1 ? '1 connected' : `${n} connected`) },
})

m(lang).count(3)
```

- Korean is the reference copy and English must match it key for key. A missing key or a different parameter
  type is a type error.
- Put catalogs in a `locales/` folder next to the code that uses them (for example
  `packages/protocol/src/locales/connect.ts`). Korean is allowed there.
- Use `plural`, `list`, `formatMoney`, `formatNumber` and `formatDate` instead of building these by hand.
- Terms follow the [glossary](../../docs/i18n/glossary.md).

## Keeping Korean out of code

`pnpm lint` runs `scripts/check-hangul.mjs`. Files that still have Korean from before ADR 0029 are listed in
`scripts/hangul-baseline.json`. Changes to them only warn while they are being migrated. Any other file fails
on Hangul. After you move Korean out of a file, run `node scripts/check-hangul.mjs --update` to lower the
baseline.
