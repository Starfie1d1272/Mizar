import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { iterateCaptureFrames, verifyCapture, type CaptureFrameV1 } from '@mizar/testkit';

import { buildApp } from '../src/app.js';
import {
  createCaptureRecorder,
  type CaptureFileHandle,
} from '../src/telemetry/capture-recorder.js';
import { PRODUCTION_GSI_CONFIG } from '../src/telemetry/gsi-ingress.js';

const TOKEN = 'integration-gsi-token';
const RICH_OBSERVER_FIXTURE = resolve(
  process.cwd(),
  'fixtures/gsi/semantic/observer/rich-live-state',
);

interface BlockedFileWriter extends CaptureFileHandle {
  readonly firstWriteStarted: Promise<void>;
  releaseFirstWrite(): void;
}

async function postGsi(
  app: FastifyInstance,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number }> {
  return app.inject({
    method: 'POST',
    url: '/gsi',
    payload: { auth: { token: TOKEN }, ...payload },
  });
}

describe('Companion GSI capture integration', () => {
  let app: FastifyInstance | undefined;
  let blockedWriter: BlockedFileWriter | undefined;
  let root: string | undefined;

  afterEach(async () => {
    blockedWriter?.releaseFirstWrite();
    blockedWriter = undefined;
    if (app) {
      await app.close();
      app = undefined;
    }
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it('takes a real semantic fixture through Fastify, the recorder, and the adapter', async () => {
    root = await mkdtemp(join(tmpdir(), 'rivalhub-companion-semantic-ingress-'));
    const fixture = await verifyCapture(RICH_OBSERVER_FIXTURE);
    const fixtureFrames: CaptureFrameV1[] = [];
    for await (const frame of iterateCaptureFrames(fixture)) fixtureFrames.push(frame);
    expect(fixtureFrames).toHaveLength(1);
    const fixtureFrame = fixtureFrames[0];
    if (fixtureFrame === undefined) throw new Error('semantic fixture is empty');

    const recorder = await createCaptureRecorder({
      captureDir: root,
      captureId: 'semantic-ingress-capture',
      createdAt: '2026-09-14T06:00:00.000Z',
      broadcastCommit: 'integration-commit',
      gsiConfig: PRODUCTION_GSI_CONFIG,
      monotonicNow: () => 100,
      wallClockNow: () => '2026-09-14T06:00:00.000Z',
    });
    let observedSequence = -1;
    let observedMapName: string | undefined;
    let observedPlayerCount = 0;
    app = buildApp({
      gsiToken: TOKEN,
      recorder,
      clock: {
        now: () => ({
          receivedAt: '2026-09-14T06:00:00.100Z',
          receivedMonotonicMs: 100.1,
        }),
      },
      onObservation: (observation) => {
        observedSequence = observation.receive.sequence;
        observedMapName = observation.telemetry.map?.name;
        observedPlayerCount = observation.telemetry.allPlayers?.length ?? 0;
      },
    });

    const response = await postGsi(app, fixtureFrame.payload);
    expect(response.statusCode).toBe(204);
    expect(observedSequence).toBe(0);
    expect(observedMapName).toBe('de_ancient');
    expect(observedPlayerCount).toBe(10);

    await app.close();
    app = undefined;

    const verified = await verifyCapture(join(root, 'semantic-ingress-capture'));
    expect(verified.manifest).toMatchObject({
      complete: true,
      frameCount: 1,
      droppedFrames: 0,
      gsiConfig: PRODUCTION_GSI_CONFIG,
    });
    expect(await readFile(verified.framesPath, 'utf8')).not.toContain(TOKEN);
    await expect(access(join(root, 'semantic-ingress-capture.partial'))).rejects.toThrow();
  });
});
