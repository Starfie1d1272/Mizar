import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format } from 'prettier';

import { programSnapshotSchema, type ProgramSnapshot } from '@mizar/protocol/program';
import { radarSnapshotSchema, type RadarSnapshot } from '@mizar/protocol/radar';
import { toMatchContext } from '@mizar/rivalhub';
import { canonicalJsonLine } from '@mizar/testkit';

import { replayRealProgram, REPOSITORY_ROOT } from '../support/real-program-replay.js';

const SOURCES = [
  {
    id: 'ancient-round-03',
    capturePath: 'fixtures/gsi/acceptance/ancient-round-03',
    outputPath: 'apps/web/public/fixtures/ancient-round-03/replay',
    mapName: 'de_ancient',
    humanRound: 3,
    role: 'primary',
  },
  {
    id: 'ancient-round-11-defuse',
    capturePath: 'fixtures/gsi/acceptance/ancient-round-11-defuse',
    outputPath: 'apps/web/public/fixtures/ancient-round-11-defuse/replay',
    mapName: 'de_ancient',
    humanRound: 11,
    role: 'supplemental',
  },
] as const;

interface AtomicReplayFrame {
  readonly cursor: {
    readonly captureIndex: number;
    readonly sequence: number;
    readonly scheduledElapsedUs: number;
  };
  readonly program: ProgramSnapshot;
  readonly radar: RadarSnapshot;
}

interface SemanticEvent {
  readonly id: string;
  readonly kind: string;
  readonly captureIndex: number;
  readonly sequence: number;
  readonly scheduledElapsedUs: number;
  readonly label: string;
  readonly sourcePlayerId: string | null;
  readonly detail: Readonly<Record<string, string | number | null>>;
  readonly provenance: {
    readonly capturePath: string;
    readonly sourceCaptureId: string;
    readonly sourceFramesSha256: string;
    readonly sourceSequence: number;
  };
}

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function displayName(snapshot: ProgramSnapshot, sourcePlayerId: string): string {
  return (
    snapshot.payload.players.find((player) => player.sourcePlayerId === sourcePlayerId)
      ?.displayName ?? sourcePlayerId
  );
}

function createSemanticEvents(
  frames: readonly AtomicReplayFrame[],
  provenance: {
    readonly capturePath: string;
    readonly sourceCaptureId: string;
    readonly sourceFramesSha256: string;
  },
): SemanticEvent[] {
  const events: SemanticEvent[] = [];
  const eventCounters = new Map<string, number>();
  const emit = (
    frame: AtomicReplayFrame,
    kind: string,
    label: string,
    sourcePlayerId: string | null = null,
    detail: Readonly<Record<string, string | number | null>> = {},
  ) => {
    const actor = sourcePlayerId ?? 'match';
    const eventKey = `${frame.cursor.sequence}:${kind}:${actor}`;
    const eventNumber = eventCounters.get(eventKey) ?? 0;
    eventCounters.set(eventKey, eventNumber + 1);
    events.push({
      id: `${kind}:${frame.cursor.sequence}:${actor}:${eventNumber}`,
      kind,
      captureIndex: frame.cursor.captureIndex,
      sequence: frame.cursor.sequence,
      scheduledElapsedUs: frame.cursor.scheduledElapsedUs,
      label,
      sourcePlayerId,
      detail,
      provenance: { ...provenance, sourceSequence: frame.cursor.sequence },
    });
  };

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!;
    const previous = frames[index - 1];
    if (previous === undefined) {
      const phase = frame.program.payload.round?.phase;
      if (phase !== undefined && phase !== null) {
        emit(frame, 'round-phase', `回合阶段 · ${phase}`, null, { to: phase });
      }
      continue;
    }

    const phase = frame.program.payload.round?.phase;
    const previousPhase = previous.program.payload.round?.phase;
    if (phase !== null && phase !== undefined && phase !== previousPhase) {
      emit(frame, 'round-phase', `回合阶段 · ${phase}`, null, {
        from: previousPhase ?? null,
        to: phase,
      });
    }

    const roundNumber = frame.program.payload.map.roundNumber;
    const previousRoundNumber = previous.program.payload.map.roundNumber;
    if (
      roundNumber !== null &&
      previousRoundNumber !== null &&
      roundNumber !== previousRoundNumber
    ) {
      emit(frame, 'round-boundary', `进入第 ${roundNumber + 1} 回合`, null, {
        from: previousRoundNumber,
        to: roundNumber,
      });
    }

    const bomb = frame.program.payload.bomb?.state;
    const previousBomb = previous.program.payload.bomb?.state;
    if (bomb !== null && bomb !== undefined && bomb !== previousBomb) {
      emit(
        frame,
        'bomb-state',
        `C4 · ${bomb}`,
        frame.program.payload.bomb?.sourcePlayerId ?? null,
        {
          from: previousBomb ?? null,
          to: bomb,
        },
      );
    }

    const previousPlayers = new Map(
      previous.program.payload.players.map((player) => [player.sourcePlayerId, player]),
    );
    for (const player of frame.program.payload.players) {
      const oldPlayer = previousPlayers.get(player.sourcePlayerId);
      if (oldPlayer === undefined) continue;
      const oldHealth = oldPlayer.state?.health;
      const health = player.state?.health;
      if (
        oldHealth !== null &&
        oldHealth !== undefined &&
        health !== null &&
        health !== undefined &&
        health < oldHealth
      ) {
        emit(
          frame,
          'health-decrease',
          `${player.displayName ?? player.sourcePlayerId} · 生命值下降`,
          player.sourcePlayerId,
          {
            from: oldHealth,
            to: health,
          },
        );
      }
      if (oldPlayer.lifeState !== 'dead' && player.lifeState === 'dead') {
        emit(
          frame,
          'death',
          `${player.displayName ?? player.sourcePlayerId} · 阵亡`,
          player.sourcePlayerId,
        );
      }
      if (
        oldPlayer.completedAdr !== player.completedAdr &&
        player.completedAdr !== null &&
        player.completedAdr !== undefined
      ) {
        emit(
          frame,
          'round-accumulator-finalize',
          `${player.displayName ?? player.sourcePlayerId} · 回合统计完成`,
          player.sourcePlayerId,
          {
            completedAdr: player.completedAdr,
          },
        );
      }
      const oldWeapon = oldPlayer.weapons.find((weapon) => weapon.state === 'active');
      const weapon = player.weapons.find((candidate) => candidate.state === 'active');
      if (
        oldWeapon !== undefined &&
        weapon !== undefined &&
        oldWeapon.sourceWeaponId === weapon.sourceWeaponId &&
        oldWeapon.ammoClip !== null &&
        oldWeapon.ammoClip !== undefined &&
        weapon.ammoClip !== null &&
        weapon.ammoClip !== undefined &&
        weapon.ammoClip < oldWeapon.ammoClip &&
        (oldWeapon.ammoReserve === null ||
          weapon.ammoReserve === null ||
          weapon.ammoReserve <= oldWeapon.ammoReserve)
      ) {
        emit(
          frame,
          'weapon-ammo-decrease',
          `${player.displayName ?? player.sourcePlayerId} · 弹匣弹药减少`,
          player.sourcePlayerId,
          {
            weapon: weapon.name,
            ammoFrom: oldWeapon.ammoClip,
            ammoTo: weapon.ammoClip,
          },
        );
      }
    }

    const previousRadarPlayers = new Map(
      previous.radar.payload.players.map((player) => [player.sourcePlayerId, player]),
    );
    for (const player of frame.radar.payload.players) {
      const oldPlayer = previousRadarPlayers.get(player.sourcePlayerId);
      if (oldPlayer === undefined) continue;
      const oldFlash = oldPlayer.flashAmount;
      const flash = player.flashAmount;
      if (oldFlash !== null && flash !== null && flash > oldFlash) {
        emit(
          frame,
          'flash-rise',
          `${displayName(frame.program, player.sourcePlayerId)} · 闪光增强`,
          player.sourcePlayerId,
          {
            from: oldFlash,
            to: flash,
          },
        );
      } else if (oldFlash !== null && flash !== null && flash < oldFlash) {
        emit(
          frame,
          'flash-fall',
          `${displayName(frame.program, player.sourcePlayerId)} · 闪光减弱`,
          player.sourcePlayerId,
          {
            from: oldFlash,
            to: flash,
          },
        );
      }
    }

    const previousGrenades = new Map(
      previous.radar.payload.grenades.map((grenade) => [grenade.sourceEntityId, grenade]),
    );
    const grenades = new Map(
      frame.radar.payload.grenades.map((grenade) => [grenade.sourceEntityId, grenade]),
    );
    const previousSmoke = new Set(
      [...previousGrenades.values()]
        .filter(
          (grenade) =>
            grenade.kind === 'smoke' &&
            grenade.effectTimeSeconds !== null &&
            grenade.effectTimeSeconds < 20,
        )
        .map((grenade) => grenade.sourceEntityId),
    );
    const activeSmoke = new Set(
      [...grenades.values()]
        .filter(
          (grenade) =>
            grenade.kind === 'smoke' &&
            grenade.effectTimeSeconds !== null &&
            grenade.effectTimeSeconds < 20,
        )
        .map((grenade) => grenade.sourceEntityId),
    );
    for (const id of activeSmoke) {
      if (!previousSmoke.has(id)) {
        emit(frame, 'smoke-start', '烟雾效果开始', grenades.get(id)?.ownerSourceId ?? null, {
          sourceEntityId: id,
        });
      }
    }
    for (const id of previousSmoke) {
      if (!activeSmoke.has(id)) {
        emit(frame, 'smoke-end', '烟雾效果结束', previousGrenades.get(id)?.ownerSourceId ?? null, {
          sourceEntityId: id,
        });
      }
    }
    const previousInferno = new Set(
      [...previousGrenades.values()]
        .filter((grenade) => grenade.kind === 'inferno' && grenade.flames.length > 0)
        .map((grenade) => grenade.sourceEntityId),
    );
    const activeInferno = new Set(
      [...grenades.values()]
        .filter((grenade) => grenade.kind === 'inferno' && grenade.flames.length > 0)
        .map((grenade) => grenade.sourceEntityId),
    );
    for (const id of activeInferno) {
      if (!previousInferno.has(id)) {
        emit(frame, 'inferno-start', '燃烧区域开始', grenades.get(id)?.ownerSourceId ?? null, {
          sourceEntityId: id,
        });
      }
    }
    for (const id of previousInferno) {
      if (!activeInferno.has(id)) {
        emit(
          frame,
          'inferno-end',
          '燃烧区域结束',
          previousGrenades.get(id)?.ownerSourceId ?? null,
          { sourceEntityId: id },
        );
      }
    }
    for (const [id, grenade] of grenades) {
      if (!previousGrenades.has(id)) {
        emit(
          frame,
          'grenade-airborne',
          `投掷物出现 · ${grenade.kind ?? '未知'}`,
          grenade.ownerSourceId,
          { kind: grenade.kind },
        );
      }
    }
    for (const [id, grenade] of previousGrenades) {
      if (!grenades.has(id)) {
        emit(
          frame,
          'grenade-terminal',
          `投掷物结束 · ${grenade.kind ?? '未知'}`,
          grenade.ownerSourceId,
          { kind: grenade.kind },
        );
      }
    }

    const observedPlayer = frame.radar.payload.observedPlayerSourceId;
    const previousObservedPlayer = previous.radar.payload.observedPlayerSourceId;
    if (observedPlayer !== previousObservedPlayer && observedPlayer !== null) {
      emit(
        frame,
        'observer-target-switch',
        `观察目标 · ${displayName(frame.program, observedPlayer)}`,
        observedPlayer,
        {
          from: previousObservedPlayer,
          to: observedPlayer,
        },
      );
    }
  }
  return events;
}

function coverageFor(events: readonly SemanticEvent[]) {
  const kinds = new Set(events.map((event) => event.kind));
  return [
    {
      kind: 'round-phase',
      status: kinds.has('round-phase') ? 'observed' : 'unavailable-from-current-source',
    },
    {
      kind: 'weapon-ammo-decrease',
      status: kinds.has('weapon-ammo-decrease') ? 'observed' : 'not-observed-in-selected-window',
    },
    {
      kind: 'health-decrease',
      status: kinds.has('health-decrease') ? 'observed' : 'unavailable-from-current-source',
    },
    { kind: 'death', status: kinds.has('death') ? 'observed' : 'not-observed-in-selected-window' },
    {
      kind: 'flash-rise-fall',
      status:
        kinds.has('flash-rise') || kinds.has('flash-fall')
          ? 'observed'
          : 'not-observed-in-selected-window',
    },
    {
      kind: 'grenade-airborne-terminal',
      status:
        kinds.has('grenade-airborne') || kinds.has('grenade-terminal')
          ? 'observed'
          : 'not-observed-in-selected-window',
    },
    {
      kind: 'smoke-start',
      status: kinds.has('smoke-start') ? 'observed' : 'not-observed-in-selected-window',
    },
    {
      kind: 'smoke-end',
      status: kinds.has('smoke-end') ? 'observed' : 'not-observed-in-selected-window',
    },
    {
      kind: 'inferno-start',
      status: kinds.has('inferno-start') ? 'observed' : 'not-observed-in-selected-window',
    },
    {
      kind: 'inferno-end',
      status: kinds.has('inferno-end') ? 'observed' : 'not-observed-in-selected-window',
    },
    { kind: 'he-detonation', status: 'unavailable-from-current-source' },
    {
      kind: 'bomb-state',
      status: kinds.has('bomb-state') ? 'observed' : 'unavailable-from-current-source',
    },
    {
      kind: 'observer-target-switch',
      status: kinds.has('observer-target-switch') ? 'observed' : 'not-observed-in-selected-window',
    },
    {
      kind: 'round-boundary',
      status: kinds.has('round-boundary') ? 'observed' : 'not-observed-in-selected-window',
    },
    {
      kind: 'round-accumulator-finalize',
      status: kinds.has('round-accumulator-finalize')
        ? 'observed'
        : 'not-observed-in-selected-window',
    },
  ] as const;
}

async function generateSource(source: (typeof SOURCES)[number]) {
  const capture = await import('@mizar/testkit').then(({ verifyCapture }) =>
    verifyCapture(resolve(REPOSITORY_ROOT, source.capturePath)),
  );
  const provenance = capture.manifest.provenance;
  if (
    provenance === undefined ||
    !('fixtureKind' in provenance) ||
    provenance.fixtureKind !== 'sanitized-real-capture' ||
    provenance.sanitizerVersion !== 2 ||
    provenance.sourceFrameSelection.kind !== 'sequence-range'
  )
    throw new Error(`Expected sanitizer-v2 real sequence capture: ${source.capturePath}`);

  const frames: AtomicReplayFrame[] = [];
  const replay = await replayRealProgram({
    capturePath: resolve(REPOSITORY_ROOT, source.capturePath),
    afterEvent: (event, { coordinator }) => {
      if (event.kind !== 'frame') return;
      const program = programSnapshotSchema.parse(coordinator.getPublisher('program').getCurrent());
      const radar = radarSnapshotSchema.parse(coordinator.getPublisher('radar').getCurrent());
      frames.push({
        cursor: {
          captureIndex: event.captureIndex,
          sequence: event.sourceFrame.sequence,
          scheduledElapsedUs: event.scheduledElapsedUs,
        },
        program,
        radar,
      });
    },
  });
  if (frames.length !== capture.manifest.frameCount) {
    throw new Error(`Replay frame count mismatch for ${source.id}: ${frames.length}`);
  }
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!;
    if (
      frame.cursor.captureIndex !== index ||
      frame.program.cursor.programReceiveSequence !== frame.cursor.sequence ||
      frame.radar.cursor.programReceiveSequence !== frame.cursor.sequence
    ) {
      throw new Error(`Atomic replay cursor mismatch at ${source.id}:${frame.cursor.sequence}`);
    }
  }

  const events = createSemanticEvents(frames, {
    capturePath: source.capturePath,
    sourceCaptureId: provenance.sourceCaptureId,
    sourceFramesSha256: provenance.sourceFramesSha256,
  });
  const framesBytes = `${frames.map((frame) => canonicalJsonLine(frame).trimEnd()).join('\n')}\n`;
  const eventsBytes = `${events.map((event) => canonicalJsonLine(event).trimEnd()).join('\n')}\n`;
  const matchContextBytes = await format(
    JSON.stringify({ manifest: replay.manifest, context: toMatchContext(replay.manifest) }),
    { parser: 'json', printWidth: 100, tabWidth: 2 },
  );
  const captureManifestBytes = await format(JSON.stringify(capture.manifest), {
    parser: 'json',
    printWidth: 100,
    tabWidth: 2,
  });
  const manifest = {
    schemaVersion: 1,
    eventIndexSchemaVersion: 1,
    harnessVersion: 1,
    source: {
      id: source.id,
      role: source.role,
      capturePath: source.capturePath,
      sourceCaptureId: provenance.sourceCaptureId,
      sourceFramesSha256: provenance.sourceFramesSha256,
      sanitizerVersion: provenance.sanitizerVersion,
      sourceFrameSelection: provenance.sourceFrameSelection,
      mapName: source.mapName,
      humanRound: source.humanRound,
    },
    frameCount: frames.length,
    firstSequence: frames[0]!.cursor.sequence,
    lastSequence: frames.at(-1)!.cursor.sequence,
    framesSha256: sha256(framesBytes),
    eventCount: events.length,
    eventIndexSha256: sha256(eventsBytes),
    matchContextSha256: sha256(matchContextBytes),
    captureManifestSha256: sha256(captureManifestBytes),
    coverage: coverageFor(events),
  };
  return { source, manifest, framesBytes, eventsBytes, matchContextBytes, captureManifestBytes };
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temp, contents, { encoding: 'utf8', flag: 'wx' });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function runGenerator(mode: '--write' | '--check') {
  for (const source of SOURCES) {
    const generated = await generateSource(source);
    const base = resolve(REPOSITORY_ROOT, source.outputPath);
    const manifestBytes = await format(JSON.stringify(generated.manifest), {
      parser: 'json',
      printWidth: 100,
      tabWidth: 2,
    });
    const files = [
      ['manifest.json', manifestBytes],
      ['frames.jsonl', generated.framesBytes],
      ['events.jsonl', generated.eventsBytes],
      ['match-context.json', generated.matchContextBytes],
      ['capture-manifest.json', generated.captureManifestBytes],
    ] as const;
    for (const [name, bytes] of files) {
      const path = resolve(base, name);
      if (mode === '--write') await writeAtomic(path, bytes);
      else {
        const existing = await readFile(path, 'utf8');
        if (existing !== bytes) throw new Error(`Replay artifact drift: ${source.id}/${name}`);
      }
    }
    console.log(
      `${mode}: ${source.id} · ${generated.manifest.frameCount} frames · ${generated.manifest.eventCount} events`,
    );
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const mode = process.argv[2];
  if (mode !== '--write' && mode !== '--check') throw new Error('Usage: --write | --check');
  await runGenerator(mode);
}
