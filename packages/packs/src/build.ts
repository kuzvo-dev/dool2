/**
 * Filesystem helpers for building packs: read a directory tree into memory and
 * sign it. Kept apart from `pack.ts` so the core format stays free of `node:fs`
 * and can run anywhere; import this only on the signing side (a build script or
 * the release pipeline).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { type BuildPackOptions, buildPackFromFiles, type PackInput, type SignedPack } from './pack.js'

/** Read every file under `dir`, recursively, into a path → bytes map (forward slashes). */
export function readDirFiles(dir: string): PackInput {
  const files: PackInput = {}
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const abs = join(current, name)
      if (statSync(abs).isDirectory()) {
        walk(abs)
      } else {
        const rel = relative(dir, abs).split(sep).join('/')
        files[rel] = new Uint8Array(readFileSync(abs))
      }
    }
  }
  walk(dir)
  return files
}

/**
 * Build a signed pack from a directory on disk. Paths in the pack are relative
 * to `dir`. The private key is an ed25519 PEM string (from an env var or file).
 */
export function buildPack(dir: string, privateKeyPem: string, options: BuildPackOptions = {}): SignedPack {
  return buildPackFromFiles(readDirFiles(dir), privateKeyPem, options)
}

/**
 * Convenience: pack a skills directory (e.g. `@dool2/skills`'s `skills/`) for
 * distribution. Same as {@link buildPack} but defaults the pack name to
 * `skills`, so the file list looks like `gov24/SKILL.md`, `coupang/SKILL.md`.
 */
export function installablePack(
  skillsDir: string,
  privateKeyPem: string,
  options: BuildPackOptions = {},
): SignedPack {
  return buildPack(skillsDir, privateKeyPem, { name: 'skills', ...options })
}
