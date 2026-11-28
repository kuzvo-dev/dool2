/**
 * Optional filesystem loader for skills. Kept out of the core (`index.ts`) so
 * the resolver and parser stay free of `node:fs`; import it explicitly from
 * `@dool2/skill-sdk/loader` when you need to scan a directory.
 *
 * Layout: `<dir>/<id>/SKILL.md`. Each subdirectory that holds a `SKILL.md`
 * becomes one skill whose `id` is the subdirectory name.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseSkillMarkdown } from './frontmatter.js'
import type { SkillMeta } from './resolve.js'

/** A loaded skill: its id, parsed frontmatter, body, and source path. */
export interface LoadedSkill {
  meta: SkillMeta
  body: string
  path: string
}

/** Turn a parsed frontmatter plus an id into the resolver's {@link SkillMeta}. */
export function toSkillMeta(
  id: string,
  frontmatter: ReturnType<typeof parseSkillMarkdown>['frontmatter'],
): SkillMeta {
  const meta: SkillMeta = { id, name: frontmatter.name }
  if (frontmatter.site) meta.site = frontmatter.site
  if (frontmatter.autoInject) meta.autoInject = frontmatter.autoInject
  if (frontmatter.regions) meta.regions = frontmatter.regions
  if (frontmatter.disabled !== undefined) meta.disabled = frontmatter.disabled
  return meta
}

/**
 * Scan `dir` for `<id>/SKILL.md` files and return the parsed skills, sorted by
 * id. A subdirectory without a readable `SKILL.md` is skipped. Returns an empty
 * array when `dir` does not exist.
 */
export function loadSkillsFromDir(dir: string): LoadedSkill[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  const skills: LoadedSkill[] = []
  for (const id of entries) {
    const skillDir = join(dir, id)
    let isDir = false
    try {
      isDir = statSync(skillDir).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) continue

    const skillPath = join(skillDir, 'SKILL.md')
    let markdown: string
    try {
      markdown = readFileSync(skillPath, 'utf8')
    } catch {
      continue
    }

    const { frontmatter, body } = parseSkillMarkdown(markdown)
    skills.push({ meta: toSkillMeta(id, frontmatter), body, path: skillPath })
  }

  skills.sort((a, b) => a.meta.id.localeCompare(b.meta.id))
  return skills
}
