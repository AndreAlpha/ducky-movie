import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJSON } from './store';
import { verifyUpdateAccess } from './update-feed';

const accessFile = () => path.join(app.getPath('userData'), 'update-access.json');

export async function hasUpdateAccess() {
  try { return (await fs.stat(accessFile())).isFile(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function readUpdateAccess(): Promise<string | undefined> {
  if (!await hasUpdateAccess()) return undefined;
  const encrypted: unknown = JSON.parse(await fs.readFile(accessFile(), 'utf8'));
  if (typeof encrypted !== 'string' || encrypted.length > 16_384) throw new Error('Accesso GitHub non leggibile.');
  return (await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'))).result;
}

export async function setUpdateAccess(input: unknown) {
  if (input === '') { await fs.rm(accessFile(), { force: true }); return; }
  if (typeof input !== 'string' || !/^[\w-]{1,512}$/.test(input.trim())) throw new Error('Inserisci un token GitHub valido.');
  const token = input.trim();
  if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Windows non può proteggere il token su questo PC.');
  await verifyUpdateAccess(token);
  const encrypted = await safeStorage.encryptStringAsync(token);
  await atomicJSON(accessFile(), encrypted.toString('base64'));
}
