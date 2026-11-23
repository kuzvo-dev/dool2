## What and why

<!-- Briefly describe what you changed and why. If there is a related issue, add "Closes #number". -->

## Screens

<!-- If the UI changes, attach a screenshot (desktop app: DOOL2_SMOKE=1 pnpm --filter @dool2/desktop smoke).
     If there is no UI change, summarize test results or run logs instead. Please hide personal data. -->

## Checklist

- [ ] `pnpm lint && pnpm build && pnpm typecheck && pnpm test` pass
- [ ] Every commit is signed off (`git commit -s`)
- [ ] Commit messages, PR title and body are in English
- [ ] User-facing copy matches the [persona](https://github.com/kuzvo-dev/dool2/blob/main/docs/persona.md) voice
- [ ] If this touches the approval gate, agent tool limits, or encryption, it is called out in the description
- [ ] If this adds a feature for people, Dool2 has a tool for it too (if not, the description says when the next PR will add it)
- [ ] If this changes how Dool2 decides things, the fix is in the tools (descriptions, input fields, results), not in global instructions
