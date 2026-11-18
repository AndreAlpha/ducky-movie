import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { cleanupStagedUpdates, downloadUpdate } from '../electron/update-download';
import { MAX_INSTALLER_BYTES, type AvailableUpdate } from '../electron/update-feed';

const bytes = Buffer.from('MZ-ducky-installer');
const assetApiUrl = 'https://api.github.com/repos/AndreAlpha/ducky-movie/releases/assets/1234567';
const offer: AvailableUpdate = {
  version: '1.10.0',
  url: 'https://github.com/AndreAlpha/ducky-movie/releases/download/v1.10.0/DuckyMovie-Setup-1.10.0-Windows-x64.exe',
  size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
};

async function workspace(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ducky-update-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function chunks(payload: Buffer) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(payload.subarray(0, 1));
      controller.enqueue(payload.subarray(1));
      controller.close();
    },
  }));
}

test('verified installer follows a trusted release redirect, streams in chunks and has a fresh path per run', async t => {
  const directory = await workspace(t);
  const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/ducky?signature=temporary';
  const fetcher: typeof fetch = async (url, request) => {
    assert.equal(request?.redirect, 'manual');
    if (url === offer.url) return Response.redirect(cdn, 302);
    assert.equal(url, cdn);
    return chunks(bytes);
  };
  const progress: number[] = [];
  const [first, second] = await Promise.all([
    downloadUpdate(offer, directory, { fetcher, onProgress: (count, size) => { assert.equal(size, bytes.length); progress.push(count); } }),
    downloadUpdate(offer, directory, { fetcher }),
  ]);
  assert.deepEqual(await readFile(first), bytes);
  assert.deepEqual(await readFile(second), bytes);
  assert.notEqual(path.dirname(first), path.dirname(second));
  assert.deepEqual(await readdir(path.dirname(first)), [path.basename(first)]);
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), bytes.length);
});

test('invalid metadata is rejected before making a request or staging an installer', async t => {
  const directory = await workspace(t);
  let requests = 0;
  const fetcher = async () => { requests++; return chunks(bytes); };
  for (const patch of [{ size: MAX_INSTALLER_BYTES + 1 }, { sha256: 'wrong' }, { sha256: '' },
    { version: '../foo' }, { url: offer.url.replace('AndreAlpha', 'another-user') }]) {
    await assert.rejects(downloadUpdate({ ...offer, ...patch }, directory, { fetcher }), /dati dell’installer/);
  }
  assert.equal(requests, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('private release accepts the direct binary API response with bearer authentication', async t => {
  const directory = await workspace(t);
  const file = await downloadUpdate({ ...offer, assetApiUrl }, directory, {
    token: 'fixture', fetcher: async (url, request) => {
      assert.equal(url, assetApiUrl);
      const headers = new Headers(request?.headers);
      assert.equal(headers.get('accept'), 'application/octet-stream');
      assert.equal(headers.get('authorization'), 'Bearer fixture');
      assert.equal(request?.redirect, 'manual');
      return chunks(bytes);
    },
  });
  assert.deepEqual(await readFile(file), bytes);
});

test('authentication is limited to the asset API and removed across every redirect', async t => {
  const directory = await workspace(t);
  const cdn = 'https://release-assets.githubusercontent.com/asset?signature=example';
  const hops: string[] = [];
  const options = { token: 'fixture', fetcher: async (url: URL | string | Request, request?: RequestInit) => {
    const headers = new Headers(request?.headers);
    const target = String(url);
    hops.push(target);
    assert.equal(headers.get('authorization'), target === assetApiUrl ? 'Bearer fixture' : null);
    if (target === assetApiUrl) return Response.redirect(offer.url, 302);
    if (target === offer.url) return Response.redirect(cdn, 302);
    assert.equal(target, cdn);
    return chunks(bytes);
  } };
  await downloadUpdate({ ...offer, assetApiUrl }, directory, options);
  assert.deepEqual(hops, [assetApiUrl, offer.url, cdn]);
  hops.length = 0;
  await downloadUpdate(offer, directory, options);
  assert.deepEqual(hops, [offer.url, cdn]);
});

test('refuses untrusted API URLs and malformed asset IDs before sending any credentials', async t => {
  const directory = await workspace(t);
  let requests = 0;
  const options = { token: 'fixture', fetcher: async () => { requests++; return chunks(bytes); } };
  for (const invalid of [assetApiUrl.replace('/1234567', '/0'), assetApiUrl.replace('1234567', 'abc'),
    assetApiUrl.replace('AndreAlpha', 'Elsewhere'), assetApiUrl.replace('api.github.com', 'other.test'),
    assetApiUrl + '?uri=example', assetApiUrl.replace('https:', 'http:')]) {
    await assert.rejects(downloadUpdate({ ...offer, assetApiUrl: invalid }, directory, options), /dati dell’installer/);
  }
  await assert.rejects(downloadUpdate({ ...offer, assetApiUrl }, directory, { ...options, token: 'bad\r\nheader' }), /credenziale/);
  assert.equal(requests, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('untrusted redirect targets and redirect loops are rejected and clean up the staged directory', async t => {
  const directory = await workspace(t);
  for (const url of ['http://release-assets.githubusercontent.com/download', 'https://github.com/other/r/file',
    'https://release-assets.githubusercontent.com.evil.test/file', 'https://name@objects.githubusercontent.com/file']) {
    let requests = 0;
    await assert.rejects(downloadUpdate(offer, directory, { fetcher: async () => { requests++; return Response.redirect(url); } }), /ufficiale/);
    assert.equal(requests, 1);
  }
  await assert.rejects(downloadUpdate(offer, directory, { fetcher: async () => Response.redirect(offer.url) }), /troppi/);
  assert.deepEqual(await readdir(directory), []);
});

test('failed, partial, oversized, corrupted and non-executable transfers never leave a runnable file', async t => {
  const directory = await workspace(t);
  const cases: [() => Response, RegExp][] = [
    [() => new Response('retry', { status: 503 }), /503/],
    [() => new Response(bytes, { headers: { 'content-length': '100' } }), /dimensione/],
    [() => chunks(bytes.subarray(0, 3)), /incompleto/],
    [() => chunks(Buffer.concat([bytes, bytes])), /supera/],
    [() => chunks(Buffer.from('NZ' + bytes.toString().slice(2))), /eseguibile Windows/],
    [() => chunks(Buffer.from('MZ' + 'x'.repeat(bytes.length - 2))), /SHA-256/],
  ];
  for (const [response, error] of cases) {
    await assert.rejects(downloadUpdate(offer, directory, { fetcher: async () => response() }), error);
    assert.deepEqual(await readdir(directory), []);
  }
});

test('cancelling during download discards the staged file and directory', async t => {
  const directory = await workspace(t);
  const abort = new AbortController();
  await assert.rejects(downloadUpdate(offer, directory, {
    fetcher: async () => chunks(bytes), signal: abort.signal, onProgress: () => abort.abort(),
  }), { name: 'AbortError' });
  assert.deepEqual(await readdir(directory), []);
});

test('stale cleanup removes only old installers and partial downloads, preserving recent and unrelated files', async t => {
  const directory = await workspace(t);
  await cleanupStagedUpdates(path.join(directory, 'not-created'));
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  const setup = 'DuckyMovie-Setup-1.10.0-Windows-x64.exe';
  const cases: [string, string, boolean][] = [
    ['download-ABC001', setup, true], ['download-ABC002', 'installer.part', true],
    ['download-ABC003', setup, false], ['download-ABC004', 'keep.txt', true], ['other', 'installer.part', true],
  ];
  for (const [name, file, stale] of cases) {
    const dir = path.join(directory, name);
    await mkdir(dir);
    await writeFile(path.join(dir, file), 'fixture');
    if (stale) await utimes(path.join(dir, file), old, old);
    await utimes(dir, old, old);
  }
  await cleanupStagedUpdates(directory);
  assert.deepEqual((await readdir(directory)).sort(), ['download-ABC003', 'download-ABC004', 'other']);
});
