// Assemble the system prompt for one turn: a small base plus the SKILL.md bodies of the skills the resolver matched
// for this tab URL and message. The prompt stays small on purpose (ADR 0040, ADR 0045) — only matched skills are
// injected, so the brain reads site tips only when they are relevant, not a wall of every skill every turn.

import { resolveSkills, type SkillMeta } from '@dool2/skill-sdk'

/** A skill the engine can both resolve (via its meta) and inject (via its SKILL.md body). */
export interface EngineSkill {
  meta: SkillMeta
  /** The SKILL.md Markdown body after the frontmatter. */
  body: string
}

/** The signals the resolver scores skills against for a turn. */
export interface PromptContext {
  /** The active tab URL, if any. */
  url?: string
  /** The user's message, if any. */
  message?: string
}

/** One injected skill section, kept so the activity log can show why the prompt grew. */
export interface InjectedSkill {
  id: string
  name: string
  score: number
}

export interface AssembledPrompt {
  /** The full system prompt text handed to the brain. */
  system: string
  /** The skills that were injected, highest score first. */
  injected: InjectedSkill[]
}

/**
 * The small, brain-agnostic base. It says who Dool2 is and how the few tools fit together, and leaves safety to the
 * daemon gate rather than the prompt (ADR 0047). Site knowledge is never here — it arrives as a matched skill.
 */
export const BASE_PROMPT = `You are Dool2, an assistant that works on the user's own computer through a small set of tools.

Tools:
- code: the broad hand. Run JavaScript to read and act on the open page, the vault (masked), PC apps, and files.
  Prefer the data path (the site's own API with the user's session) before clicking through a screen.
- ask: ask the user a question only when nothing else can resolve it.
- approve: request a phone signature for an action that is hard to undo.
- task: start or hand off a background task.
- memory: search or write the user's memory.

You never see secrets. The vault fills passwords, codes, and payment PINs into the page itself; you work from masked
summaries and opaque ids. Actions that spend money, contact people, or delete things pass through a safety gate that
may require a signature on the user's phone — this is handled for you, so act normally and the gate will stop what
needs stopping.

Think for yourself and try to finish the task. Tools are shortcuts, not limits.`

/**
 * Build the system prompt for a turn. Resolves skills by the tab URL and message keywords and appends only the
 * matched SKILL.md bodies, strongest match first.
 */
export function assembleSystemPrompt(ctx: PromptContext, skills: EngineSkill[] = []): AssembledPrompt {
  const byId = new Map(skills.map((s) => [s.meta.id, s]))
  const resolveInput: PromptContext = {}
  if (ctx.url !== undefined) resolveInput.url = ctx.url
  if (ctx.message !== undefined) resolveInput.message = ctx.message
  const scored = resolveSkills(
    resolveInput,
    skills.map((s) => s.meta),
  )

  const injected: InjectedSkill[] = []
  const sections: string[] = []
  for (const match of scored) {
    const skill = byId.get(match.skill.id)
    if (!skill) continue
    const name = skill.meta.name ?? skill.meta.id
    injected.push({ id: skill.meta.id, name, score: match.score })
    sections.push(`## Skill: ${name}\n\n${skill.body.trim()}`)
  }

  const system = sections.length > 0 ? `${BASE_PROMPT}\n\n${sections.join('\n\n')}` : BASE_PROMPT
  return { system, injected }
}
