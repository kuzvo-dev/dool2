# 0024. Moving PC files, converting photo formats and printing are Dool2 tools, with approval and undo

- Status: Accepted
- Date: 2026-11-19

## Context

[ADR 0022](0022-pc-file-tools.md) covered find, read and create new, but real-use tests got stuck on three things.

- "다운로드에 있는 PDF 영수증·계약서·청구서·기타로 나눠 줘" (sort the PDFs in Downloads into receipts, contracts, invoices and other) → it made only a table and could not move the files
- "아이폰 사진 HEIC 파일 JPG로 다 바꿔 줘" (convert all my iPhone HEIC photos to JPG) → it found 85 and still said "I can't convert them"
- "집 프린터로 학습지 출력해 줘" (print the worksheet on my home printer) → "Please print it yourself"

ADR 0022 left moving and renaming as "decide separately together with the approval gate when needed".

## Decision

We add three Dool2 tools. The visible folders (Desktop, Documents, Downloads) and the sensitive-file rules stay as in ADR 0022.

- `file_move`: move and rename (several at once; creates missing folders)
  - No overwrite and no delete. If the same name exists, it moves it as `name (1)`
  - **Two or more files need an approval card** (what goes where, as a list made by the daemon). One file is done right away (it can be undone)
  - Each moved batch is kept in `file-moves.json` (the 20 most recent batches), and `undo: true` reverses the latest batch first. If the same name has appeared at the original place, it puts the file back with a number, and removes the folder it created then only if it is empty
  - It does not accept the folders themselves (Desktop, Documents, Downloads), moving outside them, or a new folder with a hidden name
- `file_convert`: change photo format (HEIC, PNG, WEBP, TIFF to JPG/PNG). It leaves the original and creates a new file (`(1)` if the name exists; ones already converted are skipped). It only creates new files, so no approval (same as file_write)
  - Mac: `sips` by default (no new dependency)
  - Windows: the WPF imaging components in PowerShell. HEIC and WEBP need that format's extension (HEIF and WebP image extensions) installed, so if it is missing the result carries the reason and the next route (install the extension, iPhone transfer setting)
  - It works up to 70 seconds per call, and if there is more, it says to call again with the same input (already converted ones are skipped, so it continues)
- `file_print`: print on paper. Since paper comes out, it **always needs approval** (file, copies, pages, printer)
  - Mac: CUPS `lp`. The printer list comes from `lpstat -e`, and the state from `printer-state` and `printer-state-reasons` in `lpoptions -p` (because the lpstat text changes with the Mac's language setting)
  - Windows: the list from `Win32_Printer` (virtual printers do not count as paper), printing through the "print to" verb (PrintTo) of the program that opens the file. Choosing pages is not possible
  - If there is no printer, or it is off, stalled or out of paper, it returns the reason and what to do before asking for approval
  - PDF, photos and txt only. Word, Excel and Hancom files must be turned into PDF first, and HEIC converted with file_convert

Approval uses the existing approval gate (`Approvals`) as is. Kinds `file` and `print`, `-2` instead of a tab number, addresses `file:move` and `file:print`, and the approval card (PC and phone) shows the list (`items`) made by the daemon. When approved, the daemon does only that list and those files. The card in the conversation history is kept only when the tool succeeded (when approval was really requested).

## Why

- It is common tidying that people do on a PC, and if Dool2 shows only a table and stops, the user has to do it again by hand
- Moving does not change content and can be undone, so blocking only overwrite and delete keeps the risk small. Moving many files wrongly is hard to find again, so they are shown once as a list
- Converting photos only creates new files, so it weighs the same as file_write
- Printing cannot be undone (paper, ink) and others can see it, so it always gets approval
- It uses only the OS's own tools (sips, lp, PowerShell), with no new dependency

## Consequences

- Threat model T21 was updated
- Windows photo conversion and printing could not be tried on a real Windows machine when this was decided. They have to be checked and fixed on the test PC
- Printing was only checked as far as listing printers on this Mac (no real print test)
- Undo works only for what Dool2 moved. Files the user moved afterwards are skipped, and the reason is reported

## Addendum (2026-11-19): merge PDFs, Trash, download, lock the screen

We add four things that real-use tests answered with "can't do" ("PDF 3개 하나로 합쳐 줘" (merge these 3 PDFs into one), "실수로 지운 발표 자료 살려 줘" (restore the presentation I deleted by mistake), "이거 집 PC에 받아 놔" (download this to my home PC), "PC 화면 잠가 줘 / 다 끝나면 꺼 줘" (lock my PC screen / shut it down when you're done)) within the same boundary.

- `file_pdf`: merge (photos jpg and png become one A4 page each), extract pages, split. pdfjs-dist is read-only, so we add **pdf-lib** (MIT, its dependencies MIT, Zlib and 0BSD). The Mac has no built-in command to merge PDFs. It only creates new files, so no approval. For a password-protected PDF it says it cannot open it
- `file_trash`: find in the Trash by name (immediate) and restore (one right away, two or more with list approval). If the original place was inside Desktop, Documents or Downloads it goes back there, otherwise (unknown or another folder) to the Desktop, and `(1)` if the name exists. **No emptying and no permanent delete are built**
  - Mac: `~/.Trash`. The original place is read from `ptbL` and `ptbN` that Finder writes in the Trash's `.DS_Store`. If Dool2 lacks Full Disk Access, the Mac blocks it (EPERM), so it returns the reason and the next route ("Put Back" in the Trash, where to turn on the permission)
  - Windows: the shell Recycle Bin (`Shell.Application` 10). It has to be taken out through the shell for the Recycle Bin records to be cleaned up too, but the shell cannot rename, so if the same name exists it creates a new empty folder on the Desktop and takes it out there (so nothing is overwritten)
- `file_download`: https addresses only, into the Downloads folder, up to 2 GB, with the name the site gave (Korean `filename*`) cleaned up. **Addresses on this PC or the home network (private, loopback, .local) are not fetched**, and redirect targets are checked again one by one (so it does not open something like the router admin page on someone's behalf). Executables (.exe, .dmg, .pkg, .app, scripts and so on) need approval before download. Downloaded files get the "downloaded from the internet" mark like a browser (macOS quarantine, Windows Zone.Identifier) so the operating system checks once more when opening. For a web page, 401 or 403, it explains the route of opening it with the browser tools and pressing the download button. If it takes over 60 seconds, it continues in the background and answers "downloading"
- `pc_screen`: lock the screen and sleep right after approval. **Shutting down is not built** (unsaved work could be lost), and it returns the next route that recommends sleep. Locking does not stop Dool2's work, so it can be done any time, but sleep stops Dool2 too, so if another conversation is answering or a service is being connected it says to do it after that finishes (checked twice, at request time and at approval time)
  - Mac: lock = turn off the display + check the setting "require password immediately after the screen turns off" (`sysadminctl -screenLock status`; if it is off, it does not lock and points to the setting), sleep = `pmset`. No administrator rights needed
  - Windows: lock = `LockWorkStation`, sleep = `SetSuspendState` (standby)

We added `pc` (this PC) to the approval kinds, and Trash and download are distinguished within the `file` kind by `label` (restore, download). Whether a download is an executable can only be known from the site's reply, so at first it returns only a result saying approval is needed, and the approval card appears when the AI calls again with `confirm: true` (so that the card record in the conversation is decided from the input alone).

- Added to threat model T21
- Windows Recycle Bin, lock and sleep, and the Mac Trash (when permission is granted) were tested only with fake commands. Even on this Mac the Trash was blocked for lack of permission (the guidance for that case was tested)

## Addendum (2026-11-21): HTML to PDF and PNG (`file_render`)

In real-use tests Dool2 answered that it could not make a 5-page report as PDF or Word ("Open it in the browser and print (save as PDF)"), and about a birthday invitation picture, "I can't make it as PNG, so take a screen capture". That is not the user's job, so Dool2 renders the HTML or SVG it made (or that is in a user folder) into a file.

- The desktop app (Electron) does the rendering: it opens the file in an invisible window (offscreen) and uses `printToPDF` for PDF (A4, with backgrounds, multiple pages, the HTML's `@page` size first, landscape optional), and CDP `Page.captureScreenshot` for PNG, the whole content at 2x (up to 16,000 px tall; if longer, it is cut and the user is told). The daemon only receives it through the `renderFile` option, and if the daemon runs without the app (development, tests), it says it cannot
- The rendering window: no Node features, sandboxed, opening windows, navigation, downloads and permission requests blocked, one at a time. Scripts are on (charts). Loading is limited to **non-sensitive local files inside the visible folders** and https GET (fonts, images); http and addresses on this PC or the home network are blocked. A stuck script gets the window destroyed after 30 seconds
- The original is kept, and a same-name `.pdf` / `.png` is written next to it (`(1)` if it exists). It only creates new files, so no approval. It is also put into the Library's "Photos and files" (PNG with a preview image)
- It is kept separate from the existing `file_convert` (photo formats) because the input and use differ
