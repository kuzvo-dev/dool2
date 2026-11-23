// Whether the running extension code matches the new code installed on disk (the build fingerprint of scripts/build.mjs).
// With the same version number Chrome does not read newly installed files and keeps running the old service worker (11-22: old code without tab tidying, so 72 tabs).
// If they differ it restarts itself (after a restart the new code on disk runs)

/** Whether to restart: only when both are known and differ (a dev build or a missing file is left as is) */
export function staleBuild(running: string | undefined, onDisk: string | undefined): boolean {
  if (!running || !onDisk || running === 'dev') return false
  return running !== onDisk
}
