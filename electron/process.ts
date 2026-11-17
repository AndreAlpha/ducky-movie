import { spawn } from 'node:child_process';

export function runProcess(
  binary: string,
  args: string[],
  maxOutput = 8 * 1024 * 1024,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, shell: false });
    const chunks: Buffer[] = [];
    let size = 0;
    let errors = '';
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutput) {
        child.kill();
        reject(
          new Error('Il file contiene troppi dati per questa operazione.'),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errors = (errors + chunk.toString()).slice(-12000);
    });
    child.on('error', (error) =>
      reject(
        new Error(
          `Impossibile avviare il motore multimediale. ${error.message}`,
        ),
      ),
    );
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else
        reject(
          new Error(
            errors.trim().split('\n').slice(-5).join('\n') ||
              `Il motore multimediale si è fermato (${code}).`,
          ),
        );
    });
  });
}
