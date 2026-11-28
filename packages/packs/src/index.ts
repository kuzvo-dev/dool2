/**
 * @dool2/packs
 *
 * Build and verify signed resource packs. Site knowledge (skills) ships as
 * downloadable packs, apart from the app and with no store review, so the skill
 * library can grow daily. A pack is a signed manifest (one sha256 + size per
 * file, an app-version window, and an ed25519 signature over the manifest) plus
 * the file blobs; verifying re-checks the signature and re-hashes every blob.
 *
 * `node:crypto` only, no other dependencies. Private keys are never embedded:
 * the signer passes a PEM string in. The core format (`./pack`) is
 * filesystem-free; `buildPack`/`installablePack` read from disk; the install
 * seam (`./install`) is the daemon-side download/verify/unpack contract.
 */

export { buildPack, installablePack, readDirFiles } from './build.js'
export {
  type InstallResult,
  installPack,
  type PackInstaller,
  type PlannedFile,
  planInstall,
} from './install.js'
export {
  type BuildPackOptions,
  buildPackFromFiles,
  canonicalJson,
  compareVersions,
  PACK_ALG,
  PACK_FORMAT,
  type PackFileEntry,
  type PackInput,
  type PackManifest,
  type PackVerifyResult,
  type SignedPack,
  unpackToFiles,
  type VerifyPackOptions,
  verifyPack,
} from './pack.js'
