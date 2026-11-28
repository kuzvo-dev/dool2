/**
 * @dool2/skills
 *
 * The built-in skill pack: a directory of site skills, each a folder
 * `skills/<id>/SKILL.md`, parsed with the `@dool2/skill-sdk` loader. These seed
 * skills are the floor Dool2 ships with; the library then grows daily through
 * downloaded signed packs (see `@dool2/packs`), which unpack more skills next to
 * these in the data dir.
 *
 * The SKILL.md files hold Korean keywords and site hints. That Korean is data
 * (what the resolver matches and what the brain reads), not code, so it lives in
 * the skill files rather than in a locale (ADR 0029).
 */

import { fileURLToPath } from 'node:url'
import type { SkillMeta } from '@dool2/skill-sdk'
import { type LoadedSkill, loadSkillsFromDir } from '@dool2/skill-sdk/loader'

export type { SkillMeta } from '@dool2/skill-sdk'
export type { LoadedSkill } from '@dool2/skill-sdk/loader'

/**
 * Absolute path to the built-in `skills/` directory that ships with this
 * package. Works both from the compiled `dist/` and from `src/` under vitest
 * because each sits one level below the package root.
 */
export function builtinSkillsDir(): string {
  return fileURLToPath(new URL('../skills', import.meta.url))
}

/**
 * Load and parse every built-in skill (`skills/<id>/SKILL.md`), sorted by id.
 *
 * Each entry carries the resolver {@link SkillMeta} (on `.meta`), the Markdown
 * body of site hints (`.body`), and the source path. Pass `skills.map(s =>
 * s.meta)` to `resolveSkills` to pick the skill for a turn.
 */
export function loadBuiltinSkills(): LoadedSkill[] {
  return loadSkillsFromDir(builtinSkillsDir())
}

/** The built-in skills as resolver {@link SkillMeta}, ready for `resolveSkills`. */
export function loadBuiltinSkillMetas(): SkillMeta[] {
  return loadBuiltinSkills().map((s) => s.meta)
}
