import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export async function renameObsJournal(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        attempt >= 4 ||
        !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
      )
        throw error;
      await delay(25 * (attempt + 1));
    }
  }
}
