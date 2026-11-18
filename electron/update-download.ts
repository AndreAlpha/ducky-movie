import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { isInstallerUrl, isReleaseAssetApiUrl, MAX_INSTALLER_BYTES, type AvailableUpdate } from './update-feed';

interface DownloadOptions {
  signal?: AbortSignal;
  token?: string;
  onProgress?: (received: number, total: number) => void;
  fetcher?: typeof fetch;
}

const releaseAssetHosts = new Set([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

async function openInstaller(update: AvailableUpdate, options: DownloadOptions, signal: AbortSignal): Promise<Response> {
  const authenticatedUrl = options.token ? update.assetApiUrl : undefined;
  let url = new URL(authenticatedUrl ?? update.url);
  const fetcher = options.fetcher ?? fetch;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const headers = new Headers({ 'User-Agent': 'DuckyMovie', Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' });
    if (redirects === 0 && authenticatedUrl) headers.set('Authorization', 'Bearer ' + options.token);
    const response = await fetcher(url.href, {
      redirect: 'manual', signal, headers,
    });
    if (response.status === 200 && response.body) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(response.status) || !location)
      throw new Error(`Il download dell’aggiornamento non è disponibile (HTTP ${response.status}).`);
    url = new URL(location, url);
    const trustedAsset = url.protocol === 'https:' && !url.username && !url.password && !url.port
      && releaseAssetHosts.has(url.hostname);
    if (!trustedAsset && !isInstallerUrl(url.href, update.version))
      throw new Error('Il collegamento di download non appartiene alla release ufficiale.');
  }
  throw new Error('Il download dell’aggiornamento contiene troppi reindirizzamenti.');
}

/** Returns a fresh installer only after the full release asset has been verified. */
export async function downloadUpdate(update: AvailableUpdate, directory: string, options: DownloadOptions = {}): Promise<string> {
  if (!isInstallerUrl(update.url, update.version)
      || (update.assetApiUrl !== undefined && !isReleaseAssetApiUrl(update.assetApiUrl))
      || !Number.isSafeInteger(update.size) || update.size < 2 || update.size > MAX_INSTALLER_BYTES
      || !update.sha256 || update.sha256.length !== 64 || !/^[a-f0-9]{64}$/i.test(update.sha256))
    throw new Error('I dati dell’installer della release non sono validi.');
  if (options.token && /[^\x21-\x7e]/.test(options.token))
    throw new Error('La credenziale per il download non è valida.');
  options.signal?.throwIfAborted();
  const base = path.resolve(directory);
  await mkdir(base, { recursive: true });
  const staging = await mkdtemp(path.join(base, 'download-'));
  const partial = path.join(staging, 'installer.part');
  const installer = path.join(staging, `DuckyMovie-Setup-${update.version}-Windows-x64.exe`);
  const timeout = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  // Allow slow connections to finish, but stop a connection that has stopped sending data.
  const timer = setTimeout(() => timeout.abort(new Error('Il download si è interrotto per inattività.')), 60_000);
  timer.unref();
  try {
    const response = await openInstaller(update, options, signal);
    const reader = response.body!.getReader();
    try {
      const contentLength = response.headers.get('content-length');
      if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== update.size))
        throw new Error('La dimensione dell’installer differisce da quella indicata nella release.');
      const file = await open(partial, 'wx', 0o600);
      try {
        const hash = createHash('sha256');
        const signature = Buffer.alloc(2);
        let received = 0;
        let lastProgress = Date.now();
        options.onProgress?.(0, update.size);
        while (true) {
          signal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          if (!value.byteLength) continue;
          timer.refresh();
          if (received + value.byteLength > update.size)
            throw new Error('Il download supera la dimensione prevista per l’installer.');
          if (received < signature.length)
            signature.set(value.subarray(0, signature.length - received), received);
          hash.update(value);
          await file.writeFile(value);
          received += value.byteLength;
          const now = Date.now();
          if (received < update.size && now - lastProgress >= 150) {
            options.onProgress?.(received, update.size);
            lastProgress = now;
          }
        }
        signal.throwIfAborted();
        if (received !== update.size) throw new Error('Il download dell’installer è incompleto.');
        if (signature[0] !== 0x4d || signature[1] !== 0x5a)
          throw new Error('Il file scaricato non è un eseguibile Windows.');
        if (hash.digest('hex') !== update.sha256.toLowerCase())
          throw new Error('La verifica SHA-256 dell’installer non è riuscita.');
      } finally {
        await file.close();
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    signal.throwIfAborted();
    await rename(partial, installer);
    signal.throwIfAborted();
    options.onProgress?.(update.size, update.size);
    return installer;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw signal.aborted ? signal.reason : error;
  } finally {
    clearTimeout(timer);
  }
}

/** The installer may still be running when the updated application first opens. */
export async function cleanupStagedUpdates(directory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^download-[a-z0-9]{6}$/i.test(entry.name)) continue;
    const staging = path.join(directory, entry.name);
    try {
      if ((await lstat(staging)).mtimeMs >= cutoff) continue;
      const files = await readdir(staging, { withFileTypes: true });
      if (files.length > 1) continue;
      const file = files[0];
      if (file) {
        const knownFile = file.name === 'installer.part' || /^DuckyMovie-Setup-[0-9A-Za-z.+-]+-Windows-x64\.exe$/.test(file.name);
        if (!file.isFile() || !knownFile) continue;
        const filePath = path.join(staging, file.name);
        if ((await lstat(filePath)).mtimeMs >= cutoff) continue;
        await rm(filePath);
      }
      await rmdir(staging);
    } catch {
      // A concurrent launch or installer may still hold the file on Windows.
    }
  }
}
