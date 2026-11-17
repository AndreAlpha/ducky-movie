import { BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project } from '../shared/types';
import { createProjectTemplate, validateProject } from '../src/model';
import { gatherLegacyPaths, convertLegacyProject } from './legacy';
import { importFile, importFiles, grantFile } from './media';
import { atomicJSON } from './store';
import { protectSourceFiles } from './files';

export function registerProjectExchange(getWindow: () => BrowserWindow | null): void {
  const owner = () => { const window = getWindow(); if (!window) throw new Error('La finestra non è disponibile.'); return window; };
  function trusted(event: Electron.IpcMainInvokeEvent): void {
    const window = owner();
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Richiesta non autorizzata.');
  }
  async function read(file: string): Promise<unknown> {
    const stat = await fs.stat(file);
    if (stat.size > 50 * 1024 * 1024) throw new Error('Il progetto supera 50 MB.');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }
  async function legacy(file: string): Promise<Project> {
    const raw = await read(file);
    const imported = await importFiles(gatherLegacyPaths(raw, path.dirname(file)));
    if (imported.errors.length) throw new Error(`Ripristina i media prima di importare il progetto:\n${imported.errors.join('\n')}`);
    return convertLegacyProject(raw, imported.assets, path.dirname(file));
  }
  ipcMain.handle('project:import-legacy', async (event) => {
    trusted(event);
    const selected = await dialog.showOpenDialog(owner(), { title: 'Importa un progetto DuckyPlay', properties: ['openFile'], filters: [{ name: 'Progetto o modello DuckyPlay', extensions: ['json'] }] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    return legacy(selected.filePaths[0]);
  });
  ipcMain.handle('template:save', async (event, input: unknown) => {
    trusted(event);
    const project = validateProject(input);
    const template = createProjectTemplate(project);
    const selected = await dialog.showSaveDialog(owner(), { title: 'Salva modello', defaultPath: `${project.name.replace(/[<>:"/\\|?*]/g, '-')}.duckymodel`, filters: [{ name: 'Modello DuckyMovie', extensions: ['duckymodel'] }] });
    if (selected.canceled || !selected.filePath) return null;
    await protectSourceFiles(selected.filePath, project.assets.map(asset => asset.path));
    const directory = path.dirname(selected.filePath);
    await atomicJSON(selected.filePath, { kind: 'duckymovie-template', version: 1, project: { ...template, assets: template.assets.map(asset => ({ ...asset, path: path.relative(directory, path.resolve(asset.path)), url: '', thumbnail: undefined, waveform: undefined, missing: undefined })) } });
    grantFile(selected.filePath);
    return selected.filePath;
  });
  ipcMain.handle('template:open', async (event) => {
    trusted(event);
    const selected = await dialog.showOpenDialog(owner(), { title: 'Applica modello', properties: ['openFile'], filters: [{ name: 'Modelli DuckyMovie o DuckyPlay', extensions: ['duckymodel', 'json'] }] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const file = selected.filePaths[0];
    const input = await read(file);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Il file non contiene un modello valido.');
    const raw = input as { kind?: string; version?: number; project?: unknown };
    if (raw.kind !== 'duckymovie-template') return legacy(file);
    if (raw.version !== 1) throw new Error('Questa versione del modello non è supportata.');
    const project = validateProject(raw.project);
    project.assets = await Promise.all(project.assets.map(async asset => {
      try {
        const source = await importFile(path.resolve(path.dirname(file), asset.path));
        if (source.kind !== asset.kind) throw new Error('Tipo del file modificato');
        return { ...source, id: asset.id };
      }
      catch { throw new Error(`Ripristina il media del modello: ${asset.name}`); }
    }));
    return validateProject({ ...project, id: randomUUID() });
  });
}
