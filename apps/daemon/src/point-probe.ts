/** What is at a spot Dool2 saw on the screenshot, measured by a side-effect-free script on the page */
export interface PointWhat {
  /** The spot in CSS pixels of the visible part of the tab (where the tap goes) */
  x: number
  y: number
  /** Name of the thing there or of the clickable thing around it (aria-label, title, alt, value or its text) */
  label: string
  /** Tag or role of that thing, for the approval words ("button Pay") */
  role: string
  /** Host of another site's frame the spot falls in, whose inside the page cannot read */
  frame: string
}

/**
 * A script for browser_eval's side-effect-free evaluation (Runtime.evaluate with throwOnSideEffect) that finds what is
 * at (px, py) on 0-1000 of the visible part of the tab. Chrome refuses elementFromPoint and closest() there, so the
 * smallest visible element whose box holds the spot is taken (the one drawn on top, in practice), walking into
 * same-site frames, and its name comes from it or the nearest clickable thing around it
 */
export function pointProbe(px: number, py: number): string {
  return `(${PROBE})(${Number(px)}, ${Number(py)})`
}

// Plain JavaScript run in the page (the daemon has no DOM types). Kept free of calls Chrome counts as side effects
const PROBE = `(px, py) => {
  const out = { x: Math.round((px / 1000) * innerWidth), y: Math.round((py / 1000) * innerHeight), label: '', role: '', frame: '' }
  let doc = document
  let ox = 0
  let oy = 0
  for (let depth = 0; depth < 4; depth++) {
    const lx = out.x - ox
    const ly = out.y - oy
    let best = null
    let area = Infinity
    for (const e of [...doc.querySelectorAll('body *')]) {
      const r = e.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) continue
      if (lx < r.left || lx > r.right || ly < r.top || ly > r.bottom) continue
      if (r.width * r.height <= area) { area = r.width * r.height; best = e }
    }
    if (!best) {
      // Inside a frame with nothing at that spot (a blocked or drawn frame): say it is in that frame
      if (depth > 0) out.frame = out.frame || 'a frame on the page'
      return out
    }
    if (best.tagName === 'IFRAME' || best.tagName === 'FRAME') {
      const m = /^[a-z]+:\\/\\/([^/?#]+)/i.exec(best.getAttribute('src') || '')
      out.frame = m ? m[1] : ''
      let inner = null
      try { inner = best.contentDocument } catch (_) {}
      if (!inner) {
        out.frame = out.frame || 'another site'
        return out
      }
      const r = best.getBoundingClientRect()
      ox += r.left + best.clientLeft
      oy += r.top + best.clientTop
      doc = inner
      continue
    }
    out.frame = ''
    const view = doc.defaultView || window
    const nameOf = (e) => (e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('alt') || (e.tagName === 'INPUT' ? e.value || '' : '') || '').trim()
    const textOf = (e) => (e.innerText || '').replace(/\\s+/g, ' ').trim()
    const chain = []
    for (let i = 0, e = best; e && i < 6; i++, e = e.parentElement) chain.push(e)
    // The clickable thing: a control by its tag or role, else the outermost of the pointer-cursor run (the cursor is
    // inherited, so the picture inside an icon button has it too)
    let hit = chain.findIndex((e) => /^(A|BUTTON|INPUT|SELECT|LABEL|SUMMARY)$/.test(e.tagName) || /^(button|link|menuitem|tab|option|checkbox|radio)$/.test(e.getAttribute('role') || '') || e.hasAttribute('onclick'))
    if (hit < 0) {
      for (let i = 0; i < chain.length; i++) {
        if (view.getComputedStyle(chain[i]).cursor === 'pointer') hit = i
        else if (hit >= 0) break
      }
    }
    const at = hit >= 0 ? chain[hit] : best
    let label = ''
    for (let i = 0; i <= Math.max(hit, 0) && !label; i++) label = nameOf(chain[i])
    // An icon button: its name is often on the picture inside it
    const img = at.querySelector('img[alt], img[title], [aria-label], [title]')
    out.label = (label || textOf(at) || (img ? nameOf(img) : '')).slice(0, 120)
    out.role = at.getAttribute('role') || at.tagName.toLowerCase()
    return out
  }
  return out
}`

/**
 * A side-effect-free script that finds the site's own print button on the visible part of the tab (and in same-site
 * frames): an element whose aria-label, title, alt, value or short text matches the print words. Returns the center
 * of the first visible one in CSS pixels of the tab, or null
 */
export function printProbe(pattern: string): string {
  return `(${PRINT_PROBE})(${JSON.stringify(pattern)})`
}

const PRINT_PROBE = `(pattern) => {
  const re = new RegExp(pattern, 'i')
  const visit = (doc, ox, oy, depth) => {
    for (const e of [...doc.querySelectorAll('button, a, input, img, [role=button], [title], [aria-label], [onclick]')]) {
      const r = e.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) continue
      if (r.bottom < 0 || r.right < 0 || r.top > doc.documentElement.clientHeight || r.left > doc.documentElement.clientWidth) continue
      const short = (e.innerText || '').replace(/\\s+/g, ' ').trim()
      const names = [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('alt'), e.tagName === 'INPUT' ? e.value : '', short.length <= 20 ? short : '']
      if (names.some((n) => n && re.test(n.trim()))) return { x: Math.round(ox + r.left + r.width / 2), y: Math.round(oy + r.top + r.height / 2) }
    }
    if (depth >= 3) return null
    for (const f of [...doc.querySelectorAll('iframe, frame')]) {
      let inner = null
      try { inner = f.contentDocument } catch (_) {}
      if (!inner) continue
      const r = f.getBoundingClientRect()
      const hit = visit(inner, ox + r.left + f.clientLeft, oy + r.top + f.clientTop, depth + 1)
      if (hit) return hit
    }
    return null
  }
  return visit(document, 0, 0, 0)
}`
