const repository = 'AndreAlpha/ducky-movie';
const releasesApi = `https://api.github.com/repos/${repository}/releases`;
const latestRelease = `${releasesApi}/latest`;
const assetsApi = `${releasesApi}/assets/`;
export const MAX_INSTALLER_BYTES = 2 ** 31;

export interface AvailableUpdate {
  version: string;
  url: string;
  assetApiUrl?: string;
  size: number;
  sha256: string;
}

/** Authenticated installer requests use only this repository's canonical asset endpoint. */
export function isReleaseAssetApiUrl(value: string): boolean {
  if (!value.startsWith(assetsApi)) return false;
  const id = value.slice(assetsApi.length);
  const parsed = Number(id);
  return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === id;
}

// Release tags may prefix a SemVer version with "v". Build metadata does
// not change precedence. The feed only offers stable versions, including
// the stable counterpart of an installed prerelease.
function parseVersion(value: string) {
  const match = /^v?((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.exec(value);
  if (!match || match[0] !== value || match[5]?.split('.').some(part => /^0\d+$/.test(part))) return null;
  return { version: match[1], core: [BigInt(match[2]), BigInt(match[3]), BigInt(match[4])], prerelease: !!match[5] };
}

type Version = NonNullable<ReturnType<typeof parseVersion>>;

function isNewerStable(candidate: Version, installed: Version) {
  if (candidate.prerelease) return false;
  for (let index = 0; index < candidate.core.length; index++) {
    if (candidate.core[index] !== installed.core[index]) return candidate.core[index] > installed.core[index];
  }
  return installed.prerelease;
}

function installerName(version: string) {
  return `DuckyMovie-Setup-${version}-Windows-x64.exe`;
}

/** Only the installer belonging to this repository and this release is eligible. */
export function isInstallerUrl(value: string, version: string, releaseTag?: string) {
  const parsed = parseVersion(version);
  if (!parsed || parsed.prerelease || parsed.version !== version) return false;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash) return false;
    const parts = url.pathname.slice(1).split('/').map(decodeURIComponent);
    return parts.length === 6 && `${parts[0]}/${parts[1]}`.toLowerCase() === repository.toLowerCase()
      && parts[2] === 'releases' && parts[3] === 'download'
      && (parts[4] === version || parts[4] === 'v' + version) && (!releaseTag || parts[4] === releaseTag)
      && parts[5] === installerName(version);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function releaseHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'DuckyMovie-Updater' };
  if (token) {
    // An invalid header can cause the HTTP client to echo its value in an error.
    if (/[^\x21-\x7e]/.test(token)) throw new Error('La credenziale GitHub non è valida.');
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/** This endpoint returns 200 even when the repository has no published releases. */
export async function verifyUpdateAccess(token: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (!token) throw new Error('Inserisci un token GitHub.');
  const headers = releaseHeaders(token);
  let response: Response;
  try {
    response = await fetcher(`${releasesApi}?per_page=1`, { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error('Impossibile contattare GitHub. Controlla la connessione e riprova.');
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 200) return;
  if (response.status === 401) throw new Error('GitHub ha rifiutato il token. Controlla che sia corretto e ancora valido.');
  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
    throw new Error('GitHub ha raggiunto il limite di richieste. Riprova più tardi.');
  if (response.status === 403 || response.status === 404)
    throw new Error('Verifica che il token abbia accesso in lettura ai contenuti del repository di DuckyMovie.');
  throw new Error(`Verifica dell’accesso a GitHub non riuscita (HTTP ${response.status}). Riprova più tardi.`);
}

export async function checkForUpdate(currentVersion: string, options: {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  token?: string;
} = {}): Promise<AvailableUpdate | null> {
  const installed = parseVersion(currentVersion);
  if (!installed) return null;
  const timeout = AbortSignal.timeout(10_000);
  const response = await (options.fetcher ?? fetch)(latestRelease, {
    headers: releaseHeaders(options.token),
    redirect: 'error',
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Controllo degli aggiornamenti non disponibile (HTTP ${response.status}).`);
  const release: unknown = await response.json();
  if (!isRecord(release) || release.draft !== false || release.prerelease !== false
    || typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) return null;
  const candidate = parseVersion(release.tag_name);
  if (!candidate || !isNewerStable(candidate, installed)) return null;

  const { version } = candidate;
  const asset: unknown = release.assets.find(entry => isRecord(entry) && entry.name === installerName(version));
  if (!isRecord(asset) || asset.state !== 'uploaded'
    || typeof asset.browser_download_url !== 'string' || !isInstallerUrl(asset.browser_download_url, version, release.tag_name)
    || typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_INSTALLER_BYTES) return null;
  if (typeof asset.digest !== 'string' || !/^sha256:[a-f\d]{64}$/i.test(asset.digest) || asset.digest.length !== 71) return null;
  const sha256 = asset.digest.slice(7).toLowerCase();
  const update: AvailableUpdate = { version, url: asset.browser_download_url, size: asset.size, sha256 };
  if (options.token) {
    if (typeof asset.id !== 'number' || !Number.isSafeInteger(asset.id) || asset.id <= 0) return null;
    update.assetApiUrl = assetsApi + asset.id;
  }
  return update;
}
