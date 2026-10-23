import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicJson, safePath } from '../resource-store/files.js';
import type { ArchivedLogFile } from './archive.js';

// Marked evidence is never evicted by ordinary log traffic or by a later mark.
export const INCIDENT_LIMITS = {
  files: 8,
  fileBytes: 8 * 1024 * 1024,
  diskBytes: 64 * 1024 * 1024,
};
const pattern = /^[a-f0-9-]{36}\.json$/;
export interface IncidentSnapshot {
  schema: 'mizar-incident/1';
  capturedAt: string;
  report: { category: string; observedAt: string; sequence: number };
  files: ArchivedLogFile[];
}

export class IncidentStore {
  private readonly directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(logDirectory: string) {
    this.directory = join(logDirectory, 'marked-incidents');
  }
  async names() {
    try {
      await safePath(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const names = (await readdir(this.directory)).filter((name) => pattern.test(name)).sort();
    if (names.length > INCIDENT_LIMITS.files) throw new Error('incident_count_budget');
    return names;
  }
  async read(name: string): Promise<IncidentSnapshot> {
    if (!pattern.test(name)) throw new Error('incident_name_invalid');
    const path = await safePath(this.directory, name);
    const before = await lstat(path);
    if (!before.isFile() || before.nlink !== 1 || before.size > INCIDENT_LIMITS.fileBytes)
      throw new Error('incident_file_unsafe');
    const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const actual = await fd.stat();
      if (
        actual.ino !== before.ino ||
        actual.dev !== before.dev ||
        actual.size !== before.size ||
        actual.nlink !== 1
      )
        throw new Error('incident_file_changed');
      const bytes = Buffer.alloc(actual.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await fd.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) throw new Error('incident_incomplete_read');
        offset += read.bytesRead;
      }
      const after = await fd.stat();
      if (after.size !== actual.size || after.mtimeMs !== actual.mtimeMs)
        throw new Error('incident_file_changed');
      const value = JSON.parse(bytes.toString('utf8')) as IncidentSnapshot;
      if (
        value.schema !== 'mizar-incident/1' ||
        !Array.isArray(value.files) ||
        value.files.length > 64
      )
        throw new Error('incident_format_invalid');
      return value;
    } finally {
      await fd.close();
    }
  }
  capture(create: () => Promise<IncidentSnapshot>): Promise<string> {
    const result = this.queue.then(async () => {
      await safePath(dirname(this.directory));
      await mkdir(this.directory, { recursive: true });
      await safePath(this.directory);
      const names = await this.names();
      if (names.length >= INCIDENT_LIMITS.files) throw new Error('incident_count_budget');
      let used = 0;
      for (const name of names) {
        const file = await lstat(await safePath(this.directory, name));
        if (!file.isFile() || file.nlink !== 1) throw new Error('incident_file_unsafe');
        used += file.size;
      }
      const snapshot = await create();
      if (snapshot.files.length > 64) throw new Error('incident_source_count_budget');
      const bytes = Buffer.byteLength(JSON.stringify(snapshot));
      if (bytes > INCIDENT_LIMITS.fileBytes || used + bytes > INCIDENT_LIMITS.diskBytes)
        throw new Error('incident_disk_budget');
      const name = `${randomUUID()}.json`;
      await atomicJson(join(this.directory, name), snapshot);
      return name;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}
