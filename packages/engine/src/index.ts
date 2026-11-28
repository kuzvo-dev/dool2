// @dool2/engine
//
// The v2 turn loop (the integration spine): classify/engine/prompt/scripted-brain, which compose a brain, the few
// tools, the code hand, the skill resolver, the vault summaries, and the autonomy gate into one runnable turn.
// No real browser/model yet — everything is injected.
export type { ActionClassifier, ClassifyContext, RefinedAction } from './classify.js'
export { defaultClassify } from './classify.js'
export type { EngineOptions, TranscriptItem, TurnRequest, TurnResult } from './engine.js'
export { Engine, runTurn } from './engine.js'
export type { AssembledPrompt, EngineSkill, InjectedSkill, PromptContext } from './prompt.js'
export { assembleSystemPrompt, BASE_PROMPT } from './prompt.js'
export { scriptedBrain } from './scripted-brain.js'
export type {
  ApprovalOutcome,
  GateDecisionLog,
  ToolRuntime,
  ToolRuntimeOptions,
} from './tool-runtime.js'
export { createToolRuntime, GateStopError } from './tool-runtime.js'
