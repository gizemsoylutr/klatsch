import { randomBytes } from 'node:crypto';
import { closeSync, constants, openSync, renameSync, rmSync, writeSync } from 'node:fs';

/**
 * Writes a whole file or nothing: a new temp file next to it (created exclusively, never through a
 * symlink, with `mode` from the start), then a rename over the target. A reader never sees half a file,
 * and a link planted at the temp name cannot redirect the write.
 */
export function writeFileAtomic(path: string, data: string, mode: number): void {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
