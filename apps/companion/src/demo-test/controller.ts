import { errorEvidence } from '../updates/diagnostics.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseMatchDocumentV1 } from '@mizar/protocol/context';
import { replaceDurableJson } from '../match-context/durable-json.js';
import type { MatchContextController } from '../match-context/controller.js';
import type { ProgramRuntime } from '../runtime/program-runtime.js';
import type { ProgramSceneController } from '../program-scenes/controller.js';
import type { registerProductionRoutes } from '../program-scenes/production.js';
import type { ObsStatus } from '../obs/adapter.js';

const markerSchema = z.object({
  version: z.literal('mizar.demo-test.v1'),
  requestId: z.uuid(),
  teamAName: z.string().min(1).max(128),
  teamBName: z.string().min(1).max(128),
});
type Marker = z.infer<typeof markerSchema>;
export type DemoTestView = {
  active: boolean;
  phase: 'idle' | 'starting' | 'playing' | 'stopping' | 'recovery';
  requestId: string | null;
  teamAName: string;
  teamBName: string;
  dataReady: boolean;
};

/** Read before runtime/projection composition: even an unreadable marker fails closed. */
export function readDemoTestRecovery(path: string | undefined): Marker | undefined {
  if (path === undefined) return undefined;
  try {
    return markerSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return {
      version: 'mizar.demo-test.v1',
      requestId: randomUUID(),
      teamAName: 'A',
      teamBName: 'B',
    };
  }
}

function trialDocument(marker: Marker) {
  const entrant = (side: 'a' | 'b', name: string) => ({
    entryId: `demo-test:${marker.requestId}:${side}`,
    name,
    logoUrl: null,
    rosterId: null,
    players: [],
  });
  return parseMatchDocumentV1({
    schemaVersion: 'mizar.match-document.v1',
    matchId: `demo-test:${marker.requestId}`,
    competition: null,
    status: 'scheduled',
    format: 'bo1',
    stage: 'demo-test',
    stageLabel: '试播',
    round: null,
    roundLabel: null,
    entryRound: null,
    matchLabel: null,
    stakesLabel: null,
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    scoreA: null,
    scoreB: null,
    isForfeit: false,
    entrants: { a: entrant('a', marker.teamAName), b: entrant('b', marker.teamBName) },
    mapPool: [],
    maps: [],
    veto: [],
    commentators: [],
  });
}

const commandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('begin'),
      requestId: z.uuid(),
      teamAName: z.string().trim().min(1).max(128).optional(),
      teamBName: z.string().trim().min(1).max(128).optional(),
    })
    .strict(),
  z
    .object({ action: z.enum(['playing', 'finish', 'complete', 'cancel']), requestId: z.uuid() })
    .strict(),
]);

export class DemoTestController {
  private marker: Marker | undefined;
  private phase: DemoTestView['phase'];
  private busy = false;
  private dropFormalGsi = false;
  private takePending = false;
  private taken = false;
  private nextTakeAttemptAt = 0;
  private restored = false;
  private waitingConfirmed = false;
  private completedRequestId: string | undefined;
  constructor(
    private readonly options: {
      canBegin?: () => boolean;
      dataReady: () => boolean;
      diagnostic: (stage: string, error: unknown) => void;
      markerPath: string | undefined;
      recovery: Marker | undefined;
      context: MatchContextController | null;
      runtime: ProgramRuntime;
      scenes: ProgramSceneController;
      production: ReturnType<typeof registerProductionRoutes>;
      obs: () => Promise<ObsStatus | undefined>;
      quarantineOutput: (value: boolean) => void | Promise<void>;
      refresh: () => void;
      restoreFormal: () => Promise<void>;
      hold: () => void;
    },
  ) {
    this.marker = options.recovery;
    this.phase = this.marker ? 'recovery' : 'idle';
    if (this.marker) options.production.setTrialPending(true);
  }
  get(): DemoTestView {
    return {
      active: this.marker !== undefined,
      phase: this.phase,
      requestId: this.marker?.requestId ?? null,
      teamAName: this.marker?.teamAName ?? 'A',
      teamBName: this.marker?.teamBName ?? 'B',
      dataReady: this.phase === 'playing' && this.options.dataReady(),
    };
  }
  canAcceptGsi(): boolean {
    return this.marker ? this.phase === 'playing' : !this.dropFormalGsi;
  }
  openFormalBoundary(): void {
    if (this.marker) throw new Error('demo_test_active');
    if (this.dropFormalGsi) {
      this.options.runtime.resetSession(false);
      this.options.refresh();
    }
    this.dropFormalGsi = false;
  }
  async recover(): Promise<void> {
    if (!this.marker) return;
    await this.options.quarantineOutput(true);
    await this.options.context?.beginTemporary();
    this.options.refresh();
  }
  async command(input: unknown): Promise<{ code: number; value: unknown }> {
    const operationId = randomUUID();
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success)
      return {
        code: 400,
        value: {
          error: 'demo_test_invalid_command',
          stage: 'validate_command',
          operationId,
          message: '试播操作参数无效。',
        },
      };
    const body = parsed.data;
    const conflict = (error: string, message: string, stage: string = body.action) => ({
      code: 409,
      value: { error, stage, operationId, requestId: body.requestId, message },
    });
    if (this.busy) return conflict('demo_test_busy', '试播操作正在进行，请稍后重试。');
    if (
      !this.marker &&
      this.completedRequestId === body.requestId &&
      ['complete', 'cancel', 'finish'].includes(body.action)
    )
      return { code: 200, value: this.get() };
    if (body.action !== 'begin' && this.marker?.requestId !== body.requestId)
      return conflict('demo_test_stale_state', '试播状态已变化，请刷新后重试。');
    if (
      body.action !== 'begin' &&
      !this.options.production.reserveTrialOperation(['complete', 'finish'].includes(body.action))
    )
      return conflict('demo_test_production_busy', '制作操作正在进行，请稍后重试。');
    this.busy = true;
    let stage = body.action as string;
    try {
      if (body.action === 'begin') {
        if (this.marker)
          return this.marker.requestId === body.requestId
            ? { code: 200, value: this.get() }
            : conflict('demo_test_already_active', '已有试播需要先结束。');
        if (!this.options.markerPath || !this.options.context)
          return conflict('demo_test_storage_unavailable', '本机试播存储尚未就绪。');
        if (this.options.canBegin?.() === false)
          return conflict('demo_test_context_busy', '比赛资料正在修改，请完成后再试播。');
        const obs = await this.options.obs();
        if (obs?.connection !== 'connected' || obs.streaming)
          return conflict('demo_test_obs_unavailable', '请连接 OBS 并停止推流后再开始试播。');
        const marker: Marker = {
          version: 'mizar.demo-test.v1',
          requestId: body.requestId,
          teamAName: body.teamAName ?? 'A',
          teamBName: body.teamBName ?? 'B',
        };
        const document = trialDocument(marker);
        if (this.options.canBegin?.() === false)
          return conflict('demo_test_context_busy', '比赛资料正在修改，请完成后再试播。');
        const prepared = await this.options.production.prepareTrial(async () => {
          stage = 'checkpoint_flush';
          await this.options.runtime.flushSeriesProgressCheckpoint();
          stage = 'recovery_marker_write';
          await replaceDurableJson(this.options.markerPath!, marker);
          this.marker = marker;
          this.phase = 'recovery';
          await this.options.quarantineOutput(true);
          stage = 'temporary_binding';
          this.options.runtime.resetSession(true);
          await this.options.context!.beginTemporary(document);
          this.options.hold();
          this.options.refresh();
          this.phase = 'starting';
          this.taken = false;
          this.nextTakeAttemptAt = 0;
          this.restored = false;
          this.waitingConfirmed = false;
        });
        if (!prepared)
          return conflict(
            'demo_test_preparation_required',
            '请先结束制作，完成升级或素材激活后再开始试播。',
          );
      } else if (body.action === 'playing') {
        if (this.phase === 'playing') return { code: 200, value: this.get() };
        if (this.phase !== 'starting')
          return conflict('demo_test_invalid_playing_phase', '当前试播不能开始播放。');
        this.options.production.setTrialPlaying();
        this.phase = 'playing';
        this.options.hold();
      } else if (body.action === 'finish') {
        await this.finish();
      } else {
        if (body.action === 'cancel' && this.phase !== 'starting')
          return conflict('demo_test_already_playing', '播放已开始，请先结束试播。');
        if (body.action === 'complete' && this.phase !== 'recovery' && !this.waitingConfirmed)
          return conflict('demo_test_recovery_required', '请先切换等待画面并退出受管 CS2。');
        // Host calls complete only after managed CS2 exit and video restoration.
        this.dropFormalGsi = true;
        if (!this.restored) {
          stage = 'formal_restore';
          this.options.runtime.resetSession(false);
          await this.options.restoreFormal();
          this.options.refresh();
          this.restored = true;
        }
        stage = 'recovery_marker_remove';
        try {
          await unlink(this.options.markerPath!);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        this.completedRequestId = this.marker!.requestId;
        this.options.context?.endTemporary();
        this.marker = undefined;
        this.phase = 'idle';
        this.options.production.setTrialPreparation();
        this.options.production.setTrialPending(false);
        await this.options.quarantineOutput(false);
        this.options.refresh();
      }
      return { code: 200, value: this.get() };
    } catch (error) {
      this.options.diagnostic(stage, {
        operationId,
        requestId: body.requestId,
        code: 'demo_test_operation_failed',
        error: errorEvidence(error),
      });
      if (!this.marker) this.options.production.setTrialPending(false);
      return conflict(
        'demo_test_operation_failed',
        '试播操作未完成，隔离状态已保留；请处理问题后重试。',
        stage,
      );
    } finally {
      this.busy = false;
      if (body.action !== 'begin') this.options.production.releaseTrialOperation();
    }
  }
  async finish(): Promise<void> {
    if (!this.marker || this.waitingConfirmed) return;
    // Stop ingress before OBS I/O; a failed switch stays quarantined and retryable.
    this.phase = 'stopping';
    const result = await this.options.scenes.select('waiting', this.options.scenes.get().revision);
    if (!result.ok) throw new Error(result.message);
    this.waitingConfirmed = true;
    this.options.production.setTrialPreparation();
    this.options.runtime.resetSession(true);
    this.options.hold();
    this.options.refresh();
  }
  observationAccepted(): void {
    if (
      this.phase !== 'playing' ||
      !this.options.dataReady() ||
      this.taken ||
      this.takePending ||
      performance.now() < this.nextTakeAttemptAt
    )
      return;
    this.takePending = true;
    void this.options.scenes
      .select('gameplay', this.options.scenes.get().revision)
      .then((result) => {
        if (this.phase !== 'playing') return;
        if (result.ok) this.taken = true;
        else this.takeFailed(new Error(result.message));
      })
      .catch((error: unknown) => this.takeFailed(error))
      .finally(() => {
        this.takePending = false;
      });
  }

  private takeFailed(error: unknown): void {
    // Each failed attempt has evidence; telemetry frames cannot retry or log
    // again until the cooldown ends. Manual scene controls remain available.
    this.nextTakeAttemptAt = performance.now() + 5000;
    this.options.diagnostic('initial_gameplay_take', {
      operationId: randomUUID(),
      requestId: this.marker?.requestId,
      code: 'demo_test_initial_take_failed',
      error: errorEvidence(error),
    });
  }
}

export function registerDemoTestRoutes(
  app: FastifyInstance,
  controller: DemoTestController,
  token: string | undefined,
): void {
  app.get('/local/v1/demo-test', (_request, reply) =>
    reply.header('cache-control', 'no-store').send(controller.get()),
  );
  app.post('/operator/runtime/demo-test', { bodyLimit: 1024 }, async (request, reply) => {
    const expected = Buffer.from(token ?? '');
    const supplied = Buffer.from(
      typeof request.headers['x-runtime-token'] === 'string'
        ? request.headers['x-runtime-token']
        : '',
    );
    if (
      request.headers.origin !== undefined ||
      expected.length === 0 ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return reply.code(403).send({ error: 'runtime-control-denied' });
    const result = await controller.command(request.body);
    return reply.code(result.code).send(result.value);
  });
}
