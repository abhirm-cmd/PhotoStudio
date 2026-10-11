import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('photostudio', {
  call: (method: string, ...args: any[]) => ipcRenderer.invoke('api', method, ...args),
  on: (channel: string, cb: (...args: any[]) => void) => {
    const listener = (_e: unknown, ...args: any[]) => cb(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  platform: process.platform,
});
