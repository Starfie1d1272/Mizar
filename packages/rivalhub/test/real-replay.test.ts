import { resolve } from 'node:path';

import {
  createIdentityResolver,
  identityEvidenceFromObservation,
  type IdentityResolver,
} from '@mizar/core/identity';
import type { TelemetryObservation } from '@mizar/core/telemetry';
import { verifyCapture, replayCapture } from '@mizar/testkit';
import { describe, expect, it } from 'vitest';

import { contextFromCapture } from './helpers/identity-evidence.js';

const semanticRoot = resolve(process.cwd(), 'fixtures/gsi/semantic');
const fullMatchCaptureDir = process.env.RIVALHUB_FULL_MATCH_CAPTURE_DIR;
const FULL_MATCH_CAPTURE_ID = '20260914T060149Z-4cda66b7-recovered-match';
const FULL_MATCH_FRAME_COUNT = 16_382;
const FULL_MATCH_FRAMES_SHA256 = '7a2dfed10f28903de6a94e782ca3f0955593fe2f653e7e831e05305d8e99347a';

async function observationAt(path: string, sequence: number): Promise<TelemetryObservation> {
  const capture = await verifyCapture(path);
  for await (const event of replayCapture(capture, { mode: { kind: 'step' } })) {
    if (event.kind !== 'frame' || event.sourceFrame.sequence !== sequence) continue;
    if (!event.result.ok) throw new Error(`真实 GSI replay 在 seq=${sequence} 适配失败`);
    return event.result.observation;
  }
  throw new Error(`真实 GSI replay 缺少 seq=${sequence}`);
}

function resolveObservation(
  resolver: IdentityResolver,
  observation: TelemetryObservation,
  sourceGeneration: number,
  mapEpoch: number,
) {
  return resolver.resolve(identityEvidenceFromObservation(observation, sourceGeneration, mapEpoch));
}

describe('现有真实 GSI evidence 的 Manifest identity replay acceptance', () => {
  it('用 capture 中的真实 Steam64 与来源阵容核验十名 semantic-capture 选手', async () => {
    const capturePath = resolve(semanticRoot, 'observer/rich-live-state');
    const context = await contextFromCapture(capturePath);
    const resolver = createIdentityResolver(context);
    const observation = await observationAt(capturePath, 727);
    const resolution = resolveObservation(resolver, observation, 1, 1);

    expect(resolution.state).toBe('matched');
    expect(resolution.players).toHaveLength(10);
    expect(resolution.unresolved).toHaveLength(0);
    expect(resolution.issues.map((issue) => issue.code)).not.toContain('unexpected_human_steam64');
  });

  it('保持 entry identity 稳定，并在 halftime/OT 换边时更新动态 side', async () => {
    const context = await contextFromCapture(resolve(semanticRoot, 'match/halftime-side-switch'));
    const resolver = createIdentityResolver(context);
    const halftimeBefore = await observationAt(
      resolve(semanticRoot, 'match/halftime-side-switch'),
      6145,
    );
    const halftimeAfter = await observationAt(
      resolve(semanticRoot, 'match/halftime-side-switch'),
      6147,
    );
    const first = resolveObservation(resolver, halftimeBefore, 1, 1);
    const second = resolveObservation(resolver, halftimeAfter, 1, 1);
    const overtimeBefore = await observationAt(
      resolve(semanticRoot, 'match/overtime-side-switch'),
      14461,
    );
    const overtimeAfter = await observationAt(
      resolve(semanticRoot, 'match/overtime-side-switch'),
      14463,
    );
    const third = resolveObservation(resolver, overtimeBefore, 1, 1);
    const fourth = resolveObservation(resolver, overtimeAfter, 1, 1);

    expect(first.state).toBe('matched');
    expect(second.state).toBe('matched');
    expect(first.sideMapping).toEqual({ a: 'T', b: 'CT' });
    expect(second.sideMapping).toEqual({ a: 'T', b: 'CT' });
    expect(third.state).toBe('matched');
    expect(fourth.state).toBe('matched');
    expect(third.sideMapping).toEqual({ a: 'CT', b: 'T' });
    expect(fourth.sideMapping).toEqual({ a: 'CT', b: 'T' });
    expect(fourth.players.map((player) => player.canonicalPlayerId)).toEqual(
      first.players.map((player) => player.canonicalPlayerId),
    );
  });

  it('保留 regulation-to-overtime semantic slice 的多回合无 false mismatch 证据', async () => {
    const context = await contextFromCapture(resolve(semanticRoot, 'observer/rich-live-state'));
    const resolver = createIdentityResolver(context);
    const capture = await verifyCapture(resolve(semanticRoot, 'match/regulation-to-overtime'));
    const states: string[] = [];
    let lastResolution = resolver.getResolution();
    for await (const event of replayCapture(capture, { mode: { kind: 'step' } })) {
      if (event.kind !== 'frame' || !event.result.ok) continue;
      lastResolution = resolveObservation(resolver, event.result.observation, 1, 1);
      states.push(lastResolution.state);
    }

    expect(states.length).toBeGreaterThan(1);
    expect(states).not.toContain('mismatch');
    expect(lastResolution.players).toHaveLength(10);
  });

  it('在 source-generation/map-epoch 边界后强制重新建立 identity proof', async () => {
    const context = await contextFromCapture(resolve(semanticRoot, 'observer/rich-live-state'));
    const resolver = createIdentityResolver(context);
    const observation = await observationAt(resolve(semanticRoot, 'observer/rich-live-state'), 727);
    const matched = resolveObservation(resolver, observation, 1, 1);
    const sourceReset = resolver.resolve({
      sourceGeneration: 2,
      mapEpoch: 1,
      allPlayersCoverage: 'absent',
      mapName: 'de_ancient',
      mapPhase: 'live',
    });
    const rebuilt = resolveObservation(resolver, observation, 2, 1);
    const mapReset = resolver.resolve({
      sourceGeneration: 2,
      mapEpoch: 2,
      allPlayersCoverage: 'absent',
      mapName: 'de_ancient',
      mapPhase: 'live',
    });

    expect(matched.state).toBe('matched');
    expect(sourceReset.state).toBe('resolving');
    expect(sourceReset.players).toHaveLength(0);
    expect(rebuilt.state).toBe('matched');
    expect(mapReset.state).toBe('resolving');
    expect(mapReset.players).toHaveLength(0);
  });

  it.skipIf(fullMatchCaptureDir === undefined)(
    '使用现有完整 Ancient capture 完成整场 identity replay/soak acceptance',
    async () => {
      if (fullMatchCaptureDir === undefined) throw new Error('缺少完整 capture 路径');
      const capture = await verifyCapture(fullMatchCaptureDir);
      expect(capture.manifest.captureId).toBe(FULL_MATCH_CAPTURE_ID);
      expect(capture.manifest.frameCount).toBe(FULL_MATCH_FRAME_COUNT);
      expect(capture.manifest.droppedFrames).toBe(0);
      expect(capture.computedFramesSha256).toBe(FULL_MATCH_FRAMES_SHA256);

      const context = await contextFromCapture(fullMatchCaptureDir);
      const resolver = createIdentityResolver(context);
      let sourceGeneration = 0;
      const mapEpoch = 1;
      let lastObservation: TelemetryObservation | undefined;
      let firstMatchedIds: readonly string[] | undefined;
      let lastMatchedIds: readonly string[] | undefined;
      const sideMappings = new Set<string>();
      const states: string[] = [];

      for await (const event of replayCapture(capture, {
        mode: { kind: 'step' },
        faultPlan: { sourceGenerationBoundary: [{ beforeCaptureIndex: 0 }] },
      })) {
        if (event.kind === 'source-generation-boundary') {
          sourceGeneration = event.generation;
          continue;
        }
        if (!event.result.ok)
          throw new Error(`完整 capture 在 seq=${event.sourceFrame.sequence} 适配失败`);
        lastObservation = event.result.observation;
        const resolution = resolver.resolve(
          identityEvidenceFromObservation(lastObservation, sourceGeneration, mapEpoch),
        );
        states.push(resolution.state);
        if (resolution.state !== 'matched') continue;
        const ids = resolution.players.map((player) => player.canonicalPlayerId);
        firstMatchedIds ??= ids;
        lastMatchedIds = ids;
        sideMappings.add(`${resolution.sideMapping.a}/${resolution.sideMapping.b}`);
      }

      expect(states).toContain('matched');
      expect(states).not.toContain('mismatch');
      expect(firstMatchedIds).toBeDefined();
      expect(lastMatchedIds).toEqual(firstMatchedIds);
      expect(sideMappings).toEqual(new Set(['CT/T', 'T/CT']));
      expect(lastObservation).toBeDefined();

      const reset = resolver.resolve({
        sourceGeneration: sourceGeneration + 1,
        mapEpoch: mapEpoch + 1,
        allPlayersCoverage: 'absent',
        mapName: 'de_ancient',
        mapPhase: 'gameover',
      });
      expect(reset.state).toBe('resolving');
      expect(reset.players).toHaveLength(0);

      const rebuilt = resolver.resolve(
        identityEvidenceFromObservation(lastObservation!, sourceGeneration + 1, mapEpoch + 1),
      );
      expect(rebuilt.state).toBe('matched');
      expect(rebuilt.players).toHaveLength(10);
      expect(rebuilt.players.map((player) => player.canonicalPlayerId)).toEqual(firstMatchedIds);
    },
  );
});
