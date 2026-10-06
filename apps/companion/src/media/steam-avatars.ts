import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';

const LIMIT = 256;
const TTL = 7 * 24 * 60 * 60 * 1000;
type Entry = { filename: string; fetchedAt: number };
const validId = (id: string) => /^7656119\d{10}$/.test(id);
const validFilename = (name: string) => /^[a-f0-9]{64}\.jpg$/.test(name);
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function profile(value: unknown): { steamid: string; avatarfull: string } | null {
  const item = record(value);
  return typeof item.steamid === 'string' && typeof item.avatarfull === 'string'
    ? { steamid: item.steamid, avatarfull: item.avatarfull }
    : null;
}

async function limitedBytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error('steam-media-unavailable');
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > limit) throw new Error('steam-media-size');
      parts.push(chunk.value);
    }
    return Buffer.concat(parts);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Optional media only. Never writes Steam names, roster identities or match documents. */
export class SteamAvatars {
  private key = '';
  private entries = new Map<string, Entry>();
  private retryAt = new Map<string, number>();
  private pending = false;
  private unavailable = false;
  private closed = false;
  private revision = 0;
  private readonly abort = new AbortController();
  private persistence: Promise<unknown> = Promise.resolve();
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.persistence.then(run, run);
    this.persistence = next.catch(() => undefined);
    return next;
  }
  private changed = () => {};
  constructor(
    private readonly directory: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  onChanged(callback: () => void): void {
    this.changed = callback;
  }
  async load(): Promise<void> {
    try {
      if ((await stat(join(this.directory, 'key.json'))).size > 1024)
        throw new Error('invalid-setting');
      const secret = record(
        JSON.parse(await readFile(join(this.directory, 'key.json'), 'utf8')) as unknown,
      );
      if (typeof secret.key === 'string' && /^[a-f0-9]{32}$/i.test(secret.key))
        this.key = secret.key;
    } catch {
      /* Optional setting. */
    }
    try {
      if ((await stat(join(this.directory, 'index.json'))).size > 64_000) return;
      const entries: unknown = JSON.parse(
        await readFile(join(this.directory, 'index.json'), 'utf8'),
      );
      if (!Array.isArray(entries)) return;
      for (const value of (entries as unknown[]).slice(-LIMIT)) {
        if (!Array.isArray(value)) continue;
        const [id, raw] = value as unknown[];
        const entry = record(raw);
        if (
          typeof id !== 'string' ||
          !validId(id) ||
          typeof entry.filename !== 'string' ||
          !validFilename(entry.filename) ||
          typeof entry.fetchedAt !== 'number' ||
          !Number.isFinite(entry.fetchedAt)
        )
          continue;
        if (
          await stat(join(this.directory, entry.filename)).then(
            (file) => file.isFile() && file.size <= 512_000,
            () => false,
          )
        )
          this.entries.set(id, { filename: entry.filename, fetchedAt: entry.fetchedAt });
      }
    } catch {
      /* A missing cache never blocks startup. */
    }
  }
  view() {
    return {
      configured: this.key.length > 0,
      cached: this.entries.size,
      fetching: this.pending,
      unavailable: this.unavailable,
    };
  }
  async configure(key: string): Promise<void> {
    if (key !== '' && !/^[a-f0-9]{32}$/i.test(key))
      throw new Error('Steam API Key 应为 32 位十六进制字符。');
    this.revision++;
    await this.serialize(async () => {
      await mkdir(this.directory, { recursive: true });
      const path = join(this.directory, 'key.json');
      await writeFile(`${path}.tmp`, JSON.stringify({ key }), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
      this.key = key;
    });
    this.retryAt.clear();
    this.unavailable = false;
    this.changed();
  }
  get(id: string): string | null {
    const entry = this.entries.get(id);
    return entry ? `/local/v1/steam-avatar/${entry.filename}` : null;
  }
  request(ids: readonly string[]): void {
    if (!this.key || this.pending || this.closed) return;
    const now = Date.now();
    const missing = [...new Set(ids)]
      .filter(
        (id) =>
          validId(id) &&
          now - (this.entries.get(id)?.fetchedAt ?? 0) > TTL &&
          now >= (this.retryAt.get(id) ?? 0),
      )
      .slice(0, 10);
    if (!missing.length) return;
    this.pending = true;
    for (const id of missing) this.retryAt.set(id, now + 60_000);
    while (this.retryAt.size > LIMIT) this.retryAt.delete(this.retryAt.keys().next().value!);
    const revision = this.revision;
    void this.fetchBatch(missing, revision)
      .catch(() => {
        if (this.revision === revision) this.unavailable = true;
        // Never log upstream URLs, exceptions, profiles or credentials.
      })
      .finally(() => {
        this.pending = false;
        if (!this.closed) this.changed();
      });
  }
  private async fetchBatch(ids: string[], revision: number): Promise<void> {
    const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/');
    url.searchParams.set('key', this.key);
    url.searchParams.set('steamids', ids.join(','));
    const response = await this.fetchImpl(url, {
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(8000)]),
      redirect: 'error',
    });
    const body = record(
      JSON.parse((await limitedBytes(response, 128_000)).toString('utf8')) as unknown,
    );
    const rawPlayers = record(body.response).players;
    if (!Array.isArray(rawPlayers)) throw new Error('steam-media-unavailable');
    const players = (rawPlayers as unknown[])
      .slice(0, 10)
      .map(profile)
      .filter((item) => item !== null);
    await mkdir(this.directory, { recursive: true });
    // At most two downloads at once; the whole batch is bounded to ten observed IDs.
    for (let offset = 0; offset < players.length && offset < 10; offset += 2) {
      if (this.closed || this.revision !== revision) return;
      await Promise.allSettled(
        players.slice(offset, offset + 2).map(async (player) => {
          if (!ids.includes(player?.steamid) || typeof player.avatarfull !== 'string') return;
          const avatar = new URL(player.avatarfull);
          if (
            avatar.protocol !== 'https:' ||
            avatar.username ||
            avatar.password ||
            (avatar.port !== '' && avatar.port !== '443') ||
            ![
              'avatars.steamstatic.com',
              'avatars.akamai.steamstatic.com',
              'steamcdn-a.akamaihd.net',
            ].includes(avatar.hostname)
          )
            return;
          const image = await this.fetchImpl(avatar, {
            signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(8000)]),
            redirect: 'error',
          });
          const bytes = await limitedBytes(image, 512_000);
          if (
            bytes.length < 4 ||
            bytes[0] !== 0xff ||
            bytes[1] !== 0xd8 ||
            bytes.at(-2) !== 0xff ||
            bytes.at(-1) !== 0xd9
          )
            return;
          if (this.closed || this.revision !== revision) return;
          const filename = `${createHash('sha256').update(bytes).digest('hex')}.jpg`;
          await this.serialize(async () => {
            if (this.closed || this.revision !== revision) return;
            await writeFile(join(this.directory, filename), bytes, { mode: 0o600 });
            this.entries.delete(player.steamid);
            this.entries.set(player.steamid, { filename, fetchedAt: Date.now() });
          });
        }),
      );
    }
    await this.serialize(async () => {
      if (this.closed || this.revision !== revision) return;
      this.unavailable = !ids.some(
        (id) => (this.entries.get(id)?.fetchedAt ?? 0) > Date.now() - 60_000,
      );
      while (this.entries.size > LIMIT) this.entries.delete(this.entries.keys().next().value!);
      const retained = new Set([...this.entries.values()].map((entry) => entry.filename));
      for (const filename of await readdir(this.directory)) {
        if (validFilename(filename) && !retained.has(filename))
          await rm(join(this.directory, filename), { force: true });
      }
      const path = join(this.directory, 'index.json');
      await writeFile(`${path}.tmp`, JSON.stringify([...this.entries]), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
  }
  async image(filename: string): Promise<Buffer | null> {
    if (
      !validFilename(filename) ||
      ![...this.entries.values()].some((entry) => entry.filename === filename)
    )
      return null;
    try {
      if ((await stat(join(this.directory, filename))).size > 512_000) return null;
      return await readFile(join(this.directory, filename));
    } catch {
      return null;
    }
  }
  async clear(): Promise<void> {
    this.revision++;
    await this.serialize(async () => {
      for (const entry of this.entries.values())
        await rm(join(this.directory, entry.filename), { force: true });
      this.entries.clear();
      this.retryAt.clear();
      await rm(join(this.directory, 'index.json'), { force: true });
    });
    this.changed();
  }
  close(): void {
    this.closed = true;
    this.revision++;
    this.abort.abort();
  }
}

export function registerSteamAvatarRoutes(
  app: FastifyInstance,
  avatars: SteamAvatars,
  policy: LocalWebOriginPolicy,
): void {
  app.get('/local/v1/steam-avatars', (_request, reply) =>
    reply.header('cache-control', 'no-store').send(avatars.view()),
  );
  app.post('/operator/steam-avatars', { bodyLimit: 1024 }, async (request, reply) => {
    if (policy.mode !== 'loopback' || !checkLocalWebOrigin(policy, request.headers.origin).allowed)
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const body = request.body as { action?: unknown; key?: unknown } | null;
    try {
      if (body?.action === 'clear') await avatars.clear();
      else if (body?.action === 'configure' && typeof body.key === 'string')
        await avatars.configure(body.key);
      else return reply.code(400).send({ message: '头像设置无效。' });
      return avatars.view();
    } catch {
      return reply.code(400).send({ message: '头像设置未保存，请检查密钥格式和目录权限。' });
    }
  });
  app.get('/local/v1/steam-avatar/:filename', async (request, reply) => {
    const bytes = await avatars.image((request.params as { filename: string }).filename);
    return bytes
      ? reply
          .header('content-type', 'image/jpeg')
          .header('x-content-type-options', 'nosniff')
          .header('cache-control', 'public, max-age=3600')
          .send(bytes)
      : reply.code(404).send({ error: 'avatar_unavailable' });
  });
}
