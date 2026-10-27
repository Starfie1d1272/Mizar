import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { replaceDurableJson } from '../match-context/durable-json.js';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';

export type BpPresentationMode = 'full' | 'compact';
export class BpPresentationSettings {
  private mode: BpPresentationMode = 'full';
  private revision = randomUUID();
  private writing = Promise.resolve();
  constructor(private readonly path?: string) {}
  async load(): Promise<void> {
    if (!this.path) return;
    try {
      const saved: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (
        typeof saved !== 'object' ||
        saved === null ||
        !('mode' in saved) ||
        (saved.mode !== 'full' && saved.mode !== 'compact')
      )
        throw new Error('BP 展示设置无效。');
      this.mode = saved.mode;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  get() {
    return { mode: this.mode, revision: this.revision };
  }
  set(mode: BpPresentationMode, expectedRevision: string) {
    const next = this.writing.then(async () => {
      if (expectedRevision !== this.revision) return false;
      if (mode === this.mode) return true;
      if (this.path) await replaceDurableJson(this.path, { mode });
      this.mode = mode;
      this.revision = randomUUID();
      return true;
    });
    this.writing = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
export function registerBpPresentationSettings(
  app: FastifyInstance,
  store: BpPresentationSettings,
  origin: LocalWebOriginPolicy,
) {
  app.get('/local/v1/bp-presentation', (_request, reply) =>
    reply.header('cache-control', 'no-store').send(store.get()),
  );
  app.post('/operator/bp-presentation', { bodyLimit: 1024 }, async (request, reply) => {
    if (origin.mode !== 'loopback' || !checkLocalWebOrigin(origin, request.headers.origin).allowed)
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const body = request.body as Record<string, unknown> | null;
    if (
      (body?.mode !== 'full' && body?.mode !== 'compact') ||
      typeof body.expectedRevision !== 'string'
    )
      return reply.code(400).send({ error: 'invalid_bp_presentation' });
    return (await store.set(body.mode, body.expectedRevision))
      ? store.get()
      : reply.code(409).send({ message: 'BP 展示设置已变化，请刷新后重试。' });
  });
}
