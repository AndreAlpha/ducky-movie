import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DuckyAPI, ExportProgress, AutomationProgress } from '../shared/types';

const api: DuckyAPI = {
  hasUpdateAccess: () => ipcRenderer.invoke('update:has-access'),
  setUpdateAccess: token => ipcRenderer.invoke('update:set-access', token),
  getStartupUpdate: () => ipcRenderer.invoke('update:check'),
  downloadStartupUpdate: () => ipcRenderer.invoke('update:download'),
  cancelStartupUpdate: () => ipcRenderer.invoke('update:cancel'),
  installStartupUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateProgress: callback => {
    const listener = (_event: Electron.IpcRendererEvent, fraction: number) => callback(fraction);
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  },
  exportTranscript: (subtitles, format) => ipcRenderer.invoke('transcript:export', subtitles, format),
  importLegacyProject: () => ipcRenderer.invoke('project:import-legacy'),
  saveTemplate: project => ipcRenderer.invoke('template:save', project),
  openTemplate: () => ipcRenderer.invoke('template:open'),
  startAutomation: request => ipcRenderer.invoke('automation:start', request),
  cancelAutomation: id => ipcRenderer.invoke('automation:cancel', id),
  importScript: () => ipcRenderer.invoke('script:import'),
  onAutomationProgress: callback => {
    const listener = (_event: Electron.IpcRendererEvent, progress: AutomationProgress) => callback(progress);
    ipcRenderer.on('automation:progress', listener);
    return () => ipcRenderer.removeListener('automation:progress', listener);
  },
  importMedia: (paths) => ipcRenderer.invoke('media:import', paths),
  openProject: (path) => ipcRenderer.invoke('project:open', path),
  saveProject: (project, path, forceDialog) =>
    ipcRenderer.invoke('project:save', project, path, forceDialog),
  autosave: (project) => ipcRenderer.invoke('project:autosave', project),
  recoverAutosave: () => ipcRenderer.invoke('project:recover'),
  clearAutosave: () => ipcRenderer.invoke('project:clear-autosave'),
  getRecentProjects: () => ipcRenderer.invoke('project:recent'),
  exportVideo: (project, settings) =>
    ipcRenderer.invoke('export:start', project, settings),
  cancelExport: (jobId) => ipcRenderer.invoke('export:cancel', jobId),
  getExportCapabilities: () => ipcRenderer.invoke('export:capabilities'),
  onExportProgress: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      progress: ExportProgress,
    ) => callback(progress);
    ipcRenderer.on('export:progress', listener);
    return () => ipcRenderer.removeListener('export:progress', listener);
  },
  revealFile: (path) => ipcRenderer.invoke('file:reveal', path),
  getVersion: () => ipcRenderer.invoke('app:version'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  setDirty: (dirty) => ipcRenderer.send('project:dirty', dirty),
  onSaveRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('project:save-requested', listener);
    return () => ipcRenderer.removeListener('project:save-requested', listener);
  },
};

contextBridge.exposeInMainWorld('ducky', api);
