import { mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { programSnapshotSchema } from '@mizar/protocol/program';
import { iterateCaptureFrames, replayCapture } from '@mizar/testkit';
import {
  generateRealProgramFixtures,
  serializeRealProgramFixtures,
  REAL_PROGRAM_MATRIX,
  REAL_PROGRAM_ARTIFACT_PATH,
  runGenerator,
} from './generate-real-program-fixtures.js';
import { replayRealProgram, REPOSITORY_ROOT } from '../support/real-program-replay.js';

describe('real-derived Program fixture generation', { timeout: 30_000 }, () => {
  it('replays every prefix in order with exact provenance and byte-identical output', async () => {
    const first = await generateRealProgramFixtures();
    const bytes = await serializeRealProgramFixtures(first);
    expect(await serializeRealProgramFixtures(await generateRealProgramFixtures())).toBe(bytes);
    expect(await readFile(REAL_PROGRAM_ARTIFACT_PATH, 'utf8')).toBe(bytes);
    expect(Object.keys(first.fixtures)).toEqual(REAL_PROGRAM_MATRIX.map(([id]) => id));
    expect(bytes).not.toMatch(/auth|token|password|secret|generatedAt|\/Users\/|[A-Z]:\\/i);
    expect(bytes).not.toContain(REPOSITORY_ROOT);
    for (const [id, path, targetSequence] of REAL_PROGRAM_MATRIX) {
      const result = await replayRealProgram({
        capturePath: resolve(REPOSITORY_ROOT, 'fixtures/gsi/semantic', path),
        targetSequence,
      });
      const provenance = result.capture.manifest.provenance;
      if (
        provenance === undefined ||
        !('sourceCaptureId' in provenance) ||
        provenance.sourceFrameSelection.kind !== 'sequence-range'
      )
        throw new Error('Missing provenance');
      expect(first.fixtures[id]?.provenance).toEqual({
        kind: 'real-derived',
        capturePath: `fixtures/gsi/semantic/${path}`,
        targetSequence,
        sourceCaptureId: provenance.sourceCaptureId,
        sourceFramesSha256: provenance.sourceFramesSha256,
        firstSequence: provenance.sourceFrameSelection.firstSequence,
        lastSequence: provenance.sourceFrameSelection.lastSequence,
        sanitizerVersion: provenance.sanitizerVersion,
      });
      const expectedSequences: number[] = [];
      for await (const frame of iterateCaptureFrames(result.capture))
        if (frame.sequence <= targetSequence) expectedSequences.push(frame.sequence);
      expect(result.acceptedSequences).toEqual(expectedSequences);
      expect(result.snapshot).toEqual(first.fixtures[id]?.snapshot);
      expect(programSnapshotSchema.safeParse(result.snapshot).success).toBe(true);
      expect(
        result.manifest.maps.every(
          (map) => map.scoreA === null && map.scoreB === null && map.completedAt === null,
        ),
      ).toBe(true);
    }
  });

  it('fails on missing targets, unknown identity namespaces, corrupted capture and artifact drift without writing', async () => {
    const capturePath = resolve(REPOSITORY_ROOT, 'fixtures/gsi/semantic/observer/rich-live-state');
    await expect(replayRealProgram({ capturePath, targetSequence: 728 })).rejects.toThrow(
      'Target sequence not found',
    );
    const temporary = await mkdtemp(resolve(tmpdir(), 'real-program-fixtures-'));
    try {
      const captureCopy = resolve(temporary, 'capture');
      await cp(capturePath, captureCopy, { recursive: true });
      const manifestPath = resolve(captureCopy, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest.framesSha256 = '0'.repeat(64);
      await writeFile(manifestPath, JSON.stringify(manifest));
      await expect(replayRealProgram({ capturePath: captureCopy })).rejects.toThrow();
      const artifactPath = resolve(temporary, 'artifact.json');
      const artifact = await generateRealProgramFixtures();
      artifact.fixtures['real-live-rich']!.snapshot.payload.map.score.ct = 999;
      const drift = await serializeRealProgramFixtures(artifact);
      await writeFile(artifactPath, drift);
      await expect(runGenerator('--check', artifactPath)).rejects.toThrow('real-live-rich');
      expect(await readFile(artifactPath, 'utf8')).toBe(drift);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('preserves production equipment, identity, objective transitions and terminal semantics', async () => {
    const { fixtures } = await generateRealProgramFixtures();
    const payload = (id: string) => fixtures[id]!.snapshot.payload;
    const live = payload('real-live-rich');
    expect(live.status.identity).toBe('matched');
    expect(live.players).toHaveLength(10);
    expect(live.players.every((player) => player.identityEvidence === 'canonical')).toBe(true);
    expect(
      live.players.find((player) => player.sourcePlayerId === live.bomb?.sourcePlayerId)?.side,
    ).toBe('T');
    const { capture } = await replayRealProgram({
      capturePath: resolve(REPOSITORY_ROOT, 'fixtures/gsi/semantic/observer/rich-live-state'),
      targetSequence: 727,
    });
    for await (const event of replayCapture(capture, { mode: { kind: 'step' } })) {
      if (event.kind !== 'frame' || !event.result.ok) throw new Error('Unexpected source');
      const observed = event.result.observation;
      for (const player of live.players) {
        const source = observed.telemetry.allPlayers?.find(
          (p) => p.sourcePlayerId === player.sourcePlayerId,
        );
        expect(source).toBeDefined();
        for (const key of [
          'health',
          'armor',
          'hasHelmet',
          'hasDefuser',
          'money',
          'equipValue',
        ] as const)
          expect(player.state?.[key]).toBe(source?.state?.[key] ?? null);
        expect(player.weapons.map((weapon) => weapon.name)).toEqual(
          source?.weapons?.map((weapon) => weapon.name),
        );
      }
    }
    expect(payload('real-warmup').status.identity).toBe('matched');
    const warmupFrame = JSON.parse(
      (
        await readFile(
          resolve(REPOSITORY_ROOT, 'fixtures/gsi/semantic/warmup/observer/frames.jsonl'),
          'utf8',
        )
      ).split(/\r?\n/)[0]!,
    ) as {
      readonly payload: {
        readonly map: {
          readonly team_ct: { readonly name: string };
          readonly team_t: { readonly name: string };
        };
        readonly allplayers: Record<string, { readonly name: string }>;
      };
    };
    const warmup = payload('real-warmup');
    expect(warmup.teams.ct.name).toBe(warmupFrame.payload.map.team_ct.name);
    expect(warmup.teams.t.name).toBe(warmupFrame.payload.map.team_t.name);
    expect(warmup.teams.ct.entryId).toBe(warmup.series?.entrants.a.entryId);
    expect(warmup.teams.t.entryId).toBe(warmup.series?.entrants.b.entryId);
    for (const player of warmup.players) {
      expect(player.displayName).toBe(warmupFrame.payload.allplayers[player.sourcePlayerId]?.name);
    }
    expect(payload('real-planting').bomb).toMatchObject({
      state: 'planting',
      action: {
        kind: 'plant',
        sourcePlayerId: '76561198294381090',
        remainingSeconds: 2.943,
        durationSeconds: 2.943,
      },
    });
    expect(payload('real-planted').bomb).toMatchObject({
      state: 'planted',
      explosion: { remainingSeconds: 39.836, durationSeconds: 39.836 },
    });
    expect(payload('real-defusing').bomb).toMatchObject({
      state: 'defusing',
      action: {
        kind: 'defuse',
        sourcePlayerId: '76561198164970560',
        remainingSeconds: 5.034,
        hasDefuseKit: true,
      },
    });
    expect(payload('real-defusing').bomb?.explosion?.remainingSeconds).toBeCloseTo(28.455814, 6);
    // These fixed excerpts start after player sides switched; map labels catch up later.
    // Never manufacture a side transition between their prescribed targets.
    expect(payload('real-halftime-before').teams).toEqual(payload('real-halftime-after').teams);
    expect(payload('real-halftime-after').teams.t.entryId).toBe(live.teams.ct.entryId);
    expect(payload('real-halftime-after').teams.ct.entryId).toBe(live.teams.t.entryId);
    expect(payload('real-overtime-side-before').teams).toEqual(
      payload('real-overtime-side-after').teams,
    );
    expect(payload('real-gameover').map.phase).toBe('gameover');
    expect(payload('real-gameover').series?.maps[0]).toMatchObject({
      status: 'completed',
      finalScore: { a: 14, b: 16 },
    });
  });
});
