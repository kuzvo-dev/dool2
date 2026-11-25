// Connector packs (ADR 0039): where the signed packs come from and the key that checks them. The private key lives
// only in the CI secrets (DOOL2_PACK_KEY, .github/workflows/packs.yml), apart from the app update key.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Public keys that may sign connector packs (a list, so the key can be changed without breaking older apps) */
export const PACK_PUBLIC_KEYS = [
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAZ7IbNgRJjx2T33/zqpMaXqRxekwnxEq+fS9u263RHu8=
-----END PUBLIC KEY-----`,
]

const BASE = 'https://github.com/kuzvo-dev/dool2/releases/download/connectors'
/** Everyone's packs */
export const PACK_FEED = `${BASE}/pack.json`
/** Test PCs get each pack first (setting packChannel: beta) */
export const PACK_FEED_BETA = `${BASE}/pack-beta.json`

/**
 * Pack option for the daemon. The packaged app reads the number of the cards it came with (skills-pack.json, written
 * by scripts/package.mjs). DOOL2_PACK_FEED points a development build at a test feed
 */
export function packOption(
  packaged: boolean,
  resources: string,
): { packs?: { feed: string; betaFeed: string; publicKeys: string[]; bundledPack: number } } {
  const testFeed = process.env.DOOL2_PACK_FEED
  if (!packaged && !testFeed) return {}
  let bundledPack = 0
  try {
    const n = (JSON.parse(readFileSync(join(resources, 'skills-pack.json'), 'utf8')) as { pack?: unknown })
      .pack
    if (typeof n === 'number' && Number.isInteger(n)) bundledPack = n
  } catch {}
  return {
    packs: {
      feed: testFeed ?? PACK_FEED,
      betaFeed: testFeed ?? PACK_FEED_BETA,
      publicKeys: PACK_PUBLIC_KEYS,
      bundledPack,
    },
  }
}
