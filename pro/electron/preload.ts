import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('psp', {
  call: (method: string, ...args: any[]) => ipcRenderer.invoke('api', method, ...args),
  on: (channel: string, cb: (...args: any[]) => void) => {
    const listener = (_e: unknown, ...args: any[]) => cb(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  send: (channel: string, ...args: any[]) => ipcRenderer.send(channel, ...args),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  platform: process.platform,
});
