import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';

if (!process.env.DUCKY_EXECUTABLE || process.platform !== 'win32')
  throw new Error('Imposta DUCKY_EXECUTABLE sul percorso del pacchetto Windows da verificare.');
const executablePath = path.resolve(process.env.DUCKY_EXECUTABLE);
await fs.mkdir('test-results', { recursive: true });
const directory = await fs.mkdtemp(path.resolve('test-results/update-handoff-'));
const profile = path.join(directory, 'profile');
const accessFile = path.join(profile, 'update-access.json');
const log = path.join(directory, 'requests.jsonl');
const token = 'update-test-' + randomUUID();
const version = '9301.2.3';
const source = path.join(directory, 'ObserveHandoff.cs');
const binary = path.join(directory, 'ObserveHandoff.exe');
// This fixture records its command line and exits. It has no installation logic.
await fs.writeFile(source, `
using System;
using System.IO;
class ObserveHandoff {
  static void Main(string[] args) {
    File.WriteAllLines(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "handoff-args.txt"), args);
  }
}`);
const compiler = path.join(process.env.SystemRoot!, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
await promisify(execFile)(compiler, ['/nologo', '/target:winexe', '/out:' + binary, source], { windowsHide: true });
const bytes = await fs.readFile(binary);
const digest = createHash('sha256').update(bytes).digest('hex');
const base = 'https://api.github.com/repos/AndreAlpha/ducky-movie/releases';
const cdn = 'https://release-assets.githubusercontent.com/fixture/DuckyMovie.exe';
interface RequestLog { url: string; authorization: 'expected' | 'absent' | 'wrong'; redirect?: string }
async function requests(): Promise<RequestLog[]> {
  const contents = await fs.readFile(log, 'utf8').catch(() => '');
  return contents.trim() ? contents.trim().split('\n').map(line => JSON.parse(line)) : [];
}

const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
// Restrict even an early background check before the test attaches to an offline proxy.
env.NODE_USE_ENV_PROXY = '1';
env.HTTP_PROXY = env.HTTPS_PROXY = env.http_proxy = env.https_proxy = 'http://127.0.0.1:9';
env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost';
async function launch() {
  const app = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`, '--proxy-server=http://127.0.0.1:9'], env, timeout: 45_000 });
  await app.evaluate(({ app }, fixture) => {
    if (!app.isPackaged || app.getPath('userData') !== fixture.profile) throw new Error('Expected an isolated packaged application');
    const fs = process.getBuiltinModule('fs')!;
    globalThis.fetch = async (input, options) => {
      const url = String(input);
      const header = new Headers(options?.headers).get('Authorization');
      const authorization = header === null ? 'absent' : header === 'Bearer ' + fixture.token ? 'expected' : 'wrong';
      fs.appendFileSync(fixture.log, JSON.stringify({ url, authorization, redirect: options?.redirect }) + '\n');
      if (url === fixture.base + '?per_page=1' && authorization === 'expected') return Response.json([]);
      if (url === fixture.base + '/latest') {
        if (authorization !== 'expected') return new Response(null, { status: 404 });
        const name = `DuckyMovie-Setup-${fixture.version}-Windows-x64.exe`;
        return Response.json({ tag_name: 'v' + fixture.version, draft: false, prerelease: false, assets: [{
          id: 8467, name, state: 'uploaded', size: fixture.size, digest: 'sha256:' + fixture.digest,
          browser_download_url: `https://github.com/AndreAlpha/ducky-movie/releases/download/v${fixture.version}/${name}`,
        }] });
      }
      if (url === fixture.base + '/assets/8467' && authorization === 'expected')
        return new Response(null, { status: 302, headers: { Location: fixture.cdn } });
      if (url === fixture.cdn && authorization === 'absent')
        return new Response(new Uint8Array(Buffer.from(fixture.bytes, 'base64')), { headers: { 'Content-Length': String(fixture.size) } });
      throw new Error('Percorso o autorizzazione inattesi nella prova di aggiornamento.');
    };
  }, { profile, token, log, base, cdn, bytes: bytes.toString('base64'), size: bytes.length, digest, version });
  return app;
}

let running: ElectronApplication | undefined;
try {
  running = await launch();
  const settingsPage = await running.firstWindow();
  await settingsPage.getByRole('button', { name: 'Guida e scorciatoie' }).click();
  await settingsPage.getByText('Aggiornamenti da un repository privato', { exact: true }).click();
  await settingsPage.getByLabel('Token GitHub', { exact: true }).fill(token);
  await settingsPage.getByRole('button', { name: 'Salva token' }).click();
  await expect(settingsPage.getByRole('button', { name: 'Rimuovi token' })).toBeEnabled();
  const encrypted = JSON.parse(await fs.readFile(accessFile, 'utf8'));
  assert.equal(typeof encrypted, 'string');
  assert.ok(!encrypted.includes(token));
  assert.ok(!Buffer.from(encrypted, 'base64').includes(Buffer.from(token)));
  assert.ok(await settingsPage.evaluate(() => window.ducky.hasUpdateAccess()));
  await settingsPage.getByRole('button', { name: 'Rimuovi token' }).click();
  await expect(settingsPage.getByText('Token rimosso.', { exact: true })).toBeVisible();
  assert.equal(await settingsPage.evaluate(() => window.ducky.hasUpdateAccess()), false);
  await assert.rejects(fs.stat(accessFile), { code: 'ENOENT' });
  await settingsPage.getByLabel('Token GitHub', { exact: true }).fill(token);
  await settingsPage.getByRole('button', { name: 'Salva token' }).click();
  await expect(settingsPage.getByText(`DuckyMovie ${version} è disponibile. Chiudi la guida per aggiornare.`)).toBeVisible();
  await running.close();
  running = undefined;

  const beforeRestart = (await requests()).length;
  running = await launch();
  const updatePage = await running.firstWindow();
  const offer = updatePage.getByRole('dialog', { name: 'Aggiornamento disponibile' });
  await expect(offer).toContainText(`DuckyMovie ${version}`, { timeout: 15_000 });
  assert.deepEqual((await requests()).slice(beforeRestart), [{ url: base + '/latest', authorization: 'expected', redirect: 'error' }]);
  const closed = running.waitForEvent('close', { timeout: 15_000 });
  await offer.getByRole('button', { name: 'Aggiorna e riavvia' }).click();
  await closed;
  running = undefined;
  assert.deepEqual((await requests()).slice(beforeRestart + 1), [
    { url: base + '/assets/8467', authorization: 'expected', redirect: 'manual' },
    { url: cdn, authorization: 'absent', redirect: 'manual' },
  ]);
  const updates = path.join(profile, 'updates');
  const staging = (await fs.readdir(updates)).filter(name => name.startsWith('download-'));
  assert.equal(staging.length, 1);
  const marker = path.join(updates, staging[0], 'handoff-args.txt');
  await expect.poll(() => fs.readFile(marker, 'utf8').catch(() => ''), { timeout: 15_000 }).toContain('--force-run');
  assert.deepEqual((await fs.readFile(marker, 'utf8')).trim().split(/\r?\n/), ['/S', '--updated', '--force-run']);
  const staged = await fs.readFile(path.join(updates, staging[0], `DuckyMovie-Setup-${version}-Windows-x64.exe`));
  assert.equal(createHash('sha256').update(staged).digest('hex'), digest);
  console.log(`Packaged update handoff passed: Windows credential storage and removal, authenticated next launch, verified installer, CDN redirect without credentials, editor exit and actual child-process arguments. ${directory}`);
} finally {
  await running?.close();
}
