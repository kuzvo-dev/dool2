// Turns the instruction files in prompts/ (ADR 0040) into packages/engine/src/locales/prompts.gen.ts, so the engine
// carries them inside its build. Run after editing prompts/:  pnpm prompts   (a test fails while they differ)
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = join(import.meta.dirname, '..')
const dir = join(root, 'prompts')
const out = join(root, 'packages', 'engine', 'src', 'locales', 'prompts.gen.ts')

/** Every .md under prompts/, as "voice/ko.md" → text */
export function promptFiles(base = dir) {
  const files = {}
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (n.endsWith('.md')) files[relative(base, p).split('\\').join('/')] = readFileSync(p, 'utf8')
    }
  }
  walk(base)
  return files
}

export function generated(files = promptFiles()) {
  const body = Object.entries(files)
    .map(([k, v]) => `  ${JSON.stringify(k)}:\n    ${JSON.stringify(v)},`)
    .join('\n')
  return `// Generated from prompts/ by scripts/prompts-gen.mjs (ADR 0040). Edit prompts/ and run \`pnpm prompts\`, not this file
export const PROMPT_FILES: Readonly<Record<string, string>> = {
${body}
}
`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(out, generated())
  console.log(`${relative(root, out)}: ${Object.keys(promptFiles()).length} files`)
}
