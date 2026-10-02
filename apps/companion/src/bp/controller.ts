import type { BpProjection as CoreBpProjection } from '@mizar/core/projection';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { bpSnapshotSchema, type BpSnapshot } from '@mizar/protocol/bp';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';

export class BpSession {
  private readonly epoch = randomUUID();
  private revision = 0;
  private fingerprint = '';
  private projection: CoreBpProjection | null = null;
  private state: BpSnapshot['state'] = 'hidden';
  private count = 0;
  private startedAt = 0;
  private pausedAt: number | null = null;
  private pausedDuration = 0;
  private presentationNow(): number {
    return (this.pausedAt ?? this.now()) - this.pausedDuration;
  }
  setPaused(paused: boolean): void {
    if (paused && this.pausedAt === null) this.pausedAt = this.now();
    else if (!paused && this.pausedAt !== null) {
      this.pausedDuration += Math.max(0, this.now() - this.pausedAt);
      this.pausedAt = null;
    }
  }
  constructor(
    private readonly getProjection: () => CoreBpProjection | null,
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
        1 + Math.floor(Math.max(0, this.presentationNow() - this.startedAt) / 1600),
      );
      if (count !== this.count) {
        this.count = count;
      }
      if (count === this.projection!.steps.length) this.state = 'shown';
    } else if (this.state === 'hiding' && this.presentationNow() - this.startedAt >= 360) {
      this.state = 'hidden';
      this.count = 0;
      this.revision++;
    }
    const presentationProjection =
      this.projection === null
        ? null
        : {
            competition: this.projection.competition,
            stage: this.projection.stage,
            format: this.projection.format,
            entrants: {
              a: {
                name: this.projection.entrants.a.name,
                logoUrl: this.projection.entrants.a.logoUrl,
              },
              b: {
                name: this.projection.entrants.b.name,
                logoUrl: this.projection.entrants.b.logoUrl,
              },
            },
            cards: this.projection.cards,
            steps: this.projection.steps,
          };
    return bpSnapshotSchema.parse({
      schemaVersion: 'mizar.bp.v2',
      revision: `${this.epoch}:${this.revision}`,
      projection: presentationProjection,
      state: this.state,
      revealedCount: this.count,
    });
  }
  showFinal(): void {
    this.get();
    if (!this.projection) return;
    this.state = 'shown';
    this.count = this.projection.steps.length;
    this.revision++;
  }
  /** The scene compositor has finished taking BP off air; no second exit animation. */
  finishSceneExit(): void {
    this.get();
    if (this.state === 'hidden') return;
    this.state = 'hidden';
    this.count = 0;
    this.revision++;
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
    this.startedAt = this.presentationNow();
    this.revision++;
    return this.get();
  }
}
export function registerBpRoutes(
  app: FastifyInstance,
  options: {
    readonly originPolicy: LocalWebOriginPolicy;
    readonly getProjection: () => CoreBpProjection | null;
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
