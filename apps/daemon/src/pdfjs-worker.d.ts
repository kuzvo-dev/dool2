// pdfjs-dist ships no types for the worker file. We only import it to run in the same thread (pdf.ts)
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown
}
