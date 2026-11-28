// Identity seam: the boundary where a company's SSO/SCIM identity becomes a Dool2 member. This file is a seam, not an
// implementation — it defines the `IdentityProvider` interface that real OIDC/SAML/SCIM providers implement later,
// plus a pure `mapScimUser` that turns a SCIM user record into a Dool2 `Member`, and a `StaticIdentityProvider` for
// tests. No real auth flow lives here (master plan workstream H: "real SSO providers ... come later").

/** A Dool2 member: the identity the daemon keys policy, vault sharing and the audit log on. */
export interface Member {
  /** Stable unique id for the member (from the IdP's SCIM `id` or `externalId`). */
  memberId: string
  /** Primary email. Used for display and for matching the member to their accounts. */
  email: string
  /** Group names the member belongs to. Drives shared-vault access (see `vault-share.ts`) and policy targeting. */
  groups: string[]
  /** The org the member belongs to. */
  orgId: string
}

/**
 * A subset of a SCIM 2.0 User resource (RFC 7643) — the fields that matter for mapping to a Dool2 member:
 *   - `id` / `externalId`: the stable unique identifier → `memberId` (at least one is required).
 *   - `emails`: the primary email (or the first one) → `email` (required).
 *   - `groups`: the member's groups → `groups` (`display` preferred over `value`, order preserved).
 *   - `userName`, `active`: carried for context; real provisioning uses `active` for deprovision.
 * A real provider receives the full SCIM payload; this shape is only what the mapper reads.
 */
export interface ScimUser {
  id?: string
  externalId?: string
  userName?: string
  emails?: { value: string; primary?: boolean }[]
  groups?: { value?: string; display?: string }[]
  active?: boolean
}

/** Inputs the SCIM record does not carry but the member needs. */
export interface MapScimOptions {
  /** The org the mapped member belongs to (the daemon knows this from the connection, not the SCIM record). */
  orgId: string
}

/** Pick the member's email: the primary one if flagged, otherwise the first. */
function pickEmail(user: ScimUser): string | undefined {
  const emails = user.emails
  if (!emails || emails.length === 0) return undefined
  const primary = emails.find((e) => e.primary)
  return (primary ?? emails[0])?.value
}

/**
 * Map a SCIM user record to a Dool2 `Member`. Pure.
 *
 * Required: a stable id (`id` or `externalId`) and an email; a missing one throws. Groups are preserved in order,
 * taking each group's `display` when present, else its `value`; groups without either are dropped.
 */
export function mapScimUser(user: ScimUser, options: MapScimOptions): Member {
  const memberId = user.id ?? user.externalId
  if (!memberId) {
    throw new Error('mapScimUser: SCIM user is missing a stable id (id or externalId)')
  }
  const email = pickEmail(user)
  if (!email) {
    throw new Error('mapScimUser: SCIM user is missing an email')
  }
  const groups = (user.groups ?? [])
    .map((g) => g.display ?? g.value)
    .filter((name): name is string => name !== undefined)
  return { memberId, email, groups, orgId: options.orgId }
}

/**
 * The seam real identity providers implement. A provider verifies an SSO assertion or reads SCIM and resolves the
 * matching Dool2 member. `resolve` is async because real providers reach the network; it returns `undefined` when no
 * member matches. Implementations (OIDC, SAML, SCIM) are added later outside this package.
 */
export interface IdentityProvider {
  /** A short name for logs and the admin console, e.g. `okta`, `entra`, `static`. */
  readonly name: string
  /** Resolve the member for a verified subject (an SSO subject id or SCIM id). `undefined` if unknown. */
  resolve(subject: string): Promise<Member | undefined>
}

/** A fixed, in-memory `IdentityProvider` for tests and local development — no network, no real auth. */
export class StaticIdentityProvider implements IdentityProvider {
  readonly name = 'static'
  private readonly members: Map<string, Member>

  /** Seed with `subject → Member` entries (a Map or an array of pairs). */
  constructor(entries: Iterable<readonly [string, Member]>) {
    this.members = new Map(entries)
  }

  async resolve(subject: string): Promise<Member | undefined> {
    return this.members.get(subject)
  }
}
