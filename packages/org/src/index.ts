// @dool2/org — enterprise foundations: the model and pure logic for organization policies, audit-log export, and the
// SSO/SCIM identity + shared-vault seams. Everything here is pure (no network, no I/O) and testable. Real SSO
// providers and the admin console are built on these seams later (master plan workstream H).
//
//   policy.ts       OrgPolicy (MDM-deliverable) + applyOrgPolicy; clamps the per-user autonomy gate, intersects caps,
//                   forces approval tiers, checks sites.
//   audit.ts        AuditEvent (append-only) + exportAudit (jsonl/csv) with a redactor so no secret leaves the box.
//   identity.ts     IdentityProvider seam + mapScimUser + StaticIdentityProvider; real OIDC/SAML/SCIM come later.
//   vault-share.ts  VaultShareRule + canGroupUse for org-shared vault items.
export * from './audit.js'
export * from './identity.js'
export * from './policy.js'
export * from './vault-share.js'
