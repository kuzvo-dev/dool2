import { PDFDocument, rgb } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { renderPdfPages } from './pdf-render.js'

describe('renderPdfPages', () => {
  it.runIf(process.platform === 'darwin')('draws each page as a PNG, shapes included', async () => {
    const doc = await PDFDocument.create()
    for (let i = 0; i < 2; i++) {
      // Letters drawn as shapes: no text comes out, only a page image shows them
      doc.addPage([300, 400]).drawRectangle({ x: 20, y: 20, width: 100, height: 50, color: rgb(0, 0, 0) })
    }
    const pngs = await renderPdfPages(Buffer.from(await doc.save()), 3, 400)
    expect(pngs).toHaveLength(2)
    expect(pngs[0]?.subarray(1, 4).toString()).toBe('PNG')
  })

  it('gives nothing for a file that is not a PDF', async () => {
    expect(await renderPdfPages(Buffer.from('not a pdf'))).toEqual([])
  })
})
