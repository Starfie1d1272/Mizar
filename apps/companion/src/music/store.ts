import { createHash, randomUUID } from 'node:crypto';
import { open, lstat, readFile, rename, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { z } from 'zod';
import {
  defaultMusicConfig,
  musicConfigSchema,
  musicTrackSchema,
  MUSIC_GROUPS,
  type MusicConfig,
  type MusicGroup,
} from '@mizar/protocol/music';
import { atomicJson, ensureDirectory, safePath } from '../resource-store/files.js';
import { audioBytes, readMusicPack } from './archive.js';

const playbackSchema = z
  .object({
    key: z.string().max(2000),
    scope: z.string().max(4000).optional(),
    group: z.enum(MUSIC_GROUPS),
    track: musicTrackSchema,
    configRevision: z.string().uuid().optional(),
    finished: z.boolean(),
    suspended: z.boolean().default(false),
    cursorMs: z.number().min(0).max(86_400_000).default(0),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    config: musicConfigSchema,
    configRevision: z
      .string()
      .uuid()
      .default(() => randomUUID()),
    master: z.number().finite().min(0).max(1).default(1),
    muted: z.boolean().default(false),
    monitorPreference: z.boolean().nullable().default(null),
    desktopMonitorOriginal: z
      .object({
        bgm: z
          .object({ uuid: z.string(), mode: z.literal('OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT') })
          .nullable(),
        stinger: z
          .object({ uuid: z.string(), mode: z.literal('OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT') })
          .nullable(),
      })
      .strict()
      .default({ bgm: null, stinger: null }),
    monitorConfigured: z
      .object({ bgm: z.string().nullable(), stinger: z.string().nullable() })
      .strict()
      .default({ bgm: null, stinger: null }),
    held: z.boolean(),
    owner: z.string().uuid(),
    sources: z.object({ bgm: z.string().nullable(), stinger: z.string().nullable() }).strict(),
    bgm: playbackSchema.nullable(),
    stinger: playbackSchema.nullable(),
    pause: z.object({ map: z.string(), id: z.string() }).nullable(),
    consumed: z.array(z.string().max(2000)).max(64),
  })
  .strict();
export type MusicState = z.infer<typeof stateSchema>;
export type Playback = NonNullable<MusicState['bgm']>;

export class MusicStore {
  ready = false;
  failure = false;
  private importing = false;
  state: MusicState = {
    version: 1,
    config: defaultMusicConfig(),
    configRevision: randomUUID(),
    master: 1,
    muted: false,
    monitorPreference: true,
    desktopMonitorOriginal: { bgm: null, stinger: null },
    monitorConfigured: { bgm: null, stinger: null },
    held: false,
    owner: randomUUID(),
    sources: { bgm: null, stinger: null },
    bgm: null,
    stinger: null,
    pause: null,
    consumed: [],
  };
  private trackCache = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly directory: string,
    private readonly diagnostic: (stage: string, evidence: unknown) => void = () => {},
  ) {}
  private async stage<T>(stage: string, evidence: unknown, run: () => Promise<T> | T): Promise<T> {
    this.diagnostic(stage, { result: 'begin', ...(evidence as object) });
    try {
      const result = await run();
      this.diagnostic(stage, { result: 'success', ...(evidence as object) });
      return result;
    } catch (error) {
      this.diagnostic(stage, { result: 'failure', ...(evidence as object), error });
      throw error;
    }
  }
  previewEvent(stage: string, evidence: unknown) {
    try {
      this.diagnostic(stage, evidence);
    } catch {
      /* Diagnostics cannot own playback. */
    }
  }
  async load() {
    try {
      await this.stage('music_load', { directory: this.directory }, () => this.loadState());
    } catch (error) {
      this.failure = true;
      this.ready = false;
      throw error;
    }
  }
  private async loadState() {
    await ensureDirectory(this.directory);
    await ensureDirectory(join(this.directory, 'tracks'));
    try {
      const path = await safePath(this.directory, 'state.json');
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024)
        throw new Error('music_state_invalid');
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
      this.state = stateSchema.parse(raw);
      const legacy = z
        .object({
          configRevision: z.unknown().optional(),
          master: z.unknown().optional(),
          muted: z.unknown().optional(),
        })
        .parse(raw);
      let migrated =
        !legacy.configRevision || legacy.master === undefined || legacy.muted === undefined;
      for (const group of MUSIC_GROUPS) {
        for (const track of this.state.config.groups[group].tracks) {
          if (!track.entryId) {
            track.entryId = randomUUID();
            migrated = true;
          }
        }
      }
      for (const layer of ['bgm', 'stinger'] as const) {
        const playback = this.state[layer];
        if (playback && !playback.configRevision) {
          playback.configRevision = this.state.configRevision;
          const matches = this.state.config.groups[playback.group].tracks.filter(
            (track) =>
              track.id === playback.track.id &&
              track.startMs === playback.track.startMs &&
              track.endMs === playback.track.endMs,
          );
          if (!playback.track.entryId && matches.length === 1)
            playback.track.entryId = matches[0]!.entryId!;
          migrated = true;
        }
      }
      if (migrated) await atomicJson(path, this.state);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('music_state_invalid', { cause: error });
      this.failure = false;
      await this.update(() => undefined);
    }
    this.failure = false;
    this.ready = true;
    this.diagnostic('music_loaded_snapshot', { state: this.state });
  }
  update(change: (state: MusicState) => void): Promise<void> {
    const result = this.queue.then(async () => {
      if (this.failure) throw new Error('music_state_invalid');
      const next = structuredClone(this.state);
      change(next);
      if (JSON.stringify(next.config) !== JSON.stringify(this.state.config))
        next.configRevision = randomUUID();
      stateSchema.parse(next);
      await this.stage('music_commit_config', { before: this.state, after: next }, () =>
        atomicJson(join(this.directory, 'state.json'), next),
      );
      this.state = next;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  async add(name: string, bytes: Buffer) {
    if (this.failure || !this.ready) throw new Error('music_state_invalid');
    await this.stage('music_validate', { name, bytes: bytes.length }, () => {
      if (!audioBytes(name, bytes)) throw new Error('music_track_invalid');
    });
    const id = `${createHash('sha256').update(bytes).digest('hex')}.${name.split('.').at(-1)!.toLowerCase()}`;
    const track = musicTrackSchema.parse({ id, name: basename(name) });
    const target = join(this.directory, 'tracks', id);
    const temporary = join(this.directory, 'tracks', `tmp-${randomUUID()}`);
    await safePath(join(this.directory, 'tracks'));
    try {
      // OBS may hold the existing media file open on Windows. Reuse it only
      // after the same integrity and path checks used for playback.
      await this.trackPath(id);
      return track;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const fd = await this.stage('music_open_track', { name, id, target, temporary }, () =>
      open(temporary, 'wx', 0o600),
    );
    try {
      await this.stage('music_write', { name, id, bytes: bytes.length }, async () => {
        await fd.writeFile(bytes);
        await fd.sync();
      });
    } finally {
      await fd.close();
    }
    try {
      await this.stage('music_commit_track', { name, id }, async () => {
        try {
          await rename(temporary, target);
        } catch (error) {
          if (!['EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
            throw error;
          // A concurrent import may have installed these bytes first.
          await this.trackPath(id);
        }
      });
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return track;
  }
  async trackPath(id: string) {
    if (!/^[a-f0-9]{64}\.(wav|mp3|ogg|flac|m4a)$/.test(id)) throw new Error('music_track_invalid');
    const path = await safePath(join(this.directory, 'tracks'), id);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024)
      throw new Error('music_track_invalid');
    const stamp = JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
    if (this.trackCache.get(id) === stamp) return path;
    const bytes = await readFile(path);
    if (
      !audioBytes(id, bytes) ||
      createHash('sha256').update(bytes).digest('hex') !== id.split('.')[0]
    )
      throw new Error('music_track_invalid');
    this.trackCache.set(id, stamp);
    while (this.trackCache.size > 128) this.trackCache.delete(this.trackCache.keys().next().value!);
    return path;
  }
  async configure(config: MusicConfig, preserveEntries = true) {
    const parsed = musicConfigSchema.parse(config);
    for (const group of MUSIC_GROUPS) {
      const old = this.state.config.groups[group].tracks;
      const used = new Set(
        parsed.groups[group].tracks.flatMap((track) => (track.entryId ? [track.entryId] : [])),
      );
      for (const track of parsed.groups[group].tracks) {
        if (!track.entryId) {
          const matches = old.filter(
            (item) =>
              item.id === track.id && item.startMs === track.startMs && item.endMs === track.endMs,
          );
          const candidate =
            preserveEntries && matches.length === 1 ? matches[0]!.entryId : undefined;
          track.entryId = candidate && !used.has(candidate) ? candidate : randomUUID();
          used.add(track.entryId);
        }
      }
    }
    musicConfigSchema.parse(parsed);
    for (const group of MUSIC_GROUPS)
      for (const track of parsed.groups[group].tracks)
        await this.stage('music_validate_stored_track', { group, id: track.id }, () =>
          this.trackPath(track.id),
        );
    await this.update((s) => {
      s.config = parsed;
    });
  }
  async import(zip: Buffer) {
    // Fully validate before staging content; the config pointer is the only activation point.
    if (this.importing || this.failure || !this.ready) throw new Error('music_import_unavailable');
    this.importing = true;
    try {
      const { manifest, entries } = await this.stage(
        'music_validate_archive',
        { bytes: zip.length },
        () => readMusicPack(zip),
      );
      const config = defaultMusicConfig();
      for (const group of MUSIC_GROUPS) {
        const spec = manifest.groups[group];
        const tracks = [];
        for (const track of spec.tracks)
          tracks.push({
            ...(await this.add(basename(track.path), entries.get(track.path)!)),
            startMs: track.startMs,
            endMs: track.endMs,
          });
        config.groups[group] = { ...spec, tracks };
      }
      await this.configure(config, false);
    } finally {
      this.importing = false;
    }
  }
  async hold(held: boolean) {
    await this.update((s) => {
      s.held = held;
    });
  }
  async consume(key: string) {
    await this.update((s) => {
      s.consumed = [...new Set([...s.consumed.filter((k) => k !== key), key])].slice(-64);
    });
  }
}
export function looping(group: MusicGroup) {
  return group === 'waiting' || group === 'technical';
}
