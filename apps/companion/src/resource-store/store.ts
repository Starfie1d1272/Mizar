import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  ResourceStoreError,
  type PreparePack,
  type ResourceStatus,
  type ResourceInstallOptions,
  type StoreOptions,
  type TrustedPack,
  type ActivePackVerification,
} from './contract.js';
import {
  atomicJson,
  checkDescriptor,
  checkTree,
  contentType,
  ensureDirectory,
  readJson,
  syncDirectory,
  verifiedRead,
} from './files.js';

interface CachedPack {
  id: string;
  descriptor: TrustedPack;
}
interface Entry {
  status: ResourceStatus;
  active: CachedPack | null;
  prepared: CachedPack | null;
  previous: CachedPack | null;
  optional: boolean;
}
interface Pointer {
  active: string | null;
  prepared: string | null;
  previous: string | null;
}
const versionId = /^[a-f0-9-]{36}$/;
const idleSignal = () => new AbortController().signal;

export function defaultResourceRoot(): string {
  if (process.platform === 'win32') {
    if (!process.env.LOCALAPPDATA) throw new ResourceStoreError('resource_root_unavailable');
    return join(process.env.LOCALAPPDATA, 'Mizar', 'assets');
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'Mizar', 'assets');
}

export class ResourceStore {
  private readonly entries = new Map<string, Entry>();
  private readonly root: string;
  private readonly controllers = new Map<string, AbortController>();
  private busy = false;
  private operation: Promise<void> | undefined;
  private closed = false;
  private closing = false;
  private lease: string | null = null;
  private readingBytes = 0;
  private readers = 0;

  private constructor(private readonly options: StoreOptions) {
    this.root = resolve(options.root);
    for (const pack of options.packs ?? [{ packId: 'official:epl-default' }]) {
      if (!/^[a-z0-9]+:[a-z0-9-]+$/.test(pack.packId) || this.entries.has(pack.packId))
        throw new ResourceStoreError('resource_pack_invalid');
      this.entries.set(pack.packId, {
        active: null,
        prepared: null,
        previous: null,
        optional: pack.optional === true,
        status: {
          packId: pack.packId,
          phase: 'missing',
          downloadedBytes: 0,
          activeVersion: null,
          preparedVersion: null,
          rollbackVersion: null,
          failure: null,
        },
      });
    }
  }

  static async open(options: StoreOptions): Promise<ResourceStore> {
    const store = new ResourceStore(options);
    try {
      await ensureDirectory(store.root);
      await store.acquireLease();
      for (const packId of store.entries.keys()) await store.restore(packId);
      return store;
    } catch (error) {
      await store.releaseLease();
      throw error;
    }
  }

  private async acquireLease(): Promise<void> {
    const directory = join(this.root, 'writers');
    await ensureDirectory(directory);
    const own = `${process.pid}-${randomUUID()}`;
    await mkdir(join(directory, own), { mode: 0o700 });
    this.lease = join(directory, own);
    // Unique owner directories avoid deleting a replacement lock while recovering a dead writer.
    // PID reuse may conservatively block recovery; it never grants a second writer access.
    for (const name of await readdir(directory)) {
      if (name === own) continue;
      const match = /^(\d+)-[a-f0-9-]{36}$/.exec(name);
      if (!match) throw new ResourceStoreError('resource_store_locked');
      const pid = Number(match[1]);
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
      }
      if (alive) throw new ResourceStoreError('resource_store_locked');
      await rm(join(directory, name), { recursive: true });
    }
  }

  private async releaseLease(): Promise<void> {
    if (this.lease) await rm(this.lease, { recursive: true, force: true });
    this.lease = null;
  }

  private entry(packId: string): Entry {
    if (this.closed) throw new ResourceStoreError('resource_store_closed');
    const entry = this.entries.get(packId);
    if (!entry) throw new ResourceStoreError('resource_pack_unknown');
    return entry;
  }

  private directory(packId: string): string {
    return join(this.root, createHash('sha256').update(packId).digest('hex'));
  }

  private content(packId: string, id: string): string {
    if (!versionId.test(id)) throw new ResourceStoreError('resource_pointer_invalid');
    return join(this.directory(packId), 'versions', id, 'content');
  }

  private async verify(
    packId: string,
    directory: string,
    receipt: unknown,
    signal: AbortSignal,
    purpose: 'install' | 'cache' | 'legacy' | 'rollback' = 'install',
  ): Promise<TrustedPack> {
    let trusted: TrustedPack;
    try {
      trusted = await this.options.verifyTrustedPack({
        packId,
        directory,
        receipt,
        signal,
        purpose,
      });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ResourceStoreError) throw error;
      throw new ResourceStoreError('resource_trust_failed', undefined, { cause: error });
    }
    const descriptor = checkDescriptor(trusted, packId);
    if (!descriptor.compatible) throw new ResourceStoreError('resource_incompatible');
    return descriptor;
  }

  private async cached(
    packId: string,
    id: string,
    signal: AbortSignal,
    purpose: 'cache' | 'rollback' = 'cache',
  ): Promise<CachedPack> {
    const directory = this.content(packId, id);
    const record = await readJson(dirname(directory), 'receipt.json');
    const descriptor = await this.verify(packId, directory, record, signal, purpose);
    await checkTree(directory);
    for (const file of descriptor.files) await verifiedRead(directory, file, signal, () => {});
    return { id, descriptor };
  }

  private async restore(packId: string): Promise<void> {
    const directory = this.directory(packId);
    await ensureDirectory(join(directory, 'versions'));
    await ensureDirectory(join(directory, 'staging'));
    // A staging directory is never published. Recover interrupted transfers without touching versions.
    for (const name of await readdir(join(directory, 'staging')))
      await rm(join(directory, 'staging', name), { recursive: true, force: true });
    const entry = this.entry(packId);
    let pointer: unknown;
    try {
      pointer = await readJson(directory, 'pointer.json');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.failed(entry, error);
      return;
    }
    if (
      !pointer ||
      typeof pointer !== 'object' ||
      !('active' in pointer) ||
      !('prepared' in pointer)
    ) {
      this.failed(entry, new ResourceStoreError('resource_pointer_invalid'));
      return;
    }
    const value = pointer as Pointer & { failure?: unknown; downloadedBytes?: unknown };
    for (const key of ['active', 'prepared', 'previous'] as const) {
      if (value[key] === null) continue;
      try {
        if (typeof value[key] !== 'string')
          throw new ResourceStoreError('resource_pointer_invalid');
        entry[key] = await this.cached(packId, value[key], idleSignal());
      } catch (error) {
        this.failed(entry, error);
      }
    }
    const fallback = !entry.active && entry.previous !== null;
    if (fallback) {
      entry.active = entry.previous;
      entry.previous = null;
    }
    if (entry.status.failure === null && (entry.active || entry.prepared))
      entry.status.phase = 'ready';
    if (value.failure !== undefined && value.failure !== null) {
      if (typeof value.failure !== 'string' || !/^resource_[a-z_]{1,64}$/.test(value.failure))
        this.failed(entry, new ResourceStoreError('resource_pointer_invalid'));
      else if (entry.status.failure === null)
        this.failed(entry, new ResourceStoreError(value.failure));
    }
    if (
      typeof value.downloadedBytes === 'number' &&
      Number.isSafeInteger(value.downloadedBytes) &&
      value.downloadedBytes >= 0 &&
      value.downloadedBytes <= 512 * 1024 * 1024
    )
      entry.status.downloadedBytes = value.downloadedBytes;
    this.refreshVersions(entry);
    if (fallback)
      await this.persist(
        packId,
        { active: entry.active!.id, prepared: entry.prepared?.id ?? null, previous: null },
        entry.status.failure,
      );
  }

  private refreshVersions(entry: Entry): void {
    entry.status.activeVersion = entry.active?.descriptor.packVersion ?? null;
    entry.status.preparedVersion = entry.prepared?.descriptor.packVersion ?? null;
    entry.status.rollbackVersion = entry.previous?.descriptor.packVersion ?? null;
  }

  private failed(entry: Entry, error: unknown): void {
    entry.status.phase =
      error instanceof ResourceStoreError && error.code === 'resource_incompatible'
        ? 'incompatible'
        : 'failed';
    entry.status.failure =
      error instanceof ResourceStoreError
        ? error.code
        : error instanceof Error && error.name === 'AbortError'
          ? 'resource_cancelled'
          : 'resource_io_failed';
    this.refreshVersions(entry);
  }

  list(): ResourceStatus[] {
    return [...this.entries.keys()].map((packId) => this.getStatus(packId));
  }
  getStatus(packId: string): ResourceStatus {
    return { ...this.entry(packId).status };
  }
  cancel(packId: string): void {
    this.entry(packId);
    this.controllers.get(packId)?.abort();
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new ResourceStoreError('resource_operation_conflict');
    if (this.closed || this.closing) throw new ResourceStoreError('resource_store_closed');
    this.busy = true;
    let settle!: () => void;
    this.operation = new Promise<void>((resolve) => {
      settle = resolve;
    });
    try {
      return await operation();
    } finally {
      this.busy = false;
      settle();
      this.operation = undefined;
    }
  }

  private async persist(
    packId: string,
    pointer: Pointer,
    failure: string | null = null,
    downloadedBytes = this.entry(packId).status.downloadedBytes,
  ): Promise<void> {
    await atomicJson(join(this.directory(packId), 'pointer.json'), {
      ...pointer,
      failure,
      downloadedBytes,
    });
  }

  private async copy(
    directory: string,
    destination: string,
    descriptor: TrustedPack,
    signal: AbortSignal,
  ): Promise<void> {
    await ensureDirectory(destination);
    for (const file of descriptor.files) {
      signal.throwIfAborted();
      const path = join(destination, file.path);
      await ensureDirectory(dirname(path));
      const target = await open(path, 'wx', 0o600);
      try {
        await verifiedRead(directory, file, signal, async (chunk) => {
          await target.writeFile(chunk);
        });
        await target.sync();
      } finally {
        await target.close();
      }
      await chmod(path, 0o400);
    }
    await syncDirectory(destination);
  }

  async installVerified(
    packId: string,
    prepare: PreparePack,
    options: ResourceInstallOptions = {},
  ): Promise<ResourceStatus> {
    return this.install(packId, prepare, options, 'install');
  }

  private async install(
    packId: string,
    prepare: PreparePack,
    options: ResourceInstallOptions,
    purpose: 'install' | 'legacy',
  ): Promise<ResourceStatus> {
    const entry = this.entry(packId);
    if (
      options.packVersion !== undefined &&
      (!options.packVersion.length || options.packVersion.length > 128)
    )
      throw new ResourceStoreError('resource_version_mismatch');
    return this.exclusive(async () => {
      const controller = new AbortController();
      const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
      this.controllers.set(packId, controller);
      let staging: string | null = null;
      let sealed: string | null = null;
      try {
        signal.throwIfAborted();
        const available = [entry.active, entry.prepared].find(
          (candidate) =>
            candidate &&
            (!options.packVersion || options.packVersion === candidate.descriptor.packVersion),
        );
        if (!options.force && available) {
          const checked = await this.cached(packId, available.id, signal);
          if (entry.active?.id === available.id) entry.active = checked;
          else entry.prepared = checked;
          const clearFailure = entry.status.failure !== null;
          entry.status.phase = 'ready';
          entry.status.failure = null;
          this.refreshVersions(entry);
          if (clearFailure)
            await this.persist(packId, {
              active: entry.active?.id ?? null,
              prepared: entry.prepared?.id ?? null,
              previous: entry.previous?.id ?? null,
            });
          if (entry.prepared?.id === available.id) await this.activate(packId, signal);
          return this.getStatus(packId);
        }
        const id = randomUUID();
        staging = join(this.directory(packId), 'staging', id);
        await ensureDirectory(staging);
        entry.status.phase = 'downloading';
        entry.status.failure = null;
        entry.status.downloadedBytes = 0;
        const receipt = await prepare({
          directory: staging,
          signal,
          onProgress: (bytes) => {
            if (
              this.controllers.get(packId) === controller &&
              !signal.aborted &&
              entry.status.phase === 'downloading' &&
              Number.isSafeInteger(bytes) &&
              bytes >= entry.status.downloadedBytes &&
              bytes <= 512 * 1024 * 1024
            )
              entry.status.downloadedBytes = bytes;
          },
        });
        signal.throwIfAborted();
        entry.status.phase = 'verifying';
        await checkTree(staging);
        const descriptor = await this.verify(packId, staging, receipt, signal, purpose);
        if (options.packVersion && options.packVersion !== descriptor.packVersion)
          throw new ResourceStoreError('resource_version_mismatch');
        sealed = join(this.directory(packId), 'staging', randomUUID());
        await ensureDirectory(sealed);
        await this.copy(staging, join(sealed, 'content'), descriptor, signal);
        await atomicJson(join(sealed, 'receipt.json'), receipt);
        // Verify the actual durable snapshot using the same external adapter before publishing it.
        const copied = await this.verify(
          packId,
          join(sealed, 'content'),
          await readJson(sealed, 'receipt.json'),
          signal,
          purpose,
        );
        if (JSON.stringify(copied) !== JSON.stringify(descriptor))
          throw new ResourceStoreError('resource_descriptor_changed');
        signal.throwIfAborted();
        await rename(sealed, join(this.directory(packId), 'versions', id));
        sealed = null;
        await syncDirectory(join(this.directory(packId), 'versions'));
        signal.throwIfAborted();
        const candidate = { id, descriptor };
        await this.persist(packId, {
          active: entry.active?.id ?? null,
          prepared: id,
          previous: entry.previous?.id ?? null,
        });
        entry.prepared = candidate;
        entry.status.phase = 'ready';
        entry.status.failure = null;
        this.refreshVersions(entry);
        await this.activate(packId, signal);
        return this.getStatus(packId);
      } catch (error) {
        this.failed(entry, error);
        await this.persist(
          packId,
          {
            active: entry.active?.id ?? null,
            prepared: entry.prepared?.id ?? null,
            previous: entry.previous?.id ?? null,
          },
          entry.status.failure,
        ).catch(() => undefined);
        throw error;
      } finally {
        this.controllers.delete(packId);
        if (staging) await rm(staging, { recursive: true, force: true });
        if (sealed) await rm(sealed, { recursive: true, force: true });
      }
    });
  }

  async repair(
    packId: string,
    prepare: PreparePack,
    options: { signal?: AbortSignal; packVersion?: string } = {},
  ): Promise<ResourceStatus> {
    return this.installVerified(packId, prepare, { ...options, force: true });
  }

  /** Reuse only the same active snapshot authenticated against the installer's current policy. */
  async reuseActive<Identity>(
    packId: string,
    verifyIdentity: ActivePackVerification<Identity>,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ status: ResourceStatus; identity: Identity } | null> {
    return this.exclusive(async () => {
      const entry = this.entry(packId);
      let active = entry.active;
      if (!active) {
        // An old Core catalog may be incompatible with this Core until the SDK
        // authenticates a replacement. The pointer grants no content authorization.
        let pointer;
        try {
          pointer = (await readJson(this.directory(packId), 'pointer.json')) as Pointer;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
        if (pointer?.active === null) return null;
        if (typeof pointer?.active !== 'string' || !versionId.test(pointer.active))
          throw new ResourceStoreError('resource_pointer_invalid');
        active = { id: pointer.active, descriptor: undefined! };
      }
      const controller = new AbortController();
      const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
      this.controllers.set(packId, controller);
      try {
        signal.throwIfAborted();
        const directory = this.content(packId, active.id);
        const receipt = await readJson(dirname(directory), 'receipt.json');
        const verified = await verifyIdentity({ receipt: structuredClone(receipt), signal });
        const effectiveReceipt = verified.receipt ?? receipt;
        const descriptor = await this.verify(packId, directory, effectiveReceipt, signal, 'cache');
        const pinned = checkDescriptor(verified.descriptor, packId);
        if (!pinned.compatible) throw new ResourceStoreError('resource_incompatible');
        if (
          JSON.stringify(descriptor) !== JSON.stringify(pinned) ||
          (active.descriptor !== undefined &&
            JSON.stringify(active.descriptor) !== JSON.stringify(pinned))
        )
          throw new ResourceStoreError('resource_descriptor_changed');
        try {
          await checkTree(directory);
          for (const file of pinned.files) await verifiedRead(directory, file, signal, () => {});
        } catch (error) {
          if (!signal.aborted) {
            this.failed(entry, error);
            await this.persist(
              packId,
              {
                active: active.id,
                prepared: entry.prepared?.id ?? null,
                previous: entry.previous?.id ?? null,
              },
              entry.status.failure,
            ).catch(() => undefined);
          }
          throw error;
        }
        signal.throwIfAborted();
        if (verified.receipt !== undefined)
          await atomicJson(join(dirname(directory), 'receipt.json'), effectiveReceipt);
        entry.active = { id: active.id, descriptor: pinned };
        this.refreshVersions(entry);
        const clearFailure = entry.status.failure !== null;
        entry.status.phase = 'ready';
        entry.status.failure = null;
        if (clearFailure)
          await this.persist(packId, {
            active: active.id,
            prepared: entry.prepared?.id ?? null,
            previous: entry.previous?.id ?? null,
          });
        return { status: this.getStatus(packId), identity: structuredClone(verified.identity) };
      } finally {
        this.controllers.delete(packId);
      }
    });
  }

  /** Import only authorized members; never alter or remove the existing bundled materials. */
  async reuseLegacy(
    packId: string,
    legacy: { directory: string; receipt: unknown },
    options: { signal?: AbortSignal; packVersion?: string } = {},
  ): Promise<ResourceStatus> {
    return this.install(
      packId,
      async ({ directory, signal }) => {
        const descriptor = await this.verify(
          packId,
          legacy.directory,
          legacy.receipt,
          signal,
          'legacy',
        );
        await this.copy(legacy.directory, directory, descriptor, signal);
        return legacy.receipt;
      },
      options,
      'legacy',
    );
  }

  private async activate(
    packId: string,
    signal = idleSignal(),
    rollback = false,
  ): Promise<boolean> {
    const entry = this.entry(packId);
    const requested = rollback ? entry.previous : entry.prepared;
    if (!requested || !this.options.activateWhenSafe) return false;
    let committed = false;
    const accepted = await this.options.activateWhenSafe(async () => {
      if (committed) throw new ResourceStoreError('resource_activation_invalid');
      const candidate = await this.cached(
        packId,
        requested.id,
        signal,
        rollback ? 'rollback' : 'cache',
      );
      signal.throwIfAborted();
      await this.persist(packId, {
        active: candidate.id,
        prepared: null,
        previous: entry.active?.id ?? null,
      });
      entry.previous = entry.active;
      entry.active = candidate;
      entry.prepared = null;
      entry.status.phase = 'ready';
      entry.status.failure = null;
      this.refreshVersions(entry);
      committed = true;
    });
    if (accepted !== committed) throw new ResourceStoreError('resource_activation_invalid');
    return committed;
  }

  async activatePrepared(packId: string): Promise<boolean> {
    return this.exclusive(() => this.activate(packId));
  }

  async rollback(packId: string): Promise<boolean> {
    return this.exclusive(() => this.activate(packId, idleSignal(), true));
  }

  async removeOptional(packId: string): Promise<ResourceStatus> {
    const entry = this.entry(packId);
    if (!entry.optional) throw new ResourceStoreError('resource_pack_required');
    return this.exclusive(async () => {
      if (this.readers) throw new ResourceStoreError('resource_operation_conflict');
      if (!this.options.activateWhenSafe)
        throw new ResourceStoreError('resource_activation_blocked');
      let committed = false;
      const accepted = await this.options.activateWhenSafe(async () => {
        if (committed) throw new ResourceStoreError('resource_activation_invalid');
        await this.persist(packId, { active: null, prepared: null, previous: null }, null, 0);
        entry.active = null;
        entry.prepared = null;
        entry.previous = null;
        entry.status = {
          packId,
          phase: 'missing',
          downloadedBytes: 0,
          activeVersion: null,
          preparedVersion: null,
          rollbackVersion: null,
          failure: null,
        };
        committed = true;
      });
      if (!accepted || !committed) throw new ResourceStoreError('resource_activation_blocked');
      // Readers own byte snapshots. No live path is unlinked before the guarded pointer is cleared.
      for (const name of await readdir(join(this.directory(packId), 'versions')))
        await rm(join(this.directory(packId), 'versions', name), { recursive: true, force: true });
      return this.getStatus(packId);
    });
  }

  async read(
    packId: string,
    relative: string,
    range?: string,
  ): Promise<{
    bytes: Buffer;
    contentType: string;
    totalBytes: number;
    start: number;
    end: number;
    partial: boolean;
  }> {
    const entry = this.entry(packId);
    const active = entry.active;
    if (!active) throw new ResourceStoreError('resource_not_ready');
    const file = active.descriptor.files.find((candidate) => candidate.path === relative);
    if (!file) throw new ResourceStoreError('resource_file_unknown');
    let start = 0,
      end = file.bytes - 1;
    if (range !== undefined) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2]) || file.bytes === 0)
        throw new ResourceStoreError('resource_range_invalid', file.bytes);
      if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0)
          throw new ResourceStoreError('resource_range_invalid', file.bytes);
        start = Math.max(0, file.bytes - suffix);
      } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), end) : end;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= file.bytes
        )
          throw new ResourceStoreError('resource_range_invalid', file.bytes);
      }
    }
    const readBytes = end - start + 1;
    if (this.readers >= 8 || this.readingBytes + readBytes > 128 * 1024 * 1024)
      throw new ResourceStoreError('resource_operation_conflict');
    this.readers++;
    this.readingBytes += readBytes;
    try {
      const result = Buffer.alloc(readBytes);
      await verifiedRead(this.content(packId, active.id), file, idleSignal(), (chunk, offset) => {
        const from = Math.max(start, offset),
          to = Math.min(end + 1, offset + chunk.length);
        if (to > from) chunk.copy(result, from - start, from - offset, to - offset);
      });
      return {
        bytes: result,
        contentType: contentType(relative),
        totalBytes: file.bytes,
        start,
        end,
        partial: range !== undefined,
      };
    } catch (error) {
      if (entry.active?.id === active.id) this.failed(entry, error);
      throw error;
    } finally {
      this.readers--;
      this.readingBytes -= readBytes;
    }
  }

  /** Native integration only; never reopen this path for HTTP. Use read() for a verified byte snapshot. */
  async resolveReadOnlyPath(packId: string, relative: string): Promise<string> {
    const entry = this.entry(packId);
    const active = entry.active;
    const file = active?.descriptor.files.find((candidate) => candidate.path === relative);
    if (!active || !file) throw new ResourceStoreError('resource_file_unknown');
    if (this.readers >= 8) throw new ResourceStoreError('resource_operation_conflict');
    this.readers++;
    try {
      return await verifiedRead(this.content(packId, active.id), file, idleSignal(), () => {});
    } catch (error) {
      if (entry.active?.id === active.id) this.failed(entry, error);
      throw error;
    } finally {
      this.readers--;
    }
  }

  async close(): Promise<void> {
    if (this.busy || this.readers) throw new ResourceStoreError('resource_operation_conflict');
    this.closed = true;
    await this.releaseLease();
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort();
    await this.operation;
    await this.close();
  }
}
