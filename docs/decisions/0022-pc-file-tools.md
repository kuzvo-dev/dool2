# 0022. PC files: Dool2 tools only find, read and create new files

- Status: Accepted
- Date: 2026-11-18

## Context

A static check of the scenario tests (evals) found that about 600 of 4,505 expected PC file work (read a contract PDF received, put a settlement in Excel, save memory to the desktop). Dool2 turns off all of the AI's built-in tools (shell, files, web) ([ADR 0003](0003-dool2-tools-only.md)), so it had no way to do this, and on the test PC "save it to the desktop" was answered with "I can't create files".

## Decision

Keeping the built-in tools off as in ADR 0003, we add **three Dool2 tools**.

- `file_find`: find by name in Desktop, Documents and Downloads (30 most recent first, including Korean names with decomposed jamo on Mac)
- `file_read`: read as text: text, CSV, JSON, HTML, Word (docx), Excel (xlsx), PowerPoint (pptx), Hancom (hwpx), PDF (simple text extraction). 30,000 characters at a time, continuing to read on. Also old Korean CSV (EUC-KR)
- `file_write`: **creating new files only**: md, txt, html, csv, xlsx. If the same name exists it creates `name (2)` and never overwrites. CSV gets a BOM so Excel does not garble Korean

What is blocked:

- Anything **outside** Desktop, Documents and Downloads cannot be read. Paths are resolved to the real path and checked, so leaving through `../` or a shortcut is blocked too
- Hidden files and folders, the joint certificate (NPKI), keys and certificates (.pem, .key, .p12, ...), and password or wallet files are not read
- There is no delete, move, rename or overwrite (they cannot be undone). If needed, decide them separately together with the approval gate. Move, rename, photo conversion and print were added by [ADR 0024](0024-pc-file-move-convert-print.md) (delete and overwrite still do not exist)
- Hancom (.hwp, binary) cannot be read yet. Dool2 tells the user to save it as hwpx or PDF

## Why

- File work is common in daily life and office requests (settlements, contracts, paperwork), and it best shows Dool2's strength as "an assistant that lives on your PC"
- Narrowing the scope to the user's folders and new files solves most requests at far less risk than turning on the built-in tools
- Read content going to the AI company is the same as reading a web page. Actions that send that content outside are blocked by the existing approval gate

## Consequences

- Threat model T21
- PDF text extraction is simple and dependency-free, so tables and special fonts can be lost. The tool description says to tell the user if it comes out garbled
- A switch to turn the file tools off in Settings comes later (always on for now)

## Added (2026-11-21): Pictures and Movies folders, uploading to websites

- Real-use tests got stuck on "no way to upload a photo file into the blog editor", "no feature to upload a video file to a site", and "could not find the Movies folder"
- We added **Pictures and Movies (Videos on Windows)** to the folders that can be seen. The fences are the same: check the real path, exclude hidden folders, certificates, keys and password files. App bundle folders such as the Photos library (.photoslibrary and so on) are skipped when searching
- `browser_upload`: puts a file from these folders into a web page's file field (blog photos, Shorts, civil complaints, insurance documents). Because it sends my file to that site, **the first time needs an approval card (file name, size, site, screen)**, and the same file to the same site is not asked again for 30 minutes after approval. It only attaches; posting or submitting is separate (the send and submit buttons go through the existing approval gate)
- The extension puts the path in as is through Chrome DevTools (`DOM.setFileInputFiles`), and for sites that create the field when clicked it intercepts the file chooser dialog (`Page.setInterceptFileChooserDialog`) so no dialog appears on the PC. If file access is off for the extension, Chrome blocks it, so the daemon sends the file in 600 KB pieces and builds it into a file inside the page (up to 300 MB in total on this route)

## Update 2026-11-27: on macOS, Dool2's own folder lives in the home folder

What Dool2 makes (documents, PDFs from `browser_save_pdf`, pictures, videos) went to `Documents/두리`. On macOS,
Documents, Desktop and Downloads open a permission window that only someone at the PC can answer. On the test PC a
certificate PDF waited on it while the person was away, and Dool2 asked them to change System Settings from the phone.

- On macOS the folder is now `~/두리` in the home folder, which needs no permission. Windows and Linux keep
  `Documents/두리`.
- `~/두리` is inside the fence like the user folders: files there can be read, linked and sent to the phone.
- Reading the person's own files (`file_find` in Desktop, Documents, Downloads) still needs their permission; that
  stays a step on the PC.
