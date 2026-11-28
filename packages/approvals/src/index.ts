// @dool2/approvals — the phone-signature approval layer. The autonomy gate (@dool2/core) decides a pay/contact/delete
// action needs a signature (`sign`); this package turns that into a real, verifiable approval bound to the exact
// action: an ActionEnvelope is canonicalized and hashed (envelope.ts), the phone's secure chip signs the hash and the
// daemon verifies it (sign.ts), the daemon confirms the action it is about to run matches the approved one
// (match.ts), and the approval expires and can be used only once (pending.ts). Safety sits in code, not the prompt
// (ADR 0043, 0047); secrets never reach this package or the AI.
export * from './action.js'
export * from './envelope.js'
export * from './match.js'
export * from './pending.js'
export * from './sign.js'
