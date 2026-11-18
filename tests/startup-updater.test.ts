import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StartupUpdater } from '../electron/startup-updater';

test('startup checks once, waits for consent and retries a failed handoff without another download', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ducky-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = Buffer.from('MZ test release');
  const name = 'DuckyMovie-Setup-1.0.0-Windows-x64.exe';
  const url = 'https://github.com/AndreAlpha/ducky-movie/releases/download/v1.0.0/' + name;
  const requests: string[] = [];
  const fetcher: typeof fetch = async input => {
    requests.push(String(input));
    if (input === url) return new Response(data);
    return Response.json({ tag_name: 'v1.0.0', prerelease: false, draft: false, assets: [{
      name, state: 'uploaded', size: data.length, browser_download_url: url,
      digest: 'sha256:' + createHash('sha256').update(data).digest('hex'),
    }] });
  };
  const launches: string[] = [];
  const updater = new StartupUpdater('0.6.3', directory, { fetcher, launch: async file => {
    launches.push(file);
    if (launches.length === 1) throw new Error('Installer occupato');
    assert.deepEqual(await readFile(file), data);
  } });
  const [first, duplicate] = await Promise.all([updater.check(), updater.check()]);
  assert.equal(first?.version, '1.0.0');
  assert.equal(first, duplicate);
  assert.equal(requests.length, 1);
  await assert.rejects(updater.install(), /completamento del download/);
  assert.equal(launches.length, 0);
  await updater.download(() => {});
  await assert.rejects(updater.install(), /occupato/);
  await updater.install();
  await assert.rejects(updater.install(), /già in corso/);
  assert.equal(launches.length, 2);
  assert.equal(launches[0], launches[1]);
  assert.equal(requests.length, 2);
});
