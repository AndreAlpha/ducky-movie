import path from 'node:path';
import fs from 'node:fs/promises';

export async function canonicalPath(file: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await fs.realpath(file);
  } catch {
    resolved = path.join(
      await fs.realpath(path.dirname(file)),
      path.basename(file),
    );
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function protectSourceFiles(
  output: string,
  sources: string[],
): Promise<void> {
  const target = await canonicalPath(output);
  for (const source of sources) {
    let original: string;
    try {
      original = await canonicalPath(source);
    } catch {
      continue;
    }
    if (target === original)
      throw new Error(
        'Scegli un nome diverso da quello dei file originali e del progetto.',
      );
  }
}
