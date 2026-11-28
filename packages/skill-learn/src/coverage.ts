/**
 * KPI helpers for the dashboard.
 *
 * The library's health is two numbers that should climb daily:
 *  - coverage: of the sites people actually visited, how many a skill now covers.
 *  - click-free rate: of the skills we have, how many carry a data-path API
 *    endpoint (so the site can be used click-free, not just by driving the UI).
 */

import type { DraftedSkill } from './draft.js'

const ENDPOINT_RE = /^\s*-\s+`[A-Z]+\s+[^`]+`/m

/** A skill as the KPI needs to see it: the hosts it covers and whether it has a data path. */
export interface CoverageSkill {
  /** Hosts the skill covers (its `site` frontmatter). */
  site?: string[]
  /** True when the skill lists at least one internal API endpoint. */
  hasDataPath?: boolean
}

/** The computed KPIs. */
export interface CoverageStats {
  /** How many distinct visited sites are covered by some skill. */
  covered: number
  /** How many distinct sites were visited. */
  total: number
  /** Fraction of skills that have a data path (0 when there are no skills). */
  clickFreeRatio: number
}

/** True when a skill's body/markdown lists at least one internal API endpoint. */
export function skillHasDataPath(skill: DraftedSkill): boolean {
  return ENDPOINT_RE.test(skill.body) || ENDPOINT_RE.test(skill.markdown)
}

/** Reduce a drafted skill to the shape {@link coverageStats} consumes. */
export function toCoverageSkill(skill: DraftedSkill): CoverageSkill {
  const coverage: CoverageSkill = { hasDataPath: skillHasDataPath(skill) }
  if (skill.frontmatter.site) coverage.site = skill.frontmatter.site
  return coverage
}

/** Normalize a host for comparison (lowercase, no leading `www.`, no trailing dot). */
function normHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '')
}

/** True when a visited host is the skill site or a subdomain of it. */
function hostCovered(visited: string, sites: string[]): boolean {
  const v = normHost(visited)
  return sites.some((s) => {
    const site = normHost(s)
    return v === site || v.endsWith(`.${site}`)
  })
}

/**
 * Compute coverage and the click-free ratio.
 *
 * `total` is the count of distinct visited sites; `covered` is how many of those
 * a skill covers; `clickFreeRatio` is the share of skills that have a data path.
 */
export function coverageStats(skills: CoverageSkill[], sitesVisited: string[]): CoverageStats {
  const visited = [...new Set(sitesVisited.map(normHost))].filter(Boolean)
  const sitedSkills = skills.filter((s) => s.site && s.site.length > 0) as Array<
    CoverageSkill & { site: string[] }
  >

  let covered = 0
  for (const host of visited) {
    if (sitedSkills.some((skill) => hostCovered(host, skill.site))) covered++
  }

  const clickFree = skills.filter((s) => s.hasDataPath).length
  const clickFreeRatio = skills.length > 0 ? clickFree / skills.length : 0

  return { covered, total: visited.length, clickFreeRatio }
}
