// pdfjs-dist는 worker 파일의 타입을 따로 싣지 않는다. 같은 스레드에서 돌리려고 불러오기만 한다 (pdf.ts)
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown
}
