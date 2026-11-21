// PC 파일을 웹페이지의 파일 칸에 넣기 (browser_upload): 블로그 사진, 쇼츠·영상 올리기, 민원·보험 서류 첨부.
// 확장이 파일 경로를 그대로 넣는 게 먼저다(Chrome DevTools DOM.setFileInputFiles: 큰 영상도 빠르다).
// 확장에 파일 접근이 꺼져 있으면 Chrome이 그 길을 막는다: 그때는 본체가 파일을 조각내 보내고 확장이 페이지 안에서 파일로 만든다.
// 해도 되는지(승인)는 browser-tools.ts가 정한다. 여기는 보내기만 한다
import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import type { BrowserCaller } from './browser-tools.js'
import type { UploadFile } from './files.js'

/** 조각 하나 (원래 크기). base64로 늘어도 Chrome으로 가는 한 메시지 한도(1MB) 안에 든다 */
export const UPLOAD_CHUNK = 600 * 1024
/** 조각으로 보낼 때(파일 접근이 꺼진 확장)의 모두 합한 한도: 페이지 안에서 파일을 만들어 메모리를 쓴다 */
export const PAGE_UPLOAD_MAX = 300 * 1024 * 1024

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.hwp': 'application/x-hwp',
  '.hwpx': 'application/haansofthwpx',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function mimeOf(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? ''
}

/** 크기를 사람이 읽는 글로 (12KB, 3.4MB) */
export function sizeText(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`
  return `${Math.max(1, Math.round(n / 1024))}KB`
}

/**
 * 파일 칸이 받는 종류(accept)와 맞지 않는 파일 이름들. accept가 비었으면 다 받는다.
 * ".jpg,.png", "image/*", "video/mp4" 모양을 본다 (사이트가 결국 다시 확인하니 알리기만 한다)
 */
export function notAccepted(accept: string, names: string[]): string[] {
  const rules = accept
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
  if (!rules.length) return []
  return names.filter((name) => {
    const ext = extname(name).toLowerCase()
    const mime = mimeOf(name)
    return !rules.some((r) =>
      r.startsWith('.')
        ? r === ext
        : r.endsWith('/*')
          ? mime.startsWith(r.slice(0, -1))
          : r === mime || (r === 'image/jpg' && mime === 'image/jpeg'),
    )
  })
}

/** 확장의 upload 결과 */
export interface UploadReply {
  /** 칸에 들어간 파일 이름들 (넣은 뒤 칸에서 다시 읽은 것) */
  names?: string[]
  accept?: string
  multiple?: boolean
  /** cdp: 경로를 그대로 넣음, page: 조각을 받아 페이지 안에서 만듦 */
  how?: 'cdp' | 'page'
  /** 파일 칸을 어떻게 찾았나: self(그 칸)·label·inside·near(둘레의 칸)·chooser(눌러서 뜬 고르기 창) */
  found?: string
  /** 조각으로 보내 달라 (파일 접근이 꺼진 확장) */
  needBytes?: boolean
  token?: string
  /** 경로로 못 넣은 까닭 (Chrome이 막음 등) */
  why?: string
}

/**
 * 파일들을 그 칸에 넣는다. 확장이 경로로 못 넣으면 조각으로 보낸다.
 * 칸에 들어간 이름이 모자라면 오류를 낸다 (넣었다고 하지 않는다)
 */
export async function sendFiles(
  browser: BrowserCaller,
  tabId: number,
  ref: string,
  files: UploadFile[],
): Promise<UploadReply> {
  let r = (await browser.call(
    'upload',
    { tabId, ref, paths: files.map((f) => f.path) },
    60_000,
  )) as UploadReply
  if (r.needBytes && r.token) {
    const token = r.token
    const total = files.reduce((n, f) => n + f.size, 0)
    if (total > PAGE_UPLOAD_MAX) {
      await browser.call('upload', { tabId, token, cancel: true }, 10_000).catch(() => undefined)
      throw new Error(
        `파일이 모두 ${sizeText(total)}라 지금 방식으로는 못 올려요(${sizeText(PAGE_UPLOAD_MAX)}까지). ` +
          "두리 확장의 '파일 URL에 대한 액세스 허용'이 켜져 있으면 크기 제한 없이 올라가요. 더 작은 파일로 나누거나 줄여서 올려요.",
      )
    }
    const meta: { name: string; type: string; lastModified: number; parts: number }[] = []
    for (const f of files) {
      const fh = await open(f.path, 'r')
      let parts = 0
      try {
        const buf = Buffer.alloc(UPLOAD_CHUNK)
        for (let at = 0; ; ) {
          const { bytesRead } = await fh.read(buf, 0, UPLOAD_CHUNK, at)
          if (!bytesRead) break
          at += bytesRead
          await browser.call(
            'upload',
            { tabId, token, part: buf.subarray(0, bytesRead).toString('base64') },
            30_000,
          )
          parts++
        }
      } finally {
        await fh.close()
      }
      meta.push({ name: f.name, type: mimeOf(f.name), lastModified: Math.round(f.mtime), parts })
    }
    r = (await browser.call('upload', { tabId, token, finish: meta }, 120_000)) as UploadReply
  }
  const got = r.names ?? []
  const missing = files.filter((f) => !got.includes(f.name)).map((f) => f.name)
  if (missing.length)
    throw new Error(
      `파일 칸에 ${missing.join(', ')}이(가) 들어가지 않았어요${got.length ? ` (들어간 것: ${got.join(', ')})` : ''}. 페이지를 다시 읽고 파일 칸·올리기 버튼을 확인해 주세요.`,
    )
  return r
}
