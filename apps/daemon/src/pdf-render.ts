import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { PDFDocument } from 'pdf-lib'

const run = promisify(execFile)

/**
 * Pictures of a PDF's first pages as the system draws them (PNG), for PDFs whose text does not come out: a
 * certificate saved from a site's print draws its letters as shapes, and its only embedded picture was the court
 * seal watermark, so Dool2 saw a blank page and called a good file empty (test PC 11-27). macOS draws with sips
 * (built in, no permission); elsewhere this returns nothing and the embedded pictures are used as before
 */
export async function renderPdfPages(buf: Buffer, max = 3, maxSide = 1600): Promise<Buffer[]> {
  if (process.platform !== 'darwin') return []
  const dir = await mkdtemp(join(tmpdir(), 'dool2-pdf-'))
  try {
    const src = await PDFDocument.load(buf, { ignoreEncryption: true })
    const out: Buffer[] = []
    const n = Math.min(src.getPageCount(), max)
    for (let i = 0; i < n; i++) {
      // sips draws only the first page, so each page becomes its own one-page PDF first
      const one = await PDFDocument.create()
      const [page] = await one.copyPages(src, [i])
      if (!page) break
      one.addPage(page)
      const pdf = join(dir, `p${i}.pdf`)
      const png = join(dir, `p${i}.png`)
      await writeFile(pdf, await one.save())
      await run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', String(maxSide), pdf, '--out', png], {
        timeout: 20_000,
      })
      out.push(await readFile(png))
    }
    return out
  } catch {
    return []
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
