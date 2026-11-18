import { spawn } from 'node:child_process';
import path from 'node:path';
import { checkForUpdate, type AvailableUpdate } from './update-feed';
import { downloadUpdate } from './update-download';

/** These flags tell the existing Windows installer to upgrade its registered
 * installation and reopen DuckyMovie when all files have been replaced. */
export function launchInstaller(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, ['/S', '--updated', '--force-run'], {
      cwd: path.dirname(file), stdio: 'ignore', detached: true, windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export class StartupUpdater {
  private lookup?: Promise<AvailableUpdate | null>;
  private token?: string;
  private abort?: AbortController;
  private transfer?: Promise<void>;
  private installer?: string;
  private launching = false;

  constructor(private readonly version: string, private readonly directory: string, private readonly options: {
    readToken?: () => Promise<string | undefined>; fetcher?: typeof fetch; launch?: typeof launchInstaller;
  } = {}) {}

  check() {
    // React can mount twice at startup. Only request release metadata once per launch.
    return this.lookup ??= (async () => {
      this.token = await this.options.readToken?.();
      return checkForUpdate(this.version, { fetcher: this.options.fetcher, token: this.token });
    })().catch(() => null);
  }

  async download(progress: (fraction: number) => void) {
    const release = await this.lookup;
    if (!release) throw new Error('Nessun aggiornamento disponibile.');
    if (this.installer) { progress(1); return; }
    if (this.abort) throw new Error('Download già in corso.');
    const controller = new AbortController();
    this.abort = controller;
    try {
      this.transfer = downloadUpdate(release, this.directory, {
        signal: controller.signal, fetcher: this.options.fetcher, token: this.token,
        onProgress: (received, total) => progress(received / total),
      }).then(file => { this.installer = file; });
      await this.transfer;
    } finally {
      this.abort = undefined;
      this.transfer = undefined;
    }
  }

  async cancel() {
    this.abort?.abort();
    await this.transfer?.catch(() => undefined);
  }

  async install() {
    if (!this.installer) throw new Error('Attendi il completamento del download.');
    if (this.launching) throw new Error('Aggiornamento già in corso.');
    this.launching = true;
    try {
      await (this.options.launch ?? launchInstaller)(this.installer);
    } catch (error) {
      this.launching = false;
      throw error;
    }
  }
}
