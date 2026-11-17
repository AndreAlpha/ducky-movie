import fs from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve('engine-dist/DuckyMovieEngine');
try {
  await fs.access(path.join(directory, 'DuckyMovieEngine.exe'));
  const files = await fs.readdir(path.join(directory, '_internal'));
  if (!files.some(file => /^python3\d+\.dll$/i.test(file))) throw new Error('Runtime Python mancante.');
} catch {
  throw new Error('Il motore autonomo è assente o incompleto. Esegui npm run build:engine dopo aver preparato engine/.venv come descritto in engine/README.md.');
}
