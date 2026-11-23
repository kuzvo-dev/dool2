// PC file tools copy people read: approval cards, approval results (also passed on to the AI), files shown on
// cards. Korean is the reference and English must have the same keys (ADR 0029)
import { messages } from '@dool2/i18n'

export const filesCopy = messages({
  ko: {
    // ── Move / rename ──
    moveRole: '파일',
    moveLabel: '옮기기',
    moveReason: '파일 옮기기·이름 바꾸기',
    moveWhat: (n: number, newFolders: string[]) =>
      `파일 ${n}개 옮기기${newFolders.length ? ` · 새 폴더 ${newFolders.join('·')}` : ''}`,
    moveCancel: '되돌리기: "방금 옮긴 것 되돌려 줘"라고 하면 원래 자리로 돌려놔요',
    moved: (n: number, folders: string[], more: number) =>
      `${n}개를 옮겼어요 → ${folders.join(', ')}${more > 0 ? ` 외 ${more}곳` : ''}.`,
    movedNone: '하나도 옮기지 못했어요.',
    movedNewFolders: (names: string[]) => ` 새로 만든 폴더: ${names.join('·')}.`,
    movedNumbered: (names: string[], more: boolean) =>
      ` 같은 이름이 있어 번호를 붙인 것: ${names.join(', ')}${more ? ' …' : ''}.`,
    movedFailed: (n: number, items: string[]) => ` 못 옮긴 것 ${n}개: ${items.join(', ')}.`,
    moveUndoHint: ' 되돌리려면 file_move에 undo: true ("방금 옮긴 것 되돌려 줘").',
    goneMeanwhile: '그 사이 없어졌어요',
    folderOtherDisk: '다른 디스크로는 폴더를 옮기지 못해요',

    // ── Print ──
    printRole: '프린터',
    printLabel: '출력',
    printReason: '종이가 나가는 일',
    printWhat: (name: string, copies: number, pages?: string) =>
      `"${name}" ${copies}부 출력${pages ? ` (${pages}쪽)` : ''}`,
    printPagesOf: (n: number, pages: string) => ` · PDF ${n}쪽 중 ${pages}쪽`,
    printSheets: (n: number, copies: number) => ` · ${n}쪽 × ${copies}부 = ${n * copies}장`,
    printWinPages: '윈도우에서는 쪽을 골라 출력하지 못해 전부 나와요',
    printFileGone: '출력할 파일이 그 사이 없어졌어요.',
    printWinNoApp: '이 파일을 인쇄할 프로그램이 없어요',
    printWinFailed: (why: string) =>
      `프린터로 보내지 못했어요(${why}). 파일을 열어 Ctrl+P로 출력해 달라고 알려 주세요.`,
    printWinSent: (printer: string, name: string, copies: number) =>
      `프린터 ${printer}에 "${name}" ${copies}부를 보냈어요. 종이가 안 나오면 프린터 전원·용지를 확인해 달라고 알려 주세요.`,
    printUnknownReason: '알 수 없는 이유',
    printFailed: (why: string) => `프린터로 보내지 못했어요: ${why}`,
    printSent: (printer: string, name: string, copies: number, job?: string) =>
      `프린터 ${printer}에 "${name}" ${copies}부를 보냈어요${job ? `(작업 ${job})` : ''}. 종이가 안 나오면 프린터 전원·용지·잉크를 확인해 달라고 알려 주세요.`,

    // ── Restore from the trash ──
    trashRole: '휴지통',
    trashLabel: '되살리기',
    trashReason: '휴지통에서 되살리기',
    trashWhat: (n: number) => `휴지통에서 ${n}개 되살리기`,
    trashWhere: '휴지통',
    trashWhyOrigin: '원래 자리',
    trashWhyOutside: (from: string) => `원래 자리 ${from}는 두리가 손대는 폴더가 아니라 바탕화면`,
    trashWhyUnknown: '원래 자리를 몰라 바탕화면',
    /** Folder made on the desktop (Windows) when a file with the same name is already there */
    trashRestoredFolder: '휴지통에서 되살린 파일',
    trashRestoredLine: (name: string, shown: string, why: string, numbered: boolean) =>
      `${name} → ${shown} (${why}${numbered ? ', 같은 이름이 있어 번호를 붙였어요' : ''})`,
    trashMacBlocked: '맥이 막았어요. Finder 휴지통에서 "되돌려 놓기"를 눌러 달라고 알려 주세요',
    trashRestored: (n: number, items: string[]) => `${n}개를 되살렸어요: ${items.join(', ')}.`,
    trashRestoredNone: '하나도 되살리지 못했어요.',
    trashFailed: (items: string[]) => ` 못 되살린 것: ${items.join(', ')}.`,

    // ── Download a program ──
    downloadRole: '파일',
    downloadLabel: '받기',
    downloadReason: '실행 파일 받기',
    downloadWhat: (name: string, size: string) => `"${name}" 받기 (실행 파일${size})`,
    downloadCancel:
      '받기만 해요. 여는 건 사용자가 직접 하고, 처음 여는 프로그램은 맥·윈도우가 한 번 더 확인해요',
    downloadNoFolder: '다운로드 폴더를 찾지 못했어요.',
    downloadFailed: '받지 못했어요.',

    // ── Lock / sleep ──
    powerReasonSleep: '잠자기하면 두리도 멈춰요',
    powerReasonLock: '화면 잠그기',
    powerWhat: (label: string) => `이 PC ${label}`,
    powerWhere: '이 PC',
    powerCancelLock: '잠가도 두리는 하던 일을 계속해요',
    powerCancelSleep: '다시 열면 하던 그대로예요. 잠자는 동안 두리는 폰 부탁을 받지 못해요',
    busyChats: (n: number) => `답하는 대화 ${n}개`,
    busyConnecting: (names: string[]) => `${names.join('·')} 연결`,
    sleepBusy: (other: string) =>
      `두리가 아직 다른 일(${other})을 하는 중이라 잠자기하지 않았어요. 끝난 뒤에 다시 부탁해 주세요.`,
    sleepSoon: '3초 뒤 PC가 잠자기에 들어가요. 다시 열면 하던 그대로예요.',
    lockFailed: (why: string) => `화면을 잠그지 못했어요: ${why}`,
    locked: '화면을 잠갔어요. 두리는 하던 일을 계속해요.',

    // ── After approval ──
    approvalGone: '이미 처리했거나 시간이 지난 승인 요청이에요',
    approvalLost: '두리를 다시 켜서 승인할 내용이 사라졌어요. 다시 부탁해 주세요.',

    // ── Files ──
    /** Shown on the upload card for a photo the user sent in chat */
    sentPhoto: '대화로 보낸 사진',
    icloudAway: (name: string) =>
      `${name}: iCloud Drive에만 있고 이 Mac에 아직 내려받아지지 않았어요. 조금 뒤 다시 해 볼게요.`,
  },
  en: {
    moveRole: 'File',
    moveLabel: 'Move',
    moveReason: 'Move or rename files',
    moveWhat: (n: number, newFolders: string[]) =>
      `Move ${n} file${n === 1 ? '' : 's'}${newFolders.length ? ` · new folder ${newFolders.join(', ')}` : ''}`,
    moveCancel: 'To undo, say "undo the move" and they go back where they were',
    moved: (n: number, folders: string[], more: number) =>
      `Moved ${n} → ${folders.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`,
    movedNone: 'Nothing was moved.',
    movedNewFolders: (names: string[]) => ` New folders: ${names.join(', ')}.`,
    movedNumbered: (names: string[], more: boolean) =>
      ` Numbered because the name was taken: ${names.join(', ')}${more ? ' …' : ''}.`,
    movedFailed: (n: number, items: string[]) => ` Not moved (${n}): ${items.join(', ')}.`,
    moveUndoHint: ' To undo, call file_move with undo: true ("undo the move").',
    goneMeanwhile: 'It was gone by then',
    folderOtherDisk: 'Folders cannot be moved to another disk',

    printRole: 'Printer',
    printLabel: 'Print',
    printReason: 'Prints on paper',
    printWhat: (name: string, copies: number, pages?: string) =>
      `Print "${name}", ${copies} ${copies === 1 ? 'copy' : 'copies'}${pages ? ` (pages ${pages})` : ''}`,
    printPagesOf: (n: number, pages: string) => ` · pages ${pages} of a ${n}-page PDF`,
    printSheets: (n: number, copies: number) => ` · ${n} pages × ${copies} = ${n * copies} sheets`,
    printWinPages: 'Windows cannot print selected pages, so every page prints',
    printFileGone: 'The file to print was gone by then.',
    printWinNoApp: 'No app can print this file',
    printWinFailed: (why: string) =>
      `Could not send it to the printer (${why}). Ask the user to open the file and print with Ctrl+P.`,
    printWinSent: (printer: string, name: string, copies: number) =>
      `Sent "${name}" (${copies}) to ${printer}. If no paper comes out, ask the user to check the printer's power and paper.`,
    printUnknownReason: 'unknown reason',
    printFailed: (why: string) => `Could not send it to the printer: ${why}`,
    printSent: (printer: string, name: string, copies: number, job?: string) =>
      `Sent "${name}" (${copies}) to ${printer}${job ? ` (job ${job})` : ''}. If no paper comes out, ask the user to check the printer's power, paper and ink.`,

    trashRole: 'Trash',
    trashLabel: 'Restore',
    trashReason: 'Restore from the trash',
    trashWhat: (n: number) => `Restore ${n} from the trash`,
    trashWhere: 'Trash',
    trashWhyOrigin: 'original place',
    trashWhyOutside: (from: string) => `original place ${from} is outside Dool2's folders, so the desktop`,
    trashWhyUnknown: 'original place unknown, so the desktop',
    trashRestoredFolder: 'Restored from trash',
    trashRestoredLine: (name: string, shown: string, why: string, numbered: boolean) =>
      `${name} → ${shown} (${why}${numbered ? ', numbered because the name was taken' : ''})`,
    trashMacBlocked: 'macOS blocked it. Ask the user to click "Put Back" in the Finder trash',
    trashRestored: (n: number, items: string[]) => `Restored ${n}: ${items.join(', ')}.`,
    trashRestoredNone: 'Nothing was restored.',
    trashFailed: (items: string[]) => ` Not restored: ${items.join(', ')}.`,

    downloadRole: 'File',
    downloadLabel: 'Download',
    downloadReason: 'Download a program',
    downloadWhat: (name: string, size: string) => `Download "${name}" (program${size})`,
    downloadCancel:
      'Only downloads it. The user opens it, and macOS or Windows asks once more the first time a program opens',
    downloadNoFolder: 'Could not find the Downloads folder.',
    downloadFailed: 'Could not download it.',

    powerReasonSleep: 'Dool2 stops too while the PC sleeps',
    powerReasonLock: 'Lock the screen',
    powerWhat: (label: string) => `This PC: ${label}`,
    powerWhere: 'This PC',
    powerCancelLock: 'Dool2 keeps working while the screen is locked',
    powerCancelSleep:
      'Everything is as it was when you wake it. While it sleeps, Dool2 cannot take requests from the phone',
    busyChats: (n: number) => `${n} chat${n === 1 ? '' : 's'} in progress`,
    busyConnecting: (names: string[]) => `connecting ${names.join(', ')}`,
    sleepBusy: (other: string) =>
      `Dool2 is still busy (${other}), so the PC did not sleep. Ask again when it is done.`,
    sleepSoon: 'The PC goes to sleep in 3 seconds. Everything is as it was when you wake it.',
    lockFailed: (why: string) => `Could not lock the screen: ${why}`,
    locked: 'Locked the screen. Dool2 keeps working.',

    approvalGone: 'This approval was already handled or has expired',
    approvalLost: 'Dool2 restarted, so the approved details were lost. Please ask again.',

    sentPhoto: 'Photo sent in chat',
    icloudAway: (name: string) =>
      `${name}: this file is only in iCloud Drive and is not downloaded to this Mac yet. I'll try again shortly.`,
  },
})
