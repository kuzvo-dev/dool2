// 화면(renderer)에 노출하는 최소한의 다리. Node 기능은 넘기지 않는다.
import electron = require('electron')

const { contextBridge, ipcRenderer } = electron

contextBridge.exposeInMainWorld('dool2', {
  config: (): Promise<{ url: string; token: string; smokeOpen?: string; smokeSetup?: string }> =>
    ipcRenderer.invoke('dool2:config'),
  ready: (summary: string) => ipcRenderer.send('dool2:ready', summary),
})
