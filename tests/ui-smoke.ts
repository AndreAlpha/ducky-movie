import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';
import { ffmpegPath, ffprobePath } from '../electron/binaries';
import { runProcess } from '../electron/process';
import { projectDuration } from '../src/model';

const outputDirectory = path.resolve('test-results');
await fs.mkdir(outputDirectory, { recursive: true });
const fixtureDirectory = await fs.mkdtemp(path.join(outputDirectory, 'ui-'));
const dataDirectory = path.join(fixtureDirectory, 'app-data');
await fs.mkdir(dataDirectory, { recursive: true });
const video = path.join(fixtureDirectory, 'Un viaggio.mp4');
const photo = path.join(fixtureDirectory, 'Un ricordo.png');
const music = path.join(fixtureDirectory, 'La colonna sonora.wav');
const savedProject = path.join(fixtureDirectory, 'Il viaggio.duckymovie');
const exportedVideo = path.join(fixtureDirectory, 'Il viaggio.mp4');

await runProcess(ffmpegPath, [
  '-v',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=640x360:rate=30:duration=4',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=4',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  video,
]);
await runProcess(ffmpegPath, [
  '-v',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'color=c=0x496879:s=640x360',
  '-vf',
  'drawbox=x=0:y=240:w=640:h=120:color=0x364f40:t=fill,drawbox=x=50:y=170:w=220:h=110:color=0x688276:t=fill',
  '-frames:v',
  '1',
  photo,
]);
await runProcess(ffmpegPath, [
  '-v',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=220:duration=10',
  music,
]);

const appEnvironment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  DUCKY_TEST_USER_DATA: dataDirectory,
} as Record<string, string>;
delete appEnvironment.ELECTRON_RUN_AS_NODE;
const executable = process.env.DUCKY_EXECUTABLE;
if (executable) {
  const windowsDirectory = process.env.WINDIR || 'C:\\Windows';
  appEnvironment.Path = `${windowsDirectory}\\System32;${windowsDirectory}`;
  appEnvironment.PATH = appEnvironment.Path;
  delete appEnvironment.DUCKY_FFMPEG_PATH;
  delete appEnvironment.DUCKY_FFPROBE_PATH;
  delete appEnvironment.DUCKY_ENGINE_EXECUTABLE;
}
const launchOptions = {
  ...(executable
    ? { executablePath: executable, args: [`--user-data-dir=${dataDirectory}`] }
    : { args: [path.resolve('.')] }),
  env: appEnvironment,
  timeout: 45000,
};
const application = await electron.launch(launchOptions);
const errors: string[] = [];
try {
  const page = await application.firstWindow();
  assert.equal(
    path.resolve(
      await application.evaluate(({ app }) => app.getPath('userData')),
    ),
    dataDirectory,
    'Profilo di test isolato',
  );
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('heading', { name: 'La libreria è vuota' }).waitFor();
  await page.screenshot({
    path: path.join(outputDirectory, 'editor-empty.png'),
  });
  const emptyBounds = await page.locator('.viewer-empty').boundingBox();
  assert.ok(
    emptyBounds && emptyBounds.height > 120 && emptyBounds.width > 250,
    'Anteprima vuota visibile',
  );

  await application.evaluate(
    ({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: files,
      });
    },
    [video, photo, music],
  );
  await page
    .getByRole('button', { name: 'Importa media', exact: true })
    .click();
  await page
    .getByRole('button', {
      name: 'Aggiungi Un viaggio.mp4 al film',
      exact: true,
    })
    .waitFor({ timeout: 60000 });
  await page
    .getByRole('button', {
      name: 'Aggiungi Un viaggio.mp4 al film',
      exact: true,
    })
    .click();
  await page.locator('.timeline-clip').first().waitFor();
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    return !!video && video.readyState >= 2 && video.videoWidth === 640;
  });
  const stageBounds = await page.locator('.preview-stage').boundingBox();
  assert.ok(
    stageBounds && stageBounds.width > 250 && stageBounds.height > 100,
    'Anteprima video dimensionata',
  );
  await page
    .getByRole('button', {
      name: 'Aggiungi Un ricordo.png al film',
      exact: true,
    })
    .click();
  await page
    .getByRole('button', {
      name: 'Aggiungi La colonna sonora.wav al film',
      exact: true,
    })
    .click();
  assert.equal(await page.locator('.timeline-clip').count(), 2);
  await page
    .locator('.timeline-clip')
    .first()
    .click({ position: { x: 30, y: 30 } });
  await page.getByRole('button', { name: 'Titolo', exact: true }).click();
  await page
    .getByLabel('Testo del titolo', { exact: true })
    .fill('Un viaggio da ricordare');
  await page
    .getByRole('complementary', { name: 'Proprietà della selezione' })
    .getByRole('button', { name: 'Video', exact: true })
    .click();
  await page
    .getByLabel('Velocità della clip', { exact: true })
    .selectOption('2');
  await page.getByLabel('Filtro colore', { exact: true }).selectOption('warm');
  await page.getByLabel('Entrata clip in secondi', { exact: true }).fill('0.2');
  await page.getByLabel('Uscita clip in secondi', { exact: true }).fill('3.8');
  await page
    .getByLabel('Nome del progetto', { exact: true })
    .fill('Il viaggio');
  await page.getByLabel('Nome del progetto', { exact: true }).press('Tab');

  await application.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, savedProject);
  await page
    .getByRole('button', { name: 'Salva progetto · Ctrl+S', exact: true })
    .click();
  await page.getByText('Progetto salvato', { exact: true }).waitFor();
  const persisted = JSON.parse(await fs.readFile(savedProject, 'utf8'));
  assert.equal(persisted.name, 'Il viaggio');
  assert.equal(persisted.clips[0].title.text, 'Un viaggio da ricordare');
  assert.equal(persisted.clips[0].speed, 2);
  assert.equal(persisted.audioTracks.length, 1);
  assert.ok(!path.isAbsolute(persisted.assets[0].path));

  // A split through normal keyboard input preserves the source trim and total duration.
  const clip = page.locator('.timeline-clip').first();
  await clip.click({ position: { x: 24, y: 35 } });
  await page.keyboard.press('Control+b');
  assert.equal(await page.locator('.timeline-clip').count(), 3);
  await page
    .getByRole('button', { name: 'Annulla · Ctrl+Z', exact: true })
    .click();
  assert.equal(await page.locator('.timeline-clip').count(), 2);
  await page
    .getByRole('button', { name: 'Ripeti · Ctrl+Y', exact: true })
    .click();
  assert.equal(await page.locator('.timeline-clip').count(), 3);
  await page
    .getByRole('button', { name: 'Annulla · Ctrl+Z', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Salva progetto · Ctrl+S', exact: true })
    .click();

  await application.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [target],
    });
  }, savedProject);
  await page
    .getByRole('button', { name: 'Apri progetto · Ctrl+O', exact: true })
    .click();
  await page.getByText('Progetto aperto', { exact: true }).waitFor();
  assert.equal(await page.locator('.timeline-clip').count(), 2);
  await page
    .getByRole('button', { name: 'Torna all’inizio · Home', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Riproduci · Spazio', exact: true })
    .click();
  await page.waitForFunction(() =>
    document.querySelector('.timecode')?.textContent?.startsWith('00:00:01'),
  );
  await page
    .getByRole('button', { name: 'Pausa · Spazio', exact: true })
    .click();
  await page
    .locator('.timeline-clip')
    .first()
    .click({ position: { x: 10, y: 35 } });
  await page.screenshot({
    path: path.join(outputDirectory, 'editor-montage.png'),
  });

  await page
    .getByRole('button', { name: 'Guida e scorciatoie', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Il tuo studio di montaggio', exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog[open]').count(), 0);

  await application.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, exportedVideo);
  await page.getByRole('button', { name: 'Esporta film', exact: true }).click();
  await page
    .getByLabel('Risoluzione esportazione', { exact: true })
    .selectOption('720p');
  await page
    .getByRole('button', { name: 'Scegli dove salvare', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Il tuo film è pronto', exact: true })
    .waitFor({ timeout: 120000 });
  const probe = JSON.parse(
    (
      await runProcess(ffprobePath, [
        '-v',
        'error',
        '-show_format',
        '-show_streams',
        '-of',
        'json',
        exportedVideo,
      ])
    ).toString(),
  );
  assert.ok(
    Math.abs(Number(probe.format.duration) - projectDuration(persisted)) < 0.15,
    `Durata esportata ${probe.format.duration}`,
  );
  assert.equal(
    probe.streams.find(
      (stream: { codec_type: string }) => stream.codec_type === 'video',
    ).codec_name,
    'h264',
  );
  await page.screenshot({
    path: path.join(outputDirectory, 'export-complete.png'),
  });
  await page.getByRole('button', { name: 'Chiudi', exact: true }).click();
  await page.setViewportSize({ width: 1050, height: 720 });
  await page
    .getByLabel('Formato del film', { exact: true })
    .selectOption('9:16');
  const portraitBounds = await page.locator('.preview-stage').boundingBox();
  assert.ok(
    portraitBounds &&
      Math.abs(portraitBounds.width / portraitBounds.height - 9 / 16) < 0.02,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: path.join(outputDirectory, 'editor-compact.png'),
  });
  await page
    .getByLabel('Formato del film', { exact: true })
    .selectOption('16:9');
  await page
    .getByRole('button', { name: 'Salva progetto · Ctrl+S', exact: true })
    .click();
  assert.deepEqual(errors, []);
  console.log(
    `Verifica UI superata. Importazione, anteprima, titoli, ritaglio, velocità, split/undo/redo, audio, salvataggio, riapertura, guida ed esportazione MP4 verificati.\nRisultati in ${fixtureDirectory}`,
  );
} finally {
  await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await application.close().catch(() => undefined);
}

// Simulate an interrupted session, then verify recovery and the native Save-on-close handshake.
const recoveredApplication = await electron.launch(launchOptions);
try {
  const page = await recoveredApplication.firstWindow();
  await page
    .getByRole('heading', { name: 'Riprendi la tua storia', exact: true })
    .waitFor({ timeout: 45000 });
  await page
    .getByRole('button', { name: 'Riprendi il progetto', exact: true })
    .click();
  await page.locator('.timeline-clip').first().waitFor();
  assert.equal(await page.locator('.timeline-clip').count(), 2);
  await page
    .getByLabel('Nome del progetto', { exact: true })
    .fill('Il viaggio recuperato');
  await page.getByLabel('Nome del progetto', { exact: true }).press('Tab');
  const recoveredFile = path.join(fixtureDirectory, 'Recuperato.duckymovie');
  await recoveredApplication.evaluate(({ dialog }, target) => {
    dialog.showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false,
    });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, recoveredFile);
  const closed = recoveredApplication.waitForEvent('close', { timeout: 30000 });
  await recoveredApplication.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close();
  });
  await closed;
  assert.equal(
    JSON.parse(await fs.readFile(recoveredFile, 'utf8')).name,
    'Il viaggio recuperato',
  );
  await assert.rejects(
    fs.access(path.join(dataDirectory, 'autosave.duckymovie')),
  );
  console.log(
    'Recupero dopo interruzione e salvataggio alla chiusura verificati.',
  );
} finally {
  await recoveredApplication
    .evaluate(({ app }) => app.exit(0))
    .catch(() => undefined);
  await recoveredApplication.close().catch(() => undefined);
}
