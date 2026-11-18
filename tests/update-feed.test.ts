import test from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate, isInstallerUrl, isReleaseAssetApiUrl, MAX_INSTALLER_BYTES, verifyUpdateAccess } from '../electron/update-feed';

function feed(tag = 'v1.10.0') {
  const name = `DuckyMovie-Setup-${tag.replace(/^v/, '')}-Windows-x64.exe`;
  const url = `https://github.com/AndreAlpha/ducky-movie/releases/download/${tag}/${name}`;
  return {
    tag_name: tag, draft: false, prerelease: false,
    assets: [{ name, state: 'uploaded', browser_download_url: url, size: 250000, digest: 'sha256:' + 'AB'.repeat(32) }],
  };
}

async function check(current: string, release: unknown) {
  return checkForUpdate(current, { fetcher: async () => Response.json(release) });
}

test('the public latest release check uses the uploaded Windows installer and its digest', async () => {
  const release = feed();
  const asset = release.assets[0];
  release.assets.unshift({ ...asset, name: 'source.zip' }, { ...asset, name: asset.name + '.blockmap' });
  const update = await checkForUpdate('1.9.7', { fetcher: async (url, request) => {
    assert.equal(url, 'https://api.github.com/repos/AndreAlpha/ducky-movie/releases/latest');
    assert.equal(request?.redirect, 'error');
    assert.equal(new Headers(request?.headers).has('Authorization'), false);
    assert.ok(request?.signal);
    return Response.json(release);
  } });
  assert.deepEqual(update, { version: '1.10.0', url: asset.browser_download_url, size: asset.size, sha256: 'ab'.repeat(32) });
  assert.equal(await check('1.9.0', { ...release, assets: [{ ...asset, digest: null }] }), null);
});

test('an opt-in private feed authorizes only the fixed API and derives the download endpoint from the asset ID', async () => {
  const release = feed();
  const asset = { ...release.assets[0], id: 4192, url: 'https://unrelated.example/file' };
  const token = 'fixture-value';
  let requests = 0;
  const update = await checkForUpdate('1.0.0', { token, fetcher: async (url, request) => {
    requests++;
    assert.equal(url, 'https://api.github.com/repos/AndreAlpha/ducky-movie/releases/latest');
    assert.equal(request?.redirect, 'error');
    assert.equal(new Headers(request?.headers).get('Authorization'), 'Bearer ' + token);
    return Response.json({ ...release, assets: [asset] });
  } });
  assert.equal(requests, 1);
  assert.equal(update?.assetApiUrl, 'https://api.github.com/repos/AndreAlpha/ducky-movie/releases/assets/4192');
  assert.ok(!JSON.stringify(update).includes(token));
  assert.equal((await check('1.0.0', { ...release, assets: [asset] }))?.assetApiUrl, undefined);
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined, '4192']) {
    assert.equal(await checkForUpdate('1.0.0', { token, fetcher: async () =>
      Response.json({ ...release, assets: [{ ...asset, id }] }) }), null);
  }
  await assert.rejects(checkForUpdate('1.0.0', { token: token + '\n', fetcher: async () => {
    throw new Error('Unexpected network request');
  } }), error => error instanceof Error && error.message.includes('credenziale') && !error.message.includes(token));
});

test('credentials can only be sent to the canonical HTTPS endpoint for a numeric release asset', () => {
  const url = 'https://api.github.com/repos/AndreAlpha/ducky-movie/releases/assets/1234';
  assert.equal(isReleaseAssetApiUrl(url), true);
  for (const value of [url + '?x=y', url + '#id', url + '/', url + '\n', url + 'x',
    url.replace('api.github.com', 'api.github.com.example.org'), url.replace('https:', 'http:'),
    url.replace('AndreAlpha', 'other'), url.replace('assets/1234', 'assets/../assets/1234'),
    url.replace('1234', '0'), url.replace('1234', '01'), url.replace('1234', '%31'),
    url.replace('1234', '9007199254740992')]) assert.equal(isReleaseAssetApiUrl(value), false);
});

test('validating private access permits empty release lists, releases the body and sanitizes failures', async () => {
  const token = 'fixture-credential';
  let cancelled = false;
  await verifyUpdateAccess(token, async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/AndreAlpha/ducky-movie/releases?per_page=1');
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal);
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer ' + token);
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  });
  assert.equal(cancelled, true);
  for (const [status, message] of [[401, /rifiutato/], [403, /lettura/], [404, /lettura/], [503, /503/]] as const)
    await assert.rejects(verifyUpdateAccess(token, async () => new Response(token, { status })), error =>
      error instanceof Error && message.test(error.message) && !error.message.includes(token));
  await assert.rejects(verifyUpdateAccess(token, async () => { throw new Error(token); }), /connessione/);
});

test('stable release precedence handles numeric components, prereleases and build metadata', async () => {
  for (const [installed, tag, expected] of [
    ['1.9.99', '1.10.0', true], ['1.11.0', 'v1.10.99', false],
    ['2.0.0-beta.1', 'v2.0.0', true], ['2.0.1-beta', 'v2.0.0', false],
    ['1.2.3+a', 'v1.2.3+b', false], ['1.2.2', 'v1.2.3+build.47', true],
    ['1.2.2', 'v1.2.3-beta', false], ['0.6.2', 'v0.6.2', false],
    ['unknown', 'v1.2.0', false], ['1.0.0', 'v1.02.0', false],
    ['1.2.3-01', 'v1.2.3', false],
  ] as const) {
    assert.equal(Boolean(await check(installed, feed(tag))), expected, `${installed} -> ${tag}`);
  }
});

test('incomplete releases and mismatched installer metadata do not produce a prompt', async () => {
  const release = feed();
  const asset = release.assets[0];
  for (const patch of [{ draft: true }, { prerelease: true }, { tag_name: 'v2.0.0' }, { assets: [] }]) {
    assert.equal(await check('1.0.0', { ...release, ...patch }), null);
  }
  for (const patch of [
    { size: 0 }, { size: 2.5 }, { size: MAX_INSTALLER_BYTES + 1 },
    { digest: 'sha256:incomplete' }, { digest: '' }, { digest: undefined }, { state: 'starter' },
    { browser_download_url: asset.browser_download_url.replace('/v1.10.0/', '/1.10.0/') },
    { name: asset.name.replace('x64', 'arm64') },
  ]) {
    assert.equal(await check('1.0.0', { ...release, assets: [{ ...asset, ...patch }] }), null);
  }
});

test('the installer link must belong to the expected repository, tag and asset', () => {
  const url = feed().assets[0].browser_download_url;
  for (const invalid of [
    url.replace('https:', 'http:'), url.replace('github.com', 'github.com.example.org'),
    url.replace('github.com', 'user@github.com'), url.replace('AndreAlpha', 'someone'),
    url.replace('ducky-movie', 'other'), url.replace('/v1.10.0/', '/v0.9.0/'),
    url.replace('x64.exe', 'arm64.exe'), url + '?redirect=1', url + '#path', 'invalid',
  ]) assert.equal(isInstallerUrl(invalid, '1.10.0'), false, invalid);
  assert.equal(isInstallerUrl(url.replace('AndreAlpha', 'andrealpha'), '1.10.0'), true);
});

test('an unpublished feed is quiet and rate limits or loss of connection propagate', async () => {
  assert.equal(await checkForUpdate('1.0.0', { fetcher: async () => new Response(null, { status: 404 }) }), null);
  await assert.rejects(checkForUpdate('1.0.0', { fetcher: async () => new Response(null, { status: 403 }) }), /403/);
  const abort = AbortSignal.abort(new Error('cancelled'));
  await assert.rejects(checkForUpdate('1.0.0', { signal: abort, fetcher: async (_url, options) => {
    options?.signal?.throwIfAborted();
    return Response.json(feed());
  } }), /cancelled/);
});
