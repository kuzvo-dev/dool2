// Korean markers in the text extracted from PDFs. The tests and file_read's page hints rely on this exact form.
export const pdfPageMark = (n: number) => `[${n}쪽]`
export const PDF_PAGE_MARK_RE = /\[\d+쪽\]/g
export const pdfFieldMark = (values: string) => `(입력칸) ${values}`
export const pdfTruncated = (pages: number, max: number) => `(전체 ${pages}쪽 중 앞 ${max}쪽만 읽었어요)`
