// The smallest bridge exposed to the window (renderer). No Node features are passed through.
import electron = require('electron')

const { contextBridge, ipcRenderer } = electron

contextBridge.exposeInMainWorld('dool2', {
  config: (): Promise<{
    url: string
    token: string
    smokeOpen?: string
    smokeSetup?: string
    smokeAsk?: string
    smokeAskWait?: number
  }> => ipcRenderer.invoke('dool2:config'),
  ready: (summary: string) => ipcRenderer.send('dool2:ready', summary),
  /** The Dool2 extension folder to load into Chrome */
  extensionDir: (): Promise<string> => ipcRenderer.invoke('dool2:extension-dir'),
  revealExtension: () => ipcRenderer.send('dool2:reveal-extension'),
  /** Web store id of the Dool2 extension (null: show how to load the folder by hand) */
  storeExtension: (): Promise<string | null> => ipcRenderer.invoke('dool2:store-extension'),
  /** Opens the Dool2 extension's web store page in Chrome */
  openStore: () => ipcRenderer.send('dool2:open-store'),
  /** New versions (ADR 0028) */
  update: {
    state: (): Promise<unknown> => ipcRenderer.invoke('dool2:update-state'),
    install: (): Promise<unknown> => ipcRenderer.invoke('dool2:update-install'),
    /** Checks for a new version right now ([Check for updates] in Settings) */
    check: (): Promise<unknown> => ipcRenderer.invoke('dool2:update-check'),
    /** This app's version */
    version: (): Promise<string> => ipcRenderer.invoke('dool2:version'),
    onChange: (cb: (s: unknown) => void) => {
      ipcRenderer.on('dool2:update', (_e, s) => cb(s))
    },
  },
})
