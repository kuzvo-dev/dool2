// Put PC files into a web page's file input (browser_upload): blog photos, shorts and videos, attachments for civil or insurance forms.
// The first choice is for the extension to put the file path in directly (Chrome DevTools DOM.setFileInputFiles: fast even for big videos).
// If file access is off for the extension, Chrome blocks that way: then the daemon sends the file in chunks and the extension rebuilds the file inside the page.
// Whether it is allowed (approval) is decided by browser-tools.ts. This file only sends
import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import type { BrowserCaller } from './browser-tools.js'
import type { UploadFile } from './files.js'

/** One chunk (raw size). Even after base64 growth it fits Chrome's one-message limit (1MB) */
export const UPLOAD_CHUNK = 600 * 1024
/** Total limit when sending in chunks (extension without file access): the file is built inside the page and uses memory */
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

/** Size as human-readable text (12KB, 3.4MB) */
export function sizeText(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`
  return `${Math.max(1, Math.round(n / 1024))}KB`
}

/**
 * File names that do not match the kinds the input accepts (accept). Empty accept takes everything.
 * Looks at shapes like ".jpg,.png", "image/*", "video/mp4" (the site checks again anyway, so we only warn)
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

/** Result of the extension's upload */
export interface UploadReply {
  /** File names that ended up in the input (read back from it after filling) */
  names?: string[]
  accept?: string
  multiple?: boolean
  /** cdp: path put in directly, page: chunks received and the file built inside the page */
  how?: 'cdp' | 'page'
  /** How the file input was found: self (that input), label, inside, near (an input around it), chooser (the picker opened by clicking) */
  found?: string
  /** Asks to be sent in chunks (extension without file access) */
  needBytes?: boolean
  token?: string
  /** Why the path could not be used (blocked by Chrome etc.) */
  why?: string
}

/**
 * Puts the files into that input. If the extension cannot use paths, sends chunks.
 * If fewer names ended up in the input, throws an error (never claims they went in)
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
        `The files total ${sizeText(total)}, too much for this method (up to ${sizeText(PAGE_UPLOAD_MAX)}). ` +
          "With 'Allow access to file URLs' turned on for the Doori extension there is no size limit. Otherwise split into smaller files or shrink them.",
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
      `${missing.join(', ')} did not go into the file input${got.length ? ` (went in: ${got.join(', ')})` : ''}. Read the page again and check the file input and the upload button.`,
    )
  return r
}
