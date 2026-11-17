import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  shell,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  decodeMediaURL,
  grantFile,
  importFiles,
  isFileGranted,
  getImportedSourcePaths,
  setCacheDirectory,
} from './media';
import * as store from './store';
import { ExportJob } from './export';
import { configureEngine, EngineTask, EngineExportJob, needsAdvancedExport } from './engine';
import { registerProjectExchange } from './project-exchange';
import { projectDuration, validateProject } from '../src/model';
import { formatTranscript, validateTranscript } from './transcript';
import { protectSourceFiles } from './files';
import { getExportCapabilities } from './encoding';
import type { AutomationRequest, AutomationProgress, ExportSettings } from '../shared/types';

if (process.env.DUCKY_TEST_USER_DATA && !app.isPackaged) {
  app.setPath('userData', path.resolve(process.env.DUCKY_TEST_USER_DATA));
}
const userDataArgument = process.argv.find((argument) =>
  argument.startsWith('--user-data-dir='),
);
if (userDataArgument)
  app.setPath(
    'userData',
    path.resolve(userDataArgument.slice('--user-data-dir='.length)),
  );

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ducky-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

let window: BrowserWindow | null = null;
let dirty = false;
let allowClose = false;
let waitingForCloseSave = false;
let closeAfterSave = false;
let closingDialog = false;
let currentProjectPath: string | undefined;
const exports = new Map<string, ExportJob | EngineExportJob>();
const automations = new Map<string, EngineTask>();

const mimeTypes: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

function trusted(
  event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
): void {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error('Richiesta non autorizzata.');
  }
}

function registerMediaProtocol(): void {
  protocol.handle('ducky-media', async (request) => {
    const file = decodeMediaURL(request.url);
    if (!file) return new Response('File non autorizzato', { status: 403 });
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response(null, { status: 405 });
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) return new Response(null, { status: 404 });
      const headers: Record<string, string> = {
        'Content-Type':
          mimeTypes[path.extname(file).toLowerCase()] ||
          'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
      };
      const range = request.headers.get('range');
      let start = 0;
      let end = stat.size - 1;
      let status = 200;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2]))
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${stat.size}` },
          });
        if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
        else start = Number(match[1]);
        if (match[1] && match[2]) end = Math.min(end, Number(match[2]));
        if (start > end || start >= stat.size)
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${stat.size}` },
          });
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      }
      headers['Content-Length'] = String(Math.max(0, end - start + 1));
      const body =
        request.method === 'HEAD' || !stat.size
          ? null
          : Readable.toWeb(createReadStream(file, { start, end }));
      return new Response(body as ReadableStream<Uint8Array> | null, {
        status,
        headers,
      });
    } catch {
      return new Response('File non disponibile', { status: 404 });
    }
  });
}

function validateSettings(input: unknown): ExportSettings {
  const settings = input as ExportSettings;
  if (
    !settings ||
    !['720p', '1080p', '1440p', '2160p'].includes(settings.resolution) ||
    ![24, 25, 30, 60].includes(settings.fps) ||
    !['standard', 'high'].includes(settings.quality) ||
    settings.acceleration !== undefined && !['auto','cpu'].includes(settings.acceleration)
  ) {
    throw new Error('Le impostazioni di esportazione non sono valide.');
  }
  if (settings.framePng && (typeof settings.framePng !== 'string' || !settings.framePng.startsWith('data:image/png;base64,') || settings.framePng.length > 40 * 1024 * 1024)) throw new Error('La cornice da esportare non è valida.');
  return { resolution:settings.resolution,fps:settings.fps,quality:settings.quality,acceleration:settings.acceleration??'auto',...(settings.framePng?{framePng:settings.framePng}:{}) };
}

function validateAutomation(input: unknown): AutomationRequest {
  const request = input as AutomationRequest;
  if (!request || !['highlights', 'transcribe', 'match', 'short-base', 'read-script'].includes(request.action) || !request.payload || typeof request.payload !== 'object') throw new Error('Operazione non valida.');
  if (JSON.stringify(request.payload).length > 20 * 1024 * 1024) throw new Error('La richiesta contiene troppi dati.');
  const paths = [request.payload.path, ...(Array.isArray(request.payload.paths) ? request.payload.paths : []), ...(Array.isArray(request.payload.images) ? request.payload.images : [])].filter(file => file !== undefined);
  if (paths.some(file => typeof file !== 'string' || !isFileGranted(file))) throw new Error('Importa i file nel progetto prima di analizzarli.');
  return request;
}

function registerIPC(): void {
  registerProjectExchange(() => window);
  const handle = (channel: string, callback: (...args: any[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      trusted(event);
      return callback(...args);
    });
  };
  handle('app:version', () => app.getVersion());
  handle('export:capabilities', () => getExportCapabilities());
  handle('transcript:export', async (input: unknown, format: unknown) => {
    if (format !== 'srt' && format !== 'txt') throw new Error('Formato della trascrizione non valido.');
    const subtitles = validateTranscript(input);
    if (!subtitles.words.length) throw new Error('La trascrizione è vuota.');
    const result = await dialog.showSaveDialog(window!, {
      title: 'Esporta la trascrizione',
      defaultPath: path.join(app.getPath('documents'), `Trascrizione.${format}`),
      filters: [{ name: format === 'srt' ? 'Sottotitoli SRT' : 'Testo', extensions: [format] }],
    });
    if (result.canceled || !result.filePath) return null;
    const output = result.filePath.toLowerCase().endsWith(`.${format}`) ? result.filePath : `${result.filePath}.${format}`;
    await protectSourceFiles(output, [...getImportedSourcePaths(), ...(currentProjectPath ? [currentProjectPath] : [])]);
    const temporary = `${output}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, formatTranscript(subtitles, format), 'utf8');
      await fs.rename(temporary, output);
      grantFile(output);
      return output;
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  });
  handle('automation:start', (input: unknown) => {
    if (automations.size) throw new Error('Attendi il completamento dell’analisi in corso.');
    const request = validateAutomation(input);
    const payload = { ...request.payload };
    let task: EngineTask;
    const send = (event: AutomationProgress) => { if (!window?.isDestroyed()) window?.webContents.send('automation:progress', event); };
    task = new EngineTask(request.action, payload, (progress, message) => send({ jobId: task.id, progress, message, state: 'running' }));
    const generatedDirectory = path.join(app.getPath('userData'), 'generated', task.id);
    if (request.action === 'short-base') payload.outputDir = generatedDirectory;
    automations.set(task.id, task);
    setTimeout(() => {
      void task.run().then(result => {
        const file = (result as { path?: string })?.path;
        if (file) grantFile(file);
        send({ jobId: task.id, progress: 1, state: 'complete', message: 'Operazione completata', result });
      }).catch(error => {
        const cancelled = error instanceof Error && error.message === 'cancelled';
        send({ jobId: task.id, progress: 0, state: cancelled ? 'cancelled' : 'error', message: cancelled ? 'Operazione annullata' : 'Operazione non riuscita', error: cancelled ? undefined : error instanceof Error ? error.message : String(error) });
        void fs.rm(generatedDirectory, { recursive: true, force: true }).catch(() => undefined);
      }).finally(() => automations.delete(task.id));
    }, 50);
    return { jobId: task.id };
  });
  handle('automation:cancel', (id: string) => automations.get(id)?.cancel());
  handle('script:import', async () => {
    const selection = await dialog.showOpenDialog(window!, { title: 'Importa il copione', properties: ['openFile'], filters: [{ name: 'Copione Word o testo', extensions: ['docx', 'txt'] }] });
    if (selection.canceled) return null;
    const file = selection.filePaths[0];
    if ((await fs.stat(file)).size > 10 * 1024 * 1024) throw new Error('Il copione supera 10 MB.');
    grantFile(file);
    return new EngineTask('read-script', { path: file }, () => undefined).run();
  });
  handle('media:import', async (paths?: string[]) => {
    if (
      paths &&
      (!Array.isArray(paths) ||
        paths.length > 500 ||
        paths.some(
          (file) => typeof file !== 'string' || !path.isAbsolute(file),
        ))
    )
      throw new Error('Selezione dei file non valida.');
    let selected = paths;
    if (!selected) {
      const result = await dialog.showOpenDialog(window!, {
        title: 'Importa in DuckyMovie',
        defaultPath: await store.mediaImportDirectory(),
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: 'Video, immagini e audio',
            extensions: [
              'mp4',
              'mov',
              'm4v',
              'mkv',
              'webm',
              'avi',
              'wmv',
              'mts',
              'm2ts',
              'mpg',
              'mpeg',
              'jpg',
              'jpeg',
              'png',
              'webp',
              'bmp',
              'tif',
              'tiff',
              'heic',
              'avif',
              'mp3',
              'wav',
              'm4a',
              'aac',
              'flac',
              'ogg',
              'opus',
            ],
          },
          { name: 'Tutti i file', extensions: ['*'] },
        ],
      });
      if (result.canceled) return { assets: [], errors: [] };
      selected = result.filePaths;
      if (selected.length) await store.rememberMediaImportDirectory(path.dirname(selected[0])).catch(()=>undefined);
    }
    return importFiles(selected);
  });
  handle('project:open', async (file?: string) => {
    if (file && (typeof file !== 'string' || !path.isAbsolute(file)))
      throw new Error('Percorso del progetto non valido.');
    if (!file) {
      const result = await dialog.showOpenDialog(window!, {
        title: 'Apri un progetto DuckyMovie',
        properties: ['openFile'],
        filters: [{ name: 'Progetto DuckyMovie', extensions: ['duckymovie'] }],
      });
      if (result.canceled) return null;
      file = result.filePaths[0];
    }
    const result = await store.openProject(file);
    currentProjectPath = file;
    return result;
  });
  handle(
    'project:save',
    async (input: unknown, file?: string, forceDialog = false) => {
      const project = validateProject(input);
      if (file && (typeof file !== 'string' || !path.isAbsolute(file)))
        throw new Error('Percorso di salvataggio non valido.');
      let target = file;
      if (!target || forceDialog) {
        const result = await dialog.showSaveDialog(window!, {
          title: 'Salva il progetto DuckyMovie',
          defaultPath:
            target ||
            path.join(
              app.getPath('documents'),
              `${project.name.replace(/[<>:"/\\|?*]/g, '-').slice(0, 120)}.duckymovie`,
            ),
          filters: [
            { name: 'Progetto DuckyMovie', extensions: ['duckymovie'] },
          ],
        });
        if (result.canceled || !result.filePath) {
          waitingForCloseSave = false;
          return null;
        }
        target = result.filePath.endsWith('.duckymovie')
          ? result.filePath
          : `${result.filePath}.duckymovie`;
      }
      try {
        await protectSourceFiles(
          target,
          project.assets.map((asset) => asset.path),
        );
        await store.saveProject(project, target);
        currentProjectPath = target;
        if (waitingForCloseSave) {
          waitingForCloseSave = false;
          closeAfterSave = true;
        }
        return target;
      } catch (error) {
        waitingForCloseSave = false;
        throw error;
      }
    },
  );
  handle('project:autosave', store.autosave);
  handle('project:recover', store.recoverAutosave);
  handle('project:clear-autosave', store.clearAutosave);
  handle('project:recent', store.recentProjects);
  handle('file:reveal', async (file: string) => {
    if (typeof file !== 'string' || !isFileGranted(file))
      throw new Error('File non disponibile.');
    shell.showItemInFolder(file);
  });
  handle('export:start', async (input: unknown, options: unknown) => {
    if (exports.size)
      throw new Error('Attendi il completamento dell’esportazione in corso.');
    const project = validateProject(input);
    const settings = validateSettings(options);
    if (projectDuration(project) <= 0)
      throw new Error('Aggiungi un video, un’immagine o un audio alla timeline.');
    const result = await dialog.showSaveDialog(window!, {
      title: 'Esporta il filmato',
      defaultPath: path.join(
        app.getPath('videos'),
        `${project.name.replace(/[<>:"/\\|?*]/g, '-').slice(0, 120)}.mp4`,
      ),
      filters: [{ name: 'Video MP4', extensions: ['mp4'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const output = result.filePath.toLowerCase().endsWith('.mp4')
      ? result.filePath
      : `${result.filePath}.mp4`;
    await protectSourceFiles(output, [
      ...project.assets.map((asset) => asset.path),
      ...(currentProjectPath ? [currentProjectPath] : []),
    ]);
    const Job = needsAdvancedExport(project, settings) ? EngineExportJob : ExportJob;
    const job = new Job(project, settings, output, (progress) => {
      if (!window?.isDestroyed())
        window?.webContents.send('export:progress', progress);
      if (progress.state !== 'running') {
        exports.delete(progress.jobId);
        if (progress.state === 'complete') grantFile(output);
      }
    });
    exports.set(job.id, job);
    setTimeout(() => {
      void job.start();
    }, 50);
    return { jobId: job.id, path: output };
  });
  handle('export:cancel', (id: string) => exports.get(id)?.cancel());
  ipcMain.on('project:dirty', (event, changed: unknown) => {
    trusted(event);
    dirty = Boolean(changed);
    window?.setDocumentEdited(dirty);
    if (closeAfterSave) {
      closeAfterSave = false;
      if (!dirty) {
        void store.clearAutosave().then(() => {
          if (!dirty) {
            allowClose = true;
            window?.close();
          }
        });
      }
    }
  });
}

async function requestClose(): Promise<void> {
  if (closingDialog || waitingForCloseSave || !window) return;
  closingDialog = true;
  try {
    if (exports.size) {
      const answer = await dialog.showMessageBox(window, {
        type: 'question',
        title: 'Esportazione in corso',
        message: 'Vuoi interrompere l’esportazione e chiudere DuckyMovie?',
        buttons: ['Continua a lavorare', 'Interrompi e chiudi'],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response !== 1) return;
    }
    if (dirty) {
      const answer = await dialog.showMessageBox(window, {
        type: 'question',
        title: 'Salva il progetto',
        message: 'Vuoi salvare le modifiche al progetto prima di chiudere?',
        buttons: ['Salva', 'Esci senza salvare', 'Annulla'],
        defaultId: 0,
        cancelId: 2,
      });
      if (answer.response === 2) return;
      if (answer.response === 0) {
        waitingForCloseSave = true;
        window.webContents.send('project:save-requested');
        return;
      }
    }
    for (const job of exports.values()) job.cancel();
    for (const task of automations.values()) task.cancel();
    await store.clearAutosave();
    allowClose = true;
    window.close();
  } finally {
    closingDialog = false;
  }
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    title: 'DuckyMovie',
    width: 1480,
    height: 940,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#101114',
    icon: path.join(__dirname, '../dist/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('close', (event) => {
    if (!allowClose) {
      event.preventDefault();
      void requestClose();
    }
  });
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'Salva progetto',
          accelerator: 'CmdOrCtrl+S',
          click: () => window?.webContents.send('project:save-requested'),
        },
        { type: 'separator' },
        { role: 'close', label: 'Chiudi' },
      ],
    },
    {
      label: 'Modifica',
      submenu: [
        { role: 'cut', label: 'Taglia testo' },
        { role: 'copy', label: 'Copia testo' },
        { role: 'paste', label: 'Incolla testo' },
        { role: 'selectAll', label: 'Seleziona tutto' },
      ],
    },
    {
      label: 'Visualizza',
      submenu: [
        { role: 'togglefullscreen', label: 'Schermo intero' },
        ...(app.isPackaged
          ? []
          : [
              {
                role: 'toggleDevTools' as const,
                label: 'Strumenti di sviluppo',
              },
            ]),
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
  window.setMenuBarVisibility(false);
  if (process.env.DUCKY_DEV_URL)
    await window.loadURL(process.env.DUCKY_DEV_URL);
  else await window.loadFile(path.join(__dirname, '../dist/index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  void app.whenReady().then(async () => {
    app.setAppUserModelId('it.duckymovie.desktop');
    store.setDataDirectory(app.getPath('userData'));
    setCacheDirectory(path.join(app.getPath('userData'), 'media-cache'));
    configureEngine(app.getPath('userData'), app.isPackaged ? process.resourcesPath : undefined);
    registerMediaProtocol();
    registerIPC();
    await createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    for (const job of exports.values()) job.cancel();
    for (const task of automations.values()) task.cancel();
  });
}
