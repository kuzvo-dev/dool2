# 0039. Service cards and connectors arrive as signed packs, without a new app version

- Status: Accepted
- Date: 2026-11-25
- Related: [0014 connect cards](0014-connect-cards.md), [0018 connectors](0018-service-connectors.md),
  [0028 signed app updates](0028-web-release-update.md), [0032 pinned instructions](0032-pinned-instructions.md),
  threat model T12

## Context

`skills/<id>/connect.json` (the card) and `tools.json` (the connector: tools, steps, inputs and outputs) for 109
services ship inside the app. When a site changes one screen, the fix waits for the next app release, and people stay
blocked until they install it. Not being blocked is the point of Dool2, and sites change every week: in the 14 days to
11-25, 65 of 454 commits touched `skills/`, and 13 of them changed nothing else.

`tools.json` is data, but its steps drive the user's signed-in browser. A swapped file could send that browser
anywhere, the same risk that retired the phone PWA (a server could swap the code). So whatever delivers it must be as
strict as the app update (ADR 0028). The approval gate does not live in skills (T12): a pack cannot let a payment or a
send skip approval, whatever it says.

## Decision

- **A pack is a full snapshot of `skills/`** (every `connect.json` and `tools.json`, `_template` left out), as one gzip
  JSON file. Its number is the Unix time of the last `skills/` commit. The packaged app records the same number for the
  `skills/` it carries (`skills-pack.json`, `scripts/package.mjs`), and takes a pack only when it is newer.
- **Signed like the app update, with its own key.** `pack.json` holds the manifest (number, oldest app version, bundle
  address, size, sha256) in base64 and an ed25519 signature. The key is apart from the app update key
  (`DOOL2_PACK_KEY`, CI secret only), and the app holds a list of public keys so the key can be changed later.
- **Never older.** The highest pack taken is remembered; an older or equal pack is not taken, nor one the user put back.
- **What an app cannot read falls back.** Every file is checked with the same schemas the app uses. A card or
  connector this app cannot read (a step kind it does not know yet, a broken file) is replaced by the one it came with,
  so an older app keeps its working version of that service. A pack that needs a newer app overall says so in `minApp`.
- **Taken without asking, put back in one press.** The daemon checks a minute after start and every 6 hours, writes the
  pack beside the others and switches the folder it reads (`Connectors` and `Skills` read through a function). The tool
  list a segment sees is pinned (ADR 0032), so a switch in the middle of a conversation does not change its tools; the
  next segment sees the new ones. Settings → Version shows which pack is in use and [Put back] returns to the cards that
  came with the app. `packChannel: off` stops automatic packs.
- **Test PCs first.** Every merge that changes `skills/` builds and signs a pack for test PCs (`pack-beta.json`,
  setting `packChannel: beta`). A maintainer gives it to everyone with the workflow's promote run (`pack.json`). Files
  live in the `connectors` release, a prerelease so it never becomes the "latest" release that the app update reads.

## Consequences

- A connector fix reaches everyone the same day, without an app release. Fixes that also need app code (a new step kind,
  the extension) still ship with the app; their connector files fall back on older apps until then.
- `docs/open-source.md` said skill updates would take effect after approval on the phone. The user asked for them to
  arrive on their own (11-25): they are signed, never older, cannot touch the approval gate, and can be put back.
- Next: notices and switches (a line at the top of the app, turning a setup choice off) in the same pack, the pack
  number in usage stats, and the persona text and login screen words as data (plan: exports PLAN.md stages 3 and 4).

## Alternatives

- **Phone approval for every pack**: safe, but people would leave fixes unapproved and stay blocked, which is the
  problem this solves. The signature and the never-older rule carry the safety instead.
- **Fetching single files from the repo (raw URLs)**: no signature, and a half-updated set of files could mix versions.
- **A per-tool `needs` list**: the schema check already refuses step kinds an app does not know, and falls back.
