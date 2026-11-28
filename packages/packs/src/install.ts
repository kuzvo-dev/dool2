/**
 * The install seam: where the daemon downloads a pack, verifies it and unpacks
 * it into the data dir so the extra skills sit next to the built-in ones.
 *
 * This module defines the contract only. The daemon supplies the network and
 * filesystem (`download`, `writeFiles`); the verification and the plan of what
 * to write are pure and live here, so the trust boundary (signature + sha256 +
 * version gate) is enforced in one place and is testable without a network or a
 * disk. The flow is always: download → {@link verifyPack} → {@link planInstall}
 * → write. A pack that fails verification is never written.
 */

import { type PackVerifyResult, type SignedPack, unpackToFiles, verifyPack } from './pack.js'

/** One file the daemon should write, relative to the skills root in the data dir. */
export interface PlannedFile {
  /** Forward-slash path relative to the install root, e.g. `gov24/SKILL.md`. */
  path: string
  /** The file's bytes. */
  bytes: Uint8Array
}

/**
 * Turn a verified pack into the list of files to write. Call {@link verifyPack}
 * first; this assumes the pack already verified and just decodes its blobs.
 */
export function planInstall(pack: SignedPack): PlannedFile[] {
  const files = unpackToFiles(pack)
  return Object.keys(files)
    .sort()
    .map((path) => ({ path, bytes: files[path] as Uint8Array }))
}

/**
 * The daemon-side interface for taking a pack. The daemon implements
 * `download` (HTTPS GET of the signed pack) and `writeFiles` (atomic write into
 * `<dataDir>/skills`). Implementations MUST call {@link verifyPack} with the
 * pinned public key, and MUST NOT write anything when verification fails.
 */
export interface PackInstaller {
  /** The pinned public key(s) the installer verifies against (ed25519 PEM). */
  readonly publicKeys: string[]
  /** Download the signed pack bytes from an https URL. */
  download(url: string): Promise<Uint8Array>
  /** Write the planned files into the install root under the data dir. */
  writeFiles(root: string, files: PlannedFile[]): Promise<void>
}

/** The outcome of an install attempt. */
export type InstallResult = { ok: true; written: number; pack: number } | { ok: false; why: string }

/**
 * Reference install flow built on a {@link PackInstaller}. Verifies against each
 * pinned public key, then writes. Kept here as the one correct ordering; the
 * daemon may inline it, but must keep verify-before-write.
 */
export async function installPack(
  installer: PackInstaller,
  pack: SignedPack,
  root: string,
  appVersion?: string,
): Promise<InstallResult> {
  let last: PackVerifyResult = { ok: false, why: 'no public keys configured' }
  for (const key of installer.publicKeys) {
    last = verifyPack(pack, key, appVersion !== undefined ? { appVersion } : {})
    if (last.ok) break
  }
  if (!last.ok) return { ok: false, why: last.why }
  const files = planInstall(pack)
  await installer.writeFiles(root, files)
  return { ok: true, written: files.length, pack: pack.manifest.pack }
}
