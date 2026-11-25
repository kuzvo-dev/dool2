// A small template for the instruction files in prompts/ (ADR 0040): {{name}} puts a value in, {{#name}}…{{/name}}
// keeps the part only when the value is set, {{^name}}…{{/name}} only when it is not. Values are put in as they are
// (never read as template again). Sections of the same name do not nest.

export type TemplateValues = Record<string, string | boolean | undefined>

const SECTION = /\{\{([#^])([A-Za-z][\w.]*)\}\}([\s\S]*?)\{\{\/\2\}\}/g
const VALUE = /\{\{([A-Za-z][\w.]*)\}\}/g

export function renderTemplate(template: string, values: TemplateValues): string {
  let out = template
  // Outer sections first; what they keep may hold inner ones, so go again until nothing changes
  for (let i = 0; i < 20; i++) {
    const next = out.replace(SECTION, (_m, mark: string, name: string, body: string) =>
      Boolean(values[name]) === (mark === '#') ? body : '',
    )
    if (next === out) break
    out = next
  }
  return out.replace(VALUE, (m, name: string) => {
    const v = values[name]
    return typeof v === 'string' ? v : m
  })
}

/** Names a template still has unfilled ({{x}}, or a section left open): a broken file shows up here */
export function leftovers(text: string): string[] {
  return [...text.matchAll(/\{\{[#^/]?([A-Za-z][\w.]*)\}\}/g)].map((m) => m[0])
}

/**
 * A file split into named parts by `<!-- name -->` lines (the voice files in prompts/voice/). Each part is the text
 * up to the next marker, without the newline that ends it
 */
export function namedParts(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let name: string | undefined
  let lines: string[] = []
  const flush = () => {
    if (name) out[name] = lines.join('\n').replace(/\n+$/, '')
  }
  for (const line of text.split('\n')) {
    const m = /^<!-- ([a-z][\w.]*) -->$/.exec(line)
    if (m) {
      flush()
      name = m[1]
      lines = []
    } else if (name) lines.push(line)
  }
  flush()
  return out
}
