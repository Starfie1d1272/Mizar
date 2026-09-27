import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { programSnapshotSchema, type ProgramSnapshot } from '@mizar/protocol/program';
import { radarSnapshotSchema, type RadarSnapshot } from '@mizar/protocol/radar';
import { createReplaySession, type ReplaySessionScheduler } from '@mizar/testkit';
import type { ReplaySessionEvent, ReplaySessionFrame } from '@mizar/testkit';
import { describe, expect, it } from 'vitest';

import { REPOSITORY_ROOT, replayRealProgram } from '../support/real-program-replay.js';

interface ReplayFrame extends ReplaySessionFrame {
  readonly program: ProgramSnapshot;
  readonly radar: RadarSnapshot;
}

interface ReplaySemanticEvent extends ReplaySessionEvent {
  readonly sourcePlayerId: string | null;
  readonly provenance: {
    readonly sourceCaptureId: string;
    readonly sourceFramesSha256: string;
  };
}

const primaryReplayDir = resolve(
  REPOSITORY_ROOT,
  'apps/web/public/fixtures/ancient-round-03/replay',
);
const primaryCapturePath = resolve(REPOSITORY_ROOT, 'fixtures/gsi/acceptance/ancient-round-03');

function parseLines<T>(value: string): T[] {
  return value
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readPrimaryArtifact() {
  const [manifestBytes, framesBytes, eventsBytes] = await Promise.all([
    readFile(resolve(primaryReplayDir, 'manifest.json'), 'utf8'),
    readFile(resolve(primaryReplayDir, 'frames.jsonl'), 'utf8'),
    readFile(resolve(primaryReplayDir, 'events.jsonl'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestBytes) as {
    readonly frameCount: number;
    readonly eventCount: number;
    readonly framesSha256: string;
    readonly eventIndexSha256: string;
    readonly source: {
      readonly sourceCaptureId: string;
      readonly sourceFramesSha256: string;
      readonly sanitizerVersion: number;
      readonly sourceFrameSelection: {
        readonly firstSequence: number;
        readonly lastSequence: number;
      };
    };
    readonly coverage: readonly { readonly kind: string; readonly status: string }[];
  };
  const frames = parseLines<ReplayFrame>(framesBytes).map((frame) => ({
    ...frame,
    program: programSnapshotSchema.parse(frame.program),
    radar: radarSnapshotSchema.parse(frame.radar),
  }));
  const events = parseLines<ReplaySemanticEvent>(eventsBytes);
  return { manifest, framesBytes, eventsBytes, frames, events };
}

describe('Issue 76 production replay acceptance', () => {
  it('materializes the fixed real Ancient round with authentic identity and provenance', async () => {
    const artifact = await readPrimaryArtifact();
    const sourceCapture = JSON.parse(
      await readFile(resolve(primaryCapturePath, 'manifest.json'), 'utf8'),
    ) as {
      readonly frameCount: number;
      readonly provenance: {
        readonly sourceFrameSelection: {
          readonly firstSequence: number;
          readonly lastSequence: number;
        };
        readonly sanitizerVersion: number;
      };
    };
    const first = artifact.frames[0]!;
    const program = first.program;

    expect(sourceCapture.frameCount).toBe(628);
    expect(sourceCapture.provenance.sanitizerVersion).toBe(2);
    expect(sourceCapture.provenance.sourceFrameSelection).toEqual({
      firstSequence: 587,
      lastSequence: 1214,
      kind: 'sequence-range',
    });
    expect(artifact.manifest.source).toMatchObject({
      sourceCaptureId: '20260914T060149Z-4cda66b7-recovered-match',
      sourceFramesSha256: '7a2dfed10f28903de6a94e782ca3f0955593fe2f653e7e831e05305d8e99347a',
      sanitizerVersion: 2,
      sourceFrameSelection: { firstSequence: 587, lastSequence: 1214 },
    });
    expect(artifact.manifest.frameCount).toBe(628);
    expect(artifact.manifest.eventCount).toBe(artifact.events.length);
    expect(sha256(artifact.framesBytes)).toBe(artifact.manifest.framesSha256);
    expect(sha256(artifact.eventsBytes)).toBe(artifact.manifest.eventIndexSha256);
    expect(artifact.frames.at(-1)?.cursor.sequence).toBe(1214);
    expect(program.payload.teams.ct.name).toBe('FURIA');
    expect(program.payload.teams.t.name).toBe('G2.Esports');
    expect(program.payload.players).toHaveLength(10);
    expect(program.payload.players.map((player) => player.displayName)).toContain('FalleN');
    expect(program.payload.players.every((player) => /^\d{17}$/.test(player.sourcePlayerId))).toBe(
      true,
    );
    expect(JSON.stringify(program)).not.toMatch(/fixture-player-|Fixture Player|Fixture Team/);
    expect(
      artifact.events.every(
        (event) => event.provenance.sourceCaptureId === artifact.manifest.source.sourceCaptureId,
      ),
    ).toBe(true);
    expect(
      artifact.events.every(
        (event) =>
          event.provenance.sourceFramesSha256 === artifact.manifest.source.sourceFramesSha256,
      ),
    ).toBe(true);
    expect(artifact.manifest.coverage).toContainEqual({
      kind: 'he-detonation',
      status: 'unavailable-from-current-source',
    });
    expect(artifact.manifest.coverage).toContainEqual({ kind: 'smoke-start', status: 'observed' });
    expect(artifact.manifest.coverage).toContainEqual({ kind: 'inferno-end', status: 'observed' });
    for (const frame of artifact.frames) {
      const replayFrame = frame as {
        readonly program: { readonly cursor: { readonly programReceiveSequence: number } };
        readonly radar: { readonly cursor: { readonly programReceiveSequence: number } };
      };
      expect(replayFrame.program.cursor.programReceiveSequence).toBe(frame.cursor.sequence);
      expect(replayFrame.radar.cursor.programReceiveSequence).toBe(frame.cursor.sequence);
    }
  });

  it('rebuilds seek/restart through fresh production prefixes and preserves dead-player damage', async () => {
    const artifact = await readPrimaryArtifact();
    const death = artifact.events.find((event) => {
      if (event.kind !== 'death' || event.sourcePlayerId === null) return false;
      const frame = artifact.frames[event.captureIndex]!;
      const program = frame.program;
      const player = program.payload.players.find(
        (candidate) => candidate.sourcePlayerId === event.sourcePlayerId,
      );
      return (
        player?.currentRoundDamage !== null &&
        player?.currentRoundDamage !== undefined &&
        player.currentRoundDamage > 0
      );
    });
    expect(death).toBeDefined();
    const selectedDeath = death!;
    const scheduler: ReplaySessionScheduler = {
      nowMs: () => 0,
      setTimeout: () => {
        throw new Error('Playback is not part of this seek-only replay assertion');
      },
      clearTimeout: () => undefined,
    };
    const session = createReplaySession(
      {
        frames: artifact.frames,
        events: artifact.events,
        rebuild: async (targetCaptureIndex) => {
          const expected = artifact.frames[targetCaptureIndex]!;
          const rebuilt = await replayRealProgram({
            capturePath: primaryCapturePath,
            targetSequence: expected.cursor.sequence,
          });
          return {
            ...expected,
            program: rebuilt.snapshot,
            radar: rebuilt.radarSnapshot,
          };
        },
      },
      scheduler,
    );

    await session.seekEvent(selectedDeath.id);
    const deadFrame = session.getSnapshot().current!;
    const deadPlayer = deadFrame.program.payload.players.find(
      (player) => player.sourcePlayerId === selectedDeath.sourcePlayerId,
    )!;
    expect(deadFrame.cursor.sequence).toBe(selectedDeath.sequence);
    expect(deadPlayer.lifeState).toBe('dead');
    expect(deadPlayer.currentRoundDamage).toBeGreaterThan(0);
    expect(
      session.getSnapshot().current &&
        deadFrame.program.cursor.programReceiveSequence ===
          deadFrame.radar.cursor.programReceiveSequence,
    ).toBe(true);

    const firstReplay = JSON.stringify(deadFrame);
    await session.restart();
    expect(session.getSnapshot().current?.cursor.sequence).toBe(587);
    await session.seekEvent(selectedDeath.id);
    expect(JSON.stringify(session.getSnapshot().current)).toBe(firstReplay);
    session.dispose();
  });

  it('observes one completed round in the Core accumulator without patching its projections', async () => {
    const { snapshot, runtimeSnapshot } = await replayRealProgram({
      capturePath: primaryCapturePath,
      targetSequence: 1214,
    });
    const coreStats = runtimeSnapshot.current.playerStats;
    expect(coreStats.countedCompletedRounds).toBeGreaterThanOrEqual(1);
    const player = snapshot.payload.players.find((candidate) => candidate.completedAdr !== null);
    expect(player).toBeDefined();
    const damage = coreStats.completedDamageBySteam64[player!.sourcePlayerId];
    expect(damage).toBeDefined();
    expect(player!.completedAdr).toBeCloseTo(damage! / coreStats.countedCompletedRounds);
    expect(player!.liveAdr).not.toBeNull();
  });

  it('keeps the supplemental selector on the fixed defuse window', async () => {
    const manifest = JSON.parse(
      await readFile(
        resolve(
          REPOSITORY_ROOT,
          'apps/web/public/fixtures/ancient-round-11-defuse/replay/manifest.json',
        ),
        'utf8',
      ),
    ) as {
      readonly frameCount: number;
      readonly firstSequence: number;
      readonly lastSequence: number;
      readonly source: { readonly humanRound: number; readonly role: string };
    };
    const events = parseLines<ReplaySessionEvent>(
      await readFile(
        resolve(
          REPOSITORY_ROOT,
          'apps/web/public/fixtures/ancient-round-11-defuse/replay/events.jsonl',
        ),
        'utf8',
      ),
    );
    expect(manifest).toMatchObject({
      frameCount: 23,
      firstSequence: 5522,
      lastSequence: 5544,
      source: { humanRound: 11, role: 'supplemental' },
    });
    expect(events.some((event) => event.kind === 'bomb-state')).toBe(true);
  });
});
