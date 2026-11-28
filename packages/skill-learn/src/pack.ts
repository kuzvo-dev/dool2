/**
 * Hand drafted skills to `@dool2/packs` to build a signed pack.
 *
 * Review-before-publish seam: a {@link DraftedSkill} carries `needsReview: true`.
 * A user may keep a draft locally and use it immediately for themselves (no
 * signing needed — see {@link toPackFiles}, which the daemon can write straight
 * into the user's local skills dir). Distribution to an org or the public goes
 * through the maintainer, who reviews the drafts and signs them into a pack with
 * their private key ({@link installablePack}). Signing *is* the publish gate.
 */

import { type BuildPackOptions, buildPackFromFiles, type PackInput, type SignedPack } from '@dool2/packs'
import type { DraftedSkill } from './draft.js'

/** Developer note describing the review seam (English; not user-facing copy). */
export const REVIEW_NOTE =
  'Drafted skills are usable locally by the author immediately; sharing to an org or the public requires the maintainer to review and sign them into a pack.'

/** Turn drafted skills into the `path -> bytes` map a pack is built from (`<id>/SKILL.md`). */
export function toPackFiles(drafted: DraftedSkill[]): PackInput {
  const files: PackInput = {}
  const encoder = new TextEncoder()
  for (const skill of drafted) {
    files[`${skill.id}/SKILL.md`] = encoder.encode(skill.markdown)
  }
  return files
}

/**
 * Build a signed, installable skills pack from drafted skills.
 *
 * The private key is an ed25519 PEM string the maintainer holds; it is never
 * embedded. The returned {@link SignedPack} verifies with `@dool2/packs`'
 * `verifyPack` against the matching public key and installs like the built-in
 * skills pack, so the library can grow without an app release.
 */
export function installablePack(
  drafted: DraftedSkill[],
  privateKeyPem: string,
  options: BuildPackOptions = {},
): SignedPack {
  return buildPackFromFiles(toPackFiles(drafted), privateKeyPem, { name: 'skills', ...options })
}
