import type { BpProjection } from '@rivalhub-broadcast/core/projection';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { bpSnapshotSchema, type BpSnapshot } from '@rivalhub-broadcast/protocol/bp';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';

export class BpSession {
  private readonly epoch = randomUUID();
  private revision = 0;
  private fingerprint = '';
  private projection: BpProjection | null = null;
  private state: BpSnapshot['state'] = 'hidden';
  private count = 0;
  private startedAt = 0;
  constructor(
    private readonly getProjection: () => BpProjection | null,
    private readonly now = () => performance.now(),
  ) {}
  get(): BpSnapshot {
    const projection = this.getProjection();
    const fingerprint = JSON.stringify(projection);
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.projection = projection;
      this.state = 'hidden';
      this.count = 0;
      this.revision++;
    }
    if (this.state === 'revealing') {
      const count = Math.min(
        this.projection!.steps.length,
        1 + Math.floor(Math.max(0, this.now() - this.startedAt) / 1600),
      );
      if (count !== this.count) {
        this.count = count;
      }
      if (count === this.projection!.steps.length) this.state = 'shown';
    } else if (this.state === 'hiding' && this.now() - this.startedAt >= 360) {
      this.state = 'hidden';
      this.count = 0;
      this.revision++;
    }
    return bpSnapshotSchema.parse({
      schemaVersion: 'rivalhub.bp.v1',
      revision: `${this.epoch}:${this.revision}`,
      projection: this.projection,
      state: this.state,
      revealedCount: this.count,
    });
  }
  command(kind: 'play' | 'hide', revision: string): BpSnapshot | null {
    const current = this.get();
    if (current.revision !== revision) return null;
    if (kind === 'play') {
      if (this.state !== 'hidden' || this.projection === null) return null;
      this.state = 'revealing';
      this.count = 1;
    } else {
      if (this.state === 'hidden' || this.state === 'hiding') return null;
      this.state = 'hiding';
    }
    this.startedAt = this.now();
    this.revision++;
    return this.get();
  }
}
export function registerBpRoutes(
  app: FastifyInstance,
  options: {
    readonly originPolicy: LocalWebOriginPolicy;
    readonly getProjection: () => BpProjection | null;
    readonly now?: () => number;
  },
) {
  const session = new BpSession(options.getProjection, options.now);
  app.get('/local/v1/bp', (request, reply) => {
    const state = session.get();
    const etag = `"${state.revision}:${state.state}:${state.revealedCount}"`;
    reply.header('cache-control', 'no-store').header('etag', etag);
    return request.headers['if-none-match'] === etag ? reply.code(304).send() : state;
  });
  app.post('/operator/bp-command', (request, reply) => {
    if (
      options.originPolicy.mode !== 'loopback' ||
      !checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed
    ) {
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    }
    const body = request.body as Record<string, unknown> | null;
    if (
      !body ||
      (body.kind !== 'play' && body.kind !== 'hide') ||
      typeof body.expectedRevision !== 'string'
    ) {
      return reply.code(400).send({ error: 'invalid_bp_command' });
    }
    const result = session.command(body.kind, body.expectedRevision);
    return (
      result ??
      reply.code(409).send({ error: 'bp_conflict', message: 'BP 状态已更新，请核对后重试。' })
    );
  });
  return session;
}
