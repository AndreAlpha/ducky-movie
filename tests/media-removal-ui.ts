import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { ffmpegPath } from '../electron/binaries';
import { runProcess } from '../electron/process';
import { createAudioTrack, createClip, createProject, createSubtitles, linkSubtitlesToTimeline, projectDuration, timelinePositions, validateProject } from '../src/model';

await fs.mkdir('test-results', { recursive: true });
const directory = await fs.mkdtemp(path.resolve('test-results/media-removal-ui-'));
const files = ['Foto usata.png', 'Foto mantenuta.png', 'Foto libera.png', 'Altra foto libera.png', 'Voce.wav'].map(name => path.join(directory, name));
await runProcess(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=royalblue:s=320x180', '-frames:v', '1', files[0]]);
for (const file of files.slice(1, 4)) await fs.copyFile(files[0], file);
await runProcess(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', files[4]]);
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
env.DUCKY_TEST_USER_DATA = path.join(directory, 'user');
const executablePath = process.env.DUCKY_EXECUTABLE;
if (executablePath) {
  env.Path = `${process.env.WINDIR}\\System32;${process.env.WINDIR}`; env.PATH = env.Path;
  delete env.DUCKY_ENGINE_EXECUTABLE; delete env.DUCKY_FFMPEG_PATH; delete env.DUCKY_FFPROBE_PATH;
}
const app = await electron.launch({ ...(executablePath ? { executablePath, args: [`--user-data-dir=${env.DUCKY_TEST_USER_DATA}`] } : { args: [path.resolve('.')] }), env, timeout: 45000 });
const page = await app.firstWindow();
page.setDefaultTimeout(30000);
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
const projectFile = path.join(directory, 'Rimozione media.duckymovie');
async function save() {
  const before = await fs.stat(projectFile).then(stat => stat.mtimeMs);
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.stat(projectFile).then(stat => stat.mtimeMs)).toBeGreaterThan(before);
  return validateProject(JSON.parse(await fs.readFile(projectFile, 'utf8')));
}
try {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('heading', { name: 'La libreria è vuota' }).waitFor();
  const imported = await page.evaluate(paths => window.ducky.importMedia(paths), files);
  assert.deepEqual(imported.errors, []);
  const [used, kept, unused, another, voice] = files.map(file => imported.assets.find(asset => asset.path === file)!);
  const narration = createAudioTrack(voice, 1);
  let fixture = createProject('Rimozione media');
  fixture.assets = imported.assets;
  fixture.clips = [createClip(used), createClip(kept), createClip(used)];
  fixture.audioTracks = [narration];
  fixture.overlays = [{ id: 'logo', kind: 'image', assetId: used.id, start: 0, end: 8, x: .5, y: .5, width: .2, opacity: 1, animation: 'none' }];
  fixture.subtitles = { ...createSubtitles(), words: [
    { id: 'voice-word', text: 'Voce', start: 1.5, end: 2, source: { kind: 'audio', id: narration.id, start: .5, end: 1 } },
    { id: 'free-word', detached: true, text: 'Manuale', start: 10, end: 11 },
  ] };
  fixture = linkSubtitlesToTimeline(fixture);
  await fs.writeFile(projectFile, JSON.stringify(fixture));
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, projectFile);
  await page.keyboard.press('Control+o');
  await expect(page.locator('.asset-card')).toHaveCount(5);
  await expect(page.locator('.timeline-clip')).toHaveCount(3);

  // Typing in library search must never delete a selected media or timeline clip.
  await page.getByRole('button', { name: `Anteprima di ${used.name}`, exact: true }).click();
  const search = page.getByLabel('Cerca nella libreria', { exact: true });
  await search.fill('Foto'); await search.press('Home'); await search.press('Delete');
  await expect(search).toHaveValue('oto'); await search.fill('');
  await expect(page.locator('.asset-card')).toHaveCount(5);
  await expect(page.locator('dialog[open]')).toHaveCount(0);

  // A click on the card's text must focus the library, even after timeline focus.
  await page.locator('.timeline-clip').first().click();
  await page.locator(`[data-asset-id="${another.id}"] .asset-bottom span`).click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.asset-card')).toHaveCount(4);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('.timeline-clip')).toHaveCount(3);
  await page.keyboard.press('Control+z'); await expect(page.locator('.asset-card')).toHaveCount(5);

  // A mixed multi-selection asks once; Escape and Cancel both leave it intact.
  await page.getByRole('button', { name: `Anteprima di ${used.name}`, exact: true }).click();
  await page.getByRole('button', { name: `Anteprima di ${unused.name}`, exact: true }).click({ modifiers: ['Control'] });
  await page.keyboard.press('Delete');
  let dialog = page.getByRole('dialog', { name: 'Rimuovere 2 media?', exact: true });
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Annulla', exact: true })).toBeFocused();
  await expect(dialog).toContainText('spazi vuoti');
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await expect(page.locator('.asset-card.selected')).toHaveCount(2);
  await page.keyboard.press('Delete'); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Annulla', exact: true }).click();
  await expect(page.locator('.timeline-clip')).toHaveCount(3);
  await page.keyboard.press('Delete'); await expect(dialog).toBeVisible();
  await page.screenshot({ path: path.join(directory, 'confirmation.png') });
  await dialog.getByRole('button', { name: 'Rimuovi dal progetto e dalla timeline', exact: true }).click();
  await expect(page.locator('.asset-card')).toHaveCount(3);
  await expect(page.locator('.timeline-clip')).toHaveCount(1);
  let saved = await save();
  assert.deepEqual(timelinePositions(saved).map(entry => [entry.clip.assetId, entry.start]), [[kept.id, 5]]);
  assert.equal(projectDuration(saved), 15);
  assert.equal(saved.overlays!.length, 0);
  assert.equal(saved.audioTracks[0].start, 1);
  assert.deepEqual(saved.subtitles!.words.map(word => word.text), ['Voce', 'Manuale']);

  // Delete all remaining media from the focused library, including source captions.
  await page.locator('.media-selection-area').focus(); await page.keyboard.press('Control+a'); await page.keyboard.press('Delete');
  dialog = page.getByRole('dialog', { name: 'Rimuovere 3 media?', exact: true });
  await expect(dialog).toContainText('2 media selezionati');
  await dialog.getByRole('button', { name: 'Rimuovi dal progetto e dalla timeline', exact: true }).click();
  await expect(page.locator('.asset-card')).toHaveCount(0);
  saved = await save();
  assert.equal(saved.clips.length, 0); assert.equal(saved.audioTracks.length, 0);
  assert.equal(projectDuration(saved), 15);
  assert.deepEqual(saved.subtitles!.words.map(word => word.text), ['Manuale']);
  await page.keyboard.press('Control+z'); await expect(page.locator('.asset-card')).toHaveCount(3);
  await page.keyboard.press('Control+z'); await expect(page.locator('.asset-card')).toHaveCount(5);
  saved = await save();
  assert.deepEqual(saved.clips, fixture.clips);
  assert.deepEqual(saved.audioTracks, fixture.audioTracks);
  assert.deepEqual(saved.overlays, fixture.overlays);
  assert.deepEqual(saved.subtitles, fixture.subtitles);
  for (const file of files) await fs.access(file);
  assert.deepEqual(errors, []);
  console.log(`Media removal UI passed: Delete, typing/card focus, cancel/Escape, bulk confirmation, gaps, audio/captions/logo cleanup, complete Undo and original files intact. ${directory}`);
} catch (error) {
  await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
  console.error(await page.locator('body').innerText().catch(() => '<closed>')); throw error;
} finally {
  // Let Playwright own the quit handshake. Calling app.exit inside evaluate can
  // leave its inspector request pending; no save prompt is needed for fixtures.
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.removeAllListeners('close');
  }).catch(() => {});
  await app.close().catch(() => {});
}
