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

describe('Issue 76 production replay acceptance', { timeout: 30_000 }, () => {
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
});
