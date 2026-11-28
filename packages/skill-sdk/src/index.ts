/**
 * @dool2/skill-sdk
 *
 * The skill system core: parse SKILL.md frontmatter and resolve which site
 * skills to auto-inject into a turn by the active tab URL and by Korean-first
 * keywords. Pure and dependency-free; no network and no filesystem here. The
 * optional directory loader lives behind the `./loader` entry point.
 */

export type {
  AutoInject,
  LoginFieldHint,
  LoginHints,
  ParsedSkill,
  SkillFrontmatter,
} from './frontmatter.js'
export { parseSkillMarkdown, parseYaml } from './frontmatter.js'
export type {
  MatchReason,
  ResolveInput,
  ResolveOptions,
  ScoredSkill,
  SkillMeta,
} from './resolve.js'
export { keywordMatchScore, resolveSkills, tokenize, urlMatchScore } from './resolve.js'
export { globSpecificity, matchUrlGlob } from './url-glob.js'
