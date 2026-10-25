import { writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Temp-file + rename write. Sync clients (OneDrive, antivirus) may hold the target for a moment, so the rename is
 *  retried briefly; as a last resort the data is written in place rather than lost. */
export function writeFileAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, data, 'utf8');
  for (let attempt = 0; attempt < 6; attempt++) {
    try { renameSync(temp, path); return; } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      pause(40 * (attempt + 1));
    }
  }
  writeFileSync(path, data, 'utf8');
  try { unlinkSync(temp); } catch { /* the temp file is harmless if it remains */ }
}
