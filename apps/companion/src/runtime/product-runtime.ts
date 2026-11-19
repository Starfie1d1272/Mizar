import type { CaptureRecorder } from '../telemetry/capture-recorder.js';
import type { CstvSourceManagers } from '../telemetry/cstv-source-manager.js';
import { timingSafeEqual } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { replaceDurableJson } from '../match-context/durable-json.js';
import type { createProduction } from '../program-scenes/production.js';

export interface ProductRuntime {
  readonly appVersion?: string;
  readonly artifactSha256: string;
  readonly gitSha: string;
  readonly instanceId: string;
  readonly controlToken: string;
  readonly stop: () => void;
}

export function registerProductStop(
  app: FastifyInstance,
  product: Pick<ProductRuntime, 'controlToken' | 'stop'>,
  operations: {
    readTrial: () => { active: boolean; localRestored?: true };
    shutdown: ReturnType<typeof createProduction>['shutdown'];
    beforeStop: () => Promise<string | null> | undefined;
  },
): void {
  app.post('/operator/runtime/stop', async (request, reply) => {
    const token = request.headers['x-runtime-token'];
    const expected = Buffer.from(product.controlToken);
    const supplied = Buffer.from(typeof token === 'string' ? token : '');
    // Only the local supervisor holds this per-launch capability. Browsers cannot stop it.
    if (
      request.headers.origin !== undefined ||
      supplied.length !== expected.length ||
      expected.length === 0 ||
      !timingSafeEqual(supplied, expected)
    ) {
      return reply.code(403).send({ error: 'runtime-control-denied' });
    }
    // Host must finish the owned game and configuration transaction while
    // this service is still available to keep the formal boundary isolated.
    const trial = operations.readTrial();
    if (trial.active && !trial.localRestored)
      return reply.code(409).send({
        message: '请先在桌面结束 Demo 试播并恢复游戏配置，再停止服务。',
      });
    // The capability-verified CLI stop uses the same transaction as both UIs.
    const shutdown = await operations.shutdown();
    const updateBlocked = await operations.beforeStop();
    if (updateBlocked) {
      await shutdown.cancel();
      return reply.code(409).send({ message: updateBlocked });
    }
    if (!shutdown.result.ok) {
      request.log.warn(
        { action: 'shutdown', reason: shutdown.result.failure },
        '制作收尾待恢复，继续关闭本机服务',
      );
    }
    setImmediate(product.stop);
    return reply.code(202).send({ status: 'stopping' });
  });
}

export async function writeRuntimeFlushReceipt(
  product?: Pick<ProductRuntime, 'instanceId' | 'artifactSha256'>,
): Promise<void> {
  if (product && process.env.MIZAR_PRODUCT_INSTANCE) {
    const stateRoot = process.env.MIZAR_STATE_ROOT;
    const { instanceId, artifactSha256 } = product;
    if (
      !stateRoot ||
      !isAbsolute(stateRoot) ||
      !/^[a-f0-9-]{36}$/.test(instanceId) ||
      process.env.MIZAR_PRODUCT_INSTANCE !== instanceId
    )
      throw new Error('本地收尾实例身份无效');
    await replaceDurableJson(join(stateRoot, 'data', `runtime-flush-${instanceId}.json`), {
      instanceId,
      artifactSha256,
      pid: process.pid,
    });
  }
}

export function registerRuntimeHealth(
  app: FastifyInstance,
  options: {
    currentRecorder: () => CaptureRecorder;
    cstvSources: Pick<CstvSourceManagers, 'program' | 'lookahead'>;
    runtimeDegraded: () => boolean;
    product: ProductRuntime | undefined;
  },
): void {
  app.get('/health', () => {
    const recorderHealth = options.currentRecorder().getHealth();
    const recorderDegraded =
      recorderHealth.state === 'degraded' || recorderHealth.state === 'failed';
    const cstvHealth = {
      program: options.cstvSources.program.getHealth(),
      lookahead: options.cstvSources.lookahead.getHealth(),
    };
    const cstvDegraded = [cstvHealth.program, cstvHealth.lookahead].some(
      (health) => health.state === 'reconnecting' || health.state === 'failed',
    );
    return {
      status: options.runtimeDegraded() || recorderDegraded || cstvDegraded ? 'degraded' : 'ok',
      recorder: recorderHealth,
      cstv: cstvHealth,
      ...(options.product === undefined
        ? {}
        : {
            product: {
              repository: 'Starfie1d1272/Mizar',
              appVersion: options.product.appVersion,
              artifactSha256: options.product.artifactSha256,
              gitSha: options.product.gitSha,
              instanceId: options.product.instanceId,
              mode: 'product',
            },
          }),
    };
  });
}
