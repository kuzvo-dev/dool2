// 화면(renderer)에 노출하는 최소한의 다리. Node 기능은 넘기지 않는다.
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
  /** Chrome에 올릴 두리 확장 폴더 */
  extensionDir: (): Promise<string> => ipcRenderer.invoke('dool2:extension-dir'),
  revealExtension: () => ipcRenderer.send('dool2:reveal-extension'),
  /** 웹 스토어에 올린 두리 확장 id (없으면 null: 폴더를 직접 올리는 안내) */
  storeExtension: (): Promise<string | null> => ipcRenderer.invoke('dool2:store-extension'),
  /** Chrome에서 웹 스토어의 두리 확장 페이지를 연다 */
  openStore: () => ipcRenderer.send('dool2:open-store'),
  /** 새 버전 (ADR 0028) */
  update: {
    state: (): Promise<unknown> => ipcRenderer.invoke('dool2:update-state'),
    install: (): Promise<unknown> => ipcRenderer.invoke('dool2:update-install'),
    /** 지금 바로 새 버전이 있는지 본다 (설정의 [업데이트 확인]) */
    check: (): Promise<unknown> => ipcRenderer.invoke('dool2:update-check'),
    /** 이 앱 버전 */
    version: (): Promise<string> => ipcRenderer.invoke('dool2:version'),
    onChange: (cb: (s: unknown) => void) => {
      ipcRenderer.on('dool2:update', (_e, s) => cb(s))
    },
  },
})
