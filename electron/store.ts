import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateProject } from '../src/model';
import { importFile, grantFile } from './media';
import type { Project, OpenProjectResult } from '../shared/types';

interface RecentProject {
  name: string;
  path: string;
  updatedAt: string;
}

let dataDirectory = '';
let autosaveQueue: Promise<void> = Promise.resolve();

export function setDataDirectory(directory: string): void {
  dataDirectory = directory;
}

export async function atomicJSON(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function mediaImportDirectory(): Promise<string | undefined> {
  try {
    const settings = JSON.parse(await fs.readFile(path.join(dataDirectory, 'import-preferences.json'), 'utf8'));
    if (typeof settings.directory !== 'string' || !path.isAbsolute(settings.directory)) return undefined;
    return (await fs.stat(settings.directory)).isDirectory() ? settings.directory : undefined;
  } catch { return undefined; }
}

export async function rememberMediaImportDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory) || !(await fs.stat(directory)).isDirectory()) return;
  await atomicJSON(path.join(dataDirectory, 'import-preferences.json'), { directory: path.resolve(directory) });
}

function serialized(project: Project, directory: string): Project {
  return {
    ...project,
    updatedAt: new Date().toISOString(),
    assets: project.assets.map((asset) => ({
      ...asset,
      path: path.relative(directory, path.resolve(asset.path)),
      url: '',
      thumbnail: undefined,
      waveform: undefined,
      missing: undefined,
    })),
  };
}

export async function recentProjects(): Promise<RecentProject[]> {
  try {
    const recent = JSON.parse(
      await fs.readFile(path.join(dataDirectory, 'recent.json'), 'utf8'),
    );
    if (!Array.isArray(recent)) return [];
    return recent
      .filter(
        (item) =>
          typeof item?.name === 'string' &&
          typeof item?.path === 'string' &&
          typeof item?.updatedAt === 'string',
      )
      .slice(0, 12);
  } catch {
    return [];
  }
}

async function rememberProject(project: Project, file: string): Promise<void> {
  const recent = await recentProjects();
  const entry = {
    name: project.name,
    path: path.resolve(file),
    updatedAt: new Date().toISOString(),
  };
  await atomicJSON(
    path.join(dataDirectory, 'recent.json'),
    [
      entry,
      ...recent.filter(
        (item) => item.path.toLowerCase() !== entry.path.toLowerCase(),
      ),
    ].slice(0, 12),
  );
}

export async function saveProject(input: unknown, file: string): Promise<void> {
  const project = validateProject(input);
  await atomicJSON(file, serialized(project, path.dirname(file)));
  grantFile(file);
  await rememberProject(project, file);
  await autosave(project);
}

async function hydrate(
  input: unknown,
  directory: string,
): Promise<{ project: Project; missingAssets: string[] }> {
  const project = validateProject(input);
  const missingAssets: string[] = [];
  for (const asset of project.assets) {
    const original = path.resolve(directory, asset.path);
    try {
      const restored = await importFile(original);
      const requiredEnd = Math.max(
        0,
        ...project.clips
          .filter((clip) => clip.assetId === asset.id)
          .map((clip) => clip.out),
        ...project.audioTracks
          .filter((track) => track.assetId === asset.id)
          .map((track) => track.out),
      );
      if (
        restored.kind !== asset.kind ||
        (restored.kind !== 'image' && restored.duration + 0.001 < requiredEnd)
      ) {
        throw new Error(
          'Il file originale è stato sostituito con un contenuto incompatibile.',
        );
      }
      Object.assign(asset, restored, { id: asset.id });
    } catch {
      asset.path = original;
      asset.url = '';
      asset.thumbnail = undefined;
      asset.missing = true;
      missingAssets.push(asset.name);
    }
  }
  return { project, missingAssets };
}

export async function openProject(file: string): Promise<OpenProjectResult> {
  const stat = await fs.stat(file);
  if (stat.size > 50 * 1024 * 1024)
    throw new Error('Il progetto supera la dimensione massima di 50 MB.');
  const input = JSON.parse(await fs.readFile(file, 'utf8'));
  const result = await hydrate(input, path.dirname(file));
  grantFile(file);
  await rememberProject(result.project, file);
  return { ...result, path: file };
}

export function autosave(input: unknown): Promise<void> {
  const project = validateProject(input);
  autosaveQueue = autosaveQueue
    .catch(() => undefined)
    .then(() =>
      atomicJSON(
        path.join(dataDirectory, 'autosave.duckymovie'),
        serialized(project, dataDirectory),
      ),
    );
  return autosaveQueue;
}

export async function recoverAutosave(): Promise<Project | null> {
  try {
    const raw = await fs.readFile(
      path.join(dataDirectory, 'autosave.duckymovie'),
      'utf8',
    );
    return (await hydrate(JSON.parse(raw), dataDirectory)).project;
  } catch {
    return null;
  }
}

export async function clearAutosave(): Promise<void> {
  await autosaveQueue.catch(() => undefined);
  await fs.rm(path.join(dataDirectory, 'autosave.duckymovie'), { force: true });
}
