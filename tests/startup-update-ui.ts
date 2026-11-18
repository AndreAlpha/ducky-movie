import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';

await fs.mkdir('test-results', { recursive: true });
const directory = await fs.mkdtemp(path.resolve('test-results/startup-update-'));
const profile = path.join(directory, 'profile');
const saved = path.join(directory, 'Prima del riavvio.duckymovie');
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
env.DUCKY_TEST_USER_DATA = profile;
const executablePath = process.env.DUCKY_EXECUTABLE;
const app = await electron.launch({
  ...(executablePath ? { executablePath, args: [`--user-data-dir=${profile}`] } : { args: [path.resolve('.')] }),
  env, timeout: 45_000,
});
const page = await app.firstWindow();
page.setDefaultTimeout(20_000);
const prompt = page.getByRole('dialog', { name: 'Aggiornamento disponibile' });
const accept = prompt.getByRole('button', { name: 'Aggiorna e riavvia' });
const decline = prompt.getByRole('button', { name: 'Adesso no' });
const retry = prompt.getByRole('button', { name: 'Riprova' });
const projectName = page.getByLabel('Nome del progetto', { exact: true });

type Scenario = 'offline' | 'current' | 'offer' | 'portable' | 'cancel' | 'retry' | 'save' | 'cancel-save';

// The actual app, preload, IPC events and save path run in an isolated profile.
// Only the four updater handlers are replaced, so the suite never downloads
// or executes a real installer on the machine running it.
async function start(scenario: Scenario) {
  const mock = await app.evaluateHandle(({ ipcMain, dialog }, { scenario, saved }) => {
    for (const method of ['check', 'download', 'cancel', 'install']) ipcMain.removeHandler(`update:${method}`);
    const calls: string[] = [];
    let finishCheck: () => void;
    const ready = new Promise<void>(resolve => { finishCheck = resolve; });
    let finishDownload: () => void;
    let failDownload: (error: Error) => void;
    ipcMain.handle('update:check', async () => {
      calls.push('check');
      if (scenario === 'offline') throw new Error('Feed irraggiungibile');
      if (scenario === 'current') return null;
      if (scenario === 'save' || scenario === 'cancel-save') await ready;
      return { version: '1.10.0', installed: scenario !== 'portable' };
    });
    ipcMain.handle('update:download', async event => {
      calls.push('download');
      event.sender.send('update:progress', .4);
      if (scenario === 'retry' && calls.filter(call => call === 'download').length === 1) {
        throw new Error('Connessione interrotta');
      }
      await new Promise<void>((resolve, reject) => { finishDownload = resolve; failDownload = reject; });
      event.sender.send('update:progress', 1);
    });
    ipcMain.handle('update:cancel', () => { calls.push('cancel'); failDownload(new Error('Annullato')); });
    ipcMain.handle('update:install', () => {
      calls.push('install');
      if (scenario === 'retry' && calls.filter(call => call === 'install').length === 1) throw new Error('Installer occupato');
    });
    if (scenario === 'save' || scenario === 'cancel-save') {
      dialog.showSaveDialog = async () => {
        calls.push('save');
        return scenario === 'save' ? { canceled: false, filePath: saved } : { canceled: true, filePath: '' };
      };
    }
    return { calls, finishCheck() { finishCheck(); }, finishDownload() { finishDownload(); } };
  }, { scenario, saved });
  await page.reload();
  await expect.poll(() => mock.evaluate(state => state.calls.includes('check'))).toBe(true);
  return mock;
}

try {
  for (const mode of ['current', 'offline'] as const) {
    const mock = await start(mode);
    await expect(projectName).toBeVisible();
    await expect(prompt).toHaveCount(0);
    assert.deepEqual(await mock.evaluate(state => state.calls.filter(call => call !== 'check')), []);
  }
  const declined = await start('offer');
  await expect(decline).toBeFocused();
  await expect(prompt).toContainText('DuckyMovie 1.10.0');
  await decline.click();
  await expect(prompt).toHaveCount(0);
  assert.deepEqual(await declined.evaluate(state => state.calls.filter(call => call !== 'check')), []);

  await start('portable');
  await expect(prompt).toContainText('portatile');
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);

  const cancelled = await start('cancel');
  await accept.click();
  await expect(prompt.getByRole('progressbar')).toHaveJSProperty('value', .4);
  await prompt.getByRole('button', { name: 'Annulla download' }).click();
  await expect(prompt).toHaveCount(0);
  assert.deepEqual(await cancelled.evaluate(state => state.calls.filter(call => call !== 'check')), ['download', 'cancel']);

  const failed = await start('retry');
  await accept.click();
  await expect(prompt.getByRole('alert')).toContainText('Connessione interrotta');
  await retry.click();
  await expect(prompt.getByRole('progressbar')).toHaveJSProperty('value', .4);
  await failed.evaluate(state => state.finishDownload());
  await expect(prompt.getByRole('alert')).toContainText('Installer occupato');
  await retry.click();
  await expect(prompt.getByRole('status')).toContainText('riavvio');
  await page.keyboard.press('Escape');
  await expect(prompt).toBeVisible();
  assert.deepEqual(await failed.evaluate(state => state.calls.filter(call => call !== 'check')), ['download', 'download', 'install', 'install']);

  const dirty = await start('save');
  await projectName.fill('Prima del riavvio');
  await projectName.press('Tab');
  await dirty.evaluate(state => state.finishCheck());
  await accept.click();
  await expect(prompt.getByRole('progressbar')).toBeVisible();
  const persisted = JSON.parse(await fs.readFile(saved, 'utf8'));
  assert.equal(persisted.name, 'Prima del riavvio');
  await dirty.evaluate(state => state.finishDownload());
  await expect.poll(() => dirty.evaluate(state => state.calls.filter(call => call !== 'check'))).toEqual(['save', 'download', 'install']);

  const cancelSave = await start('cancel-save');
  await projectName.fill('Modifiche conservate');
  await projectName.press('Tab');
  await cancelSave.evaluate(state => state.finishCheck());
  await accept.click();
  await expect(prompt).toHaveCount(0);
  await expect(projectName).toHaveValue('Modifiche conservate');
  assert.deepEqual(await cancelSave.evaluate(state => state.calls.filter(call => call !== 'check')), ['save']);
  console.log(`Startup update UI passed: quiet startup, consent, portable notice, cancellation, progress, retry, automatic install handoff and unsaved project protection. ${directory}`);
} finally {
  // The last case deliberately leaves an unsaved test project.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await app.close();
}
