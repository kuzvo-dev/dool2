// Korean data the PC file tools match or write to disk (ADR 0029). Keep the Korean exactly.

/** Folder (under Documents) where Dool2 collects the files it makes. Existing users' files live here. */
export const DOORI_FOLDER_NAME = '두리'

/** Korean names of the user folders on a Korean Windows (and OneDrive) install, tried after the English ones. */
export const KR_USER_FOLDERS = {
  desktop: ['OneDrive/바탕 화면', '바탕 화면'],
  documents: ['OneDrive/문서', '문서'],
  downloads: ['다운로드'],
  pictures: ['OneDrive/사진', '사진'],
  movies: ['OneDrive/동영상', '동영상'],
} as const

/** Korean word for "password" in file names (such files are never read). Joined into the sensitive-file regex. */
export const KR_SENSITIVE_WORDS = '비밀번호'

/** Korean word for "fax" in printer names (a fax printer prints no paper). Joined into the virtual-printer regex. */
export const KR_FAX_WORD = '팩스'

/** A photo sent in chat, as the chat log writes it: "[사진: name.jpg]" (or the bare name). Group 1 is the name. */
export const SENT_PHOTO_RE = /^(?:\[사진:\s*)?([\w-]+\.jpg)\]?$/
