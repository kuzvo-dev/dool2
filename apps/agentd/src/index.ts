// @dool2/agentd — the v2 runnable daemon. It wires the engine turn loop (@dool2/engine runTurn) to a brain
// (@dool2/brains, DI), the real hidden browser (@dool2/page-bridge over @dool2/browser), a masked vault
// (@dool2/vault), the autonomy gate (@dool2/core decide, inside the engine) and phone-signed approvals
// (@dool2/approvals), behind a small local HTTP API (http.ts) and a CLI (cli.ts).
export {
  Agentd,
  type AgentdEvent,
  type AgentdOptions,
  type ApprovalCard,
  type ApproveResult,
  envelopeHash,
  type SendOptions,
  type SendResult,
} from './agentd.js'
export {
  type BrainChoice,
  type BrainConfig,
  type BrainProvider,
  brainConfigFromEnv,
  type ChooseBrainDeps,
  chooseBrain,
  DEFAULT_PI_MODEL,
  demoBrain,
} from './brain-config.js'
export { type BuildBridgesOptions, type BuiltBridges, buildHostBridges } from './bridges.js'
export { type HttpServerOptions, type RunningHttpServer, startHttpServer } from './http.js'
export {
  DEFAULT_AGENT_WINDOW_MS,
  DEFAULT_UNLOCK_TTL_MS,
  defaultVaultItems,
  InMemoryVault,
  type InMemoryVaultOptions,
  makeVaultBridge,
  type UnlockOptions,
  type VaultBridgeDeps,
  type VaultFillEvent,
} from './vault.js'
