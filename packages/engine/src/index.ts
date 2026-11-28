// @dool2/engine
//
// Two things live here during the v2 migration:
//  - the v1 conversation driver (conversation/models/persona/process/runtime/side-job/threads), kept until the v2
//    rebuild removes it;
//  - the v2 turn loop (the integration spine): classify/engine/prompt/scripted-brain, which compose a brain, the few
//    tools, the code hand, the skill resolver, the vault summaries, and the autonomy gate into one runnable turn.
//    No real browser/model yet — everything is injected.
export type { ActionClassifier, ClassifyContext, RefinedAction } from './classify.js'
export { defaultClassify } from './classify.js'
export * from './conversation.js'
export type {
  ApprovalOutcome,
  EngineOptions,
  GateDecisionLog,
  TranscriptItem,
  TurnRequest,
  TurnResult,
} from './engine.js'
export { Engine, GateStopError, runTurn } from './engine.js'
export * from './models.js'
export * from './persona.js'
export * from './process.js'
export type { AssembledPrompt, EngineSkill, InjectedSkill, PromptContext } from './prompt.js'
export { assembleSystemPrompt, BASE_PROMPT } from './prompt.js'
export * from './runtime.js'
export { scriptedBrain } from './scripted-brain.js'
export * from './side-job.js'
export * from './threads.js'
