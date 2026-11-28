// The smallest bridge exposed to the window (renderer). No Node features pass through — only these typed channels.
// Everything the chat does (send a message, set the autonomy level, watch the hidden browser) goes through here to
// the main process, which owns the in-process daemon.
import electron = require('electron')

const { contextBridge, ipcRenderer } = electron

contextBridge.exposeInMainWorld('dool2', {
  /** Window config read once at start: UI language, current level, and whether this is a smoke run. */
  config: (): Promise<{ lang: 'ko' | 'en'; level: 'ask' | 'auto' | 'full'; smoke: boolean }> =>
    ipcRenderer.invoke('dool2:config'),
  /** Send a user message. Resolves when the turn ends; events stream in through onEvent meanwhile. */
  send: (text: string): Promise<void> => ipcRenderer.invoke('dool2:send', text),
  /** Change the autonomy level (ADR 0047). */
  setLevel: (level: 'ask' | 'auto' | 'full'): Promise<void> => ipcRenderer.invoke('dool2:set-level', level),
  /** Turn the hidden-browser mirror on or off. Off by default: the browser stays invisible. */
  watchBrowser: (on: boolean): Promise<void> => ipcRenderer.invoke('dool2:watch-browser', on),
  /** The approval cards still awaiting a phone signature (the daemon's GET /pending): the up-next queue. */
  pending: (): Promise<unknown> => ipcRenderer.invoke('dool2:pending'),
  /** The review-pending learned site-skill drafts + the library coverage KPIs (the daemon's GET /drafts). */
  drafts: (): Promise<unknown> => ipcRenderer.invoke('dool2:drafts'),
  /** Approve a draft so it becomes an active local skill. */
  approveDraft: (id: string): Promise<unknown> => ipcRenderer.invoke('dool2:approve-draft', id),
  /** Discard a draft. */
  discardDraft: (id: string): Promise<unknown> => ipcRenderer.invoke('dool2:discard-draft', id),
  /** Each daemon event during a turn (already safe to show; the renderer maps it to a line). */
  onEvent: (cb: (event: unknown) => void): void => {
    ipcRenderer.on('dool2:event', (_e, event) => cb(event))
  },
  /** A frame (data: URL) of the hidden browser, while watching is on. */
  onBrowserFrame: (cb: (dataUrl: string | null) => void): void => {
    ipcRenderer.on('dool2:browser-frame', (_e, dataUrl) => cb(dataUrl))
  },
  /** The smoke run injects the canned user message through this, so the transcript is deterministic. */
  onUserMessage: (cb: (text: string) => void): void => {
    ipcRenderer.on('dool2:user-message', (_e, text) => cb(text))
  },
  /** Tell the main process the window is painted (used by the smoke screenshot to know when to capture). */
  ready: (summary: string): void => ipcRenderer.send('dool2:ready', summary),
})
