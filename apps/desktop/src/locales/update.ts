// In-app update errors, shown in the update notice (ADR 0028, ADR 0029)
import { messages } from '@dool2/i18n'

export const updateText = messages({
  ko: {
    feedFailed: (status: number) => `버전 안내를 받지 못했어요 (${status})`,
    badSignature: '버전 안내의 서명이 맞지 않아요',
    notHttps: '업데이트 주소가 https가 아니에요',
    downloadFailed: (status: number) => `업데이트 파일을 받지 못했어요 (${status})`,
    badChecksum: '받은 업데이트 파일의 확인값이 맞지 않아요',
    notInstalled: '설치된 앱에서만 업데이트할 수 있어요',
    noWriteAccess: (folder: string) =>
      `${folder} 폴더에 쓸 권한이 없어요. 다운로드 페이지에서 새 버전을 받아 바꿔 주세요`,
    noAppInZip: '업데이트 파일 안에 앱이 없어요',
    noFile: '업데이트 파일이 없어요',
    unsupportedOs: '이 운영체제에서는 앱 안 업데이트를 아직 못 해요',
  },
  en: {
    feedFailed: (status: number) => `Couldn't get the version info (${status})`,
    badSignature: "The version info signature doesn't match",
    notHttps: "The update address isn't https",
    downloadFailed: (status: number) => `Couldn't download the update (${status})`,
    badChecksum: "The downloaded update's checksum doesn't match",
    notInstalled: 'Updates only work in the installed app',
    noWriteAccess: (folder: string) =>
      `No permission to write to ${folder}. Download the new version from the download page and replace the app`,
    noAppInZip: 'There is no app in the update file',
    noFile: 'The update file is missing',
    unsupportedOs: "In-app updates aren't available on this OS yet",
  },
})
