import { programSnapshotSchema, type ProgramSnapshot } from '@mizar/protocol/program';
import { radarSnapshotSchema, type RadarSnapshot } from '@mizar/protocol/radar';
import type { ReplayVideoSource } from './ReplayVideoBackground';
import {
  createReplaySession,
  type ReplaySession,
  type ReplaySessionEvent,
  type ReplaySessionFrame,
  type ReplaySessionScheduler,
} from '@mizar/replay';

export type ReplaySourceId =
  | 'epl-inferno-video'
  | 'epl-inferno-opening'
  | 'epl-inferno-final-round'
  | 'ancient-round-03'
  | 'ancient-round-11-defuse'
  | 'nuke-demo-round-01';

export interface AcceptanceReplayFrame extends ReplaySessionFrame {
  readonly program: ProgramSnapshot;
  readonly radar: RadarSnapshot;
}

interface CaptureManifest {
  readonly kind?: 'recorded-projections';
  readonly captureId?: string;
  readonly demoSource?: { readonly kind: string; readonly demoSha256: string };
  readonly frameCount: number;
  readonly framesSha256?: string;
  readonly provenance?: {
    readonly sanitizerVersion?: number;
    readonly sourceCaptureId?: string;
    readonly sourceFramesSha256?: string;
    readonly sourceFrameSelection?: {
      readonly firstSequence: number;
      readonly lastSequence: number;
    };
  };
}

interface ReplayArtifactManifest {
  readonly schemaVersion: number;
  readonly eventIndexSchemaVersion: number;
  readonly harnessVersion: number;
  readonly source: {
    readonly id: ReplaySourceId;
    readonly kind?: 'demo-derived' | 'recorded-projections';
    readonly capturePath: string;
    readonly sourceCaptureId: string;
    readonly sourceFramesSha256: string;
    readonly sanitizerVersion: number;
  };
  readonly frameCount: number;
  readonly framesSha256: string;
  readonly eventCount: number;
  readonly eventIndexSha256: string;
  readonly matchContextSha256: string;
  readonly captureManifestSha256: string;
  readonly video?: {
    readonly file: string;
    readonly sha256: string;
    readonly timelineStartUs: number;
  };
  readonly coverage: readonly {
    readonly kind: string;
    readonly status:
      'observed' | 'not-observed-in-selected-window' | 'unavailable-from-current-source';
  }[];
}

interface SourceFiles {
  readonly basePath: string;
  readonly title?: string;
}

const sourceFiles: Record<ReplaySourceId, SourceFiles> = {
  'epl-inferno-video': {
    basePath: '/fixtures/epl-inferno-video/replay',
    title: 'EPL · Inferno · 实景回放',
  },
  'epl-inferno-opening': {
    basePath: '/fixtures/epl-inferno-opening/replay',
    title: 'EPL · Inferno · 开局',
  },
  'epl-inferno-final-round': {
    basePath: '/fixtures/epl-inferno-final-round/replay',
    title: 'EPL · Inferno · 决胜回合',
  },
  'nuke-demo-round-01': { basePath: '/fixtures/nuke-demo-round-01/replay' },
  'ancient-round-03': {
    basePath: '/fixtures/ancient-round-03/replay',
  },
  'ancient-round-11-defuse': {
    basePath: '/fixtures/ancient-round-11-defuse/replay',
  },
};

const replayScheduler: ReplaySessionScheduler = {
  nowMs: () => window.performance.now(),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return globalThis.crypto.subtle
    .digest('SHA-256', bytes)
    .then((digest) =>
      [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join(''),
    );
}

function parseJsonLines<T>(value: string, sourceName: string): T[] {
  return value
    .trimEnd()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        throw new Error(`Replay fixture line ${index + 1} is invalid: ${sourceName}`);
      }
    });
}

function cursorKey(snapshot: ProgramSnapshot | RadarSnapshot): string {
  const cursor = snapshot.cursor;
  return [
    cursor.producerInstanceId,
    cursor.liveSessionId,
    cursor.runtimeSeq,
    cursor.programSourceGeneration,
    cursor.programReceiveSequence,
    cursor.mapEpoch,
  ].join(':');
}

export interface LoadedReplayFixture {
  readonly video?: ReplayVideoSource;
  readonly id: ReplaySourceId;
  readonly title: string;
  readonly session: ReplaySession<AcceptanceReplayFrame>;
  readonly manifest: ReplayArtifactManifest;
  readonly events: readonly ReplaySessionEvent[];
  dispose(): void;
}

export async function loadReplayFixture(id: ReplaySourceId): Promise<LoadedReplayFixture> {
  const signal = AbortSignal.timeout(30_000);
  const paths = sourceFiles[id];
  if (paths === undefined) throw new RangeError(`Unknown replay source: ${id}`);
  const [
    manifestResponse,
    framesResponse,
    eventsResponse,
    contextResponse,
    captureManifestResponse,
  ] = await Promise.all([
    fetch(`${paths.basePath}/manifest.json`, { cache: 'no-store', signal }),
    fetch(`${paths.basePath}/frames.jsonl`, { cache: 'no-store', signal }),
    fetch(`${paths.basePath}/events.jsonl`, { cache: 'no-store', signal }),
    fetch(`${paths.basePath}/match-context.json`, { cache: 'no-store', signal }),
    fetch(`${paths.basePath}/capture-manifest.json`, { cache: 'no-store', signal }),
  ]);
  for (const response of [
    manifestResponse,
    framesResponse,
    eventsResponse,
    contextResponse,
    captureManifestResponse,
  ]) {
    if (!response.ok) throw new Error(`Replay fixture could not be loaded (${response.status})`);
  }
  const [manifestBytes, framesBytes, eventsBytes, contextBytes, captureManifestBytes] =
    await Promise.all([
      manifestResponse.arrayBuffer(),
      framesResponse.arrayBuffer(),
      eventsResponse.arrayBuffer(),
      contextResponse.arrayBuffer(),
      captureManifestResponse.arrayBuffer(),
    ]);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ReplayArtifactManifest;
  const [framesHash, eventsHash, contextHash, captureManifestHash] = await Promise.all([
    sha256Hex(framesBytes),
    sha256Hex(eventsBytes),
    sha256Hex(contextBytes),
    sha256Hex(captureManifestBytes),
  ]);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.eventIndexSchemaVersion !== 1 ||
    manifest.harnessVersion !== 1
  ) {
    throw new Error('Replay fixture schema version is not supported');
  }
  if (
    manifest.source.id !== id ||
    framesHash !== manifest.framesSha256 ||
    eventsHash !== manifest.eventIndexSha256 ||
    contextHash !== manifest.matchContextSha256 ||
    captureManifestHash !== manifest.captureManifestSha256
  ) {
    throw new Error('Replay fixture provenance or artifact hash mismatch');
  }

  const captureManifest = JSON.parse(
    new TextDecoder().decode(captureManifestBytes),
  ) as CaptureManifest;
  if (
    captureManifest.framesSha256 === undefined ||
    !/^[0-9a-f]{64}$/.test(captureManifest.framesSha256)
  ) {
    throw new Error('Replay source capture hash mismatch');
  }
  const demoDerived = manifest.source.kind === 'demo-derived';
  const recordedProjections = manifest.source.kind === 'recorded-projections';
  if (recordedProjections) {
    if (
      captureManifest.kind !== 'recorded-projections' ||
      captureManifest.framesSha256 !== framesHash ||
      captureManifest.provenance?.sourceCaptureId !== manifest.source.sourceCaptureId ||
      captureManifest.provenance?.sourceFramesSha256 !== manifest.source.sourceFramesSha256 ||
      captureManifest.provenance?.sanitizerVersion !== 1
    ) {
      throw new Error('Recorded projection provenance mismatch');
    }
  } else if (demoDerived) {
    if (
      import.meta.env.VITE_VISUAL_FIXTURES !== '1' ||
      !import.meta.env.DEV ||
      captureManifest.demoSource?.kind !== 'demo-derived' ||
      captureManifest.demoSource.demoSha256 !== manifest.source.sourceFramesSha256 ||
      captureManifest.captureId !== manifest.source.sourceCaptureId
    ) {
      throw new Error(
        'Demo reference provenance mismatch or unavailable outside visual development',
      );
    }
  } else if (
    captureManifest.provenance?.sourceCaptureId !== manifest.source.sourceCaptureId ||
    captureManifest.provenance?.sourceFramesSha256 !== manifest.source.sourceFramesSha256 ||
    captureManifest.provenance?.sanitizerVersion !== 2
  ) {
    throw new Error('Replay source capture provenance mismatch');
  }

  if (captureManifest.frameCount !== manifest.frameCount) {
    throw new Error('Replay source and projection frame counts differ');
  }
  const frames = parseJsonLines<AcceptanceReplayFrame>(
    new TextDecoder().decode(framesBytes),
    `${id}/timeline`,
  ).map((frame) => ({
    ...frame,
    program: programSnapshotSchema.parse(frame.program),
    radar: radarSnapshotSchema.parse(frame.radar),
  }));
  const events = parseJsonLines<ReplaySessionEvent>(
    new TextDecoder().decode(eventsBytes),
    `${id}/events`,
  );
  JSON.parse(new TextDecoder().decode(contextBytes)) as unknown;
  if (
    frames.length === 0 ||
    frames.length !== manifest.frameCount ||
    events.length !== manifest.eventCount
  ) {
    throw new Error('Replay artifact count differs from its manifest');
  }
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!;
    if (
      frame.cursor.captureIndex !== index ||
      !Number.isFinite(frame.cursor.scheduledElapsedUs) ||
      (index > 0 &&
        frame.cursor.scheduledElapsedUs < frames[index - 1]!.cursor.scheduledElapsedUs) ||
      (!recordedProjections &&
        frame.cursor.sequence !==
          (demoDerived
            ? 1
            : (captureManifest.provenance?.sourceFrameSelection?.firstSequence ?? -1)) +
            index) ||
      frame.cursor.sequence !== frame.program.cursor.programReceiveSequence ||
      frame.cursor.sequence !== frame.radar.cursor.programReceiveSequence ||
      cursorKey(frame.program) !== cursorKey(frame.radar)
    ) {
      throw new Error(`Replay Program/Radar atomic cursor mismatch at frame ${index}`);
    }
  }

  let video: ReplayVideoSource | undefined;
  let videoObjectUrl: string | undefined;
  if (manifest.video !== undefined) {
    const media = manifest.video;
    if (
      !recordedProjections ||
      !/^[a-z0-9-]+\.mp4$/.test(media.file) ||
      !Number.isFinite(media.timelineStartUs)
    )
      throw new Error('Invalid replay video binding');
    const response = await fetch(`${paths.basePath}/${media.file}`, { signal });
    if (!response.ok) throw new Error('Replay video could not be loaded');
    const bytes = await response.arrayBuffer();
    if ((await sha256Hex(bytes)) !== media.sha256) throw new Error('Replay video hash mismatch');
    videoObjectUrl = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
    video = { url: videoObjectUrl, timelineStartUs: media.timelineStartUs };
  }

  const session = createReplaySession<AcceptanceReplayFrame>(
    {
      frames,
      events,
      rebuild: async (targetCaptureIndex, signal) => {
        const expected = frames[targetCaptureIndex]!;
        // These are recorded production projections, not raw input prefix reconstructions.
        if (recordedProjections) return expected;
        // Bundled EPL projections are generated through the production replay adapter
        // and validated above. Seeking selects that saved frame in offline builds too.
        if (id === 'epl-inferno-opening' || id === 'epl-inferno-final-round') return expected;
        if (import.meta.env.DEV && import.meta.env.VITE_VISUAL_FIXTURES === '1') return expected;
        const response = await fetch('/__local/replay-prefix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          signal,
          body: JSON.stringify({ sourceId: id, targetSequence: expected.cursor.sequence }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            readonly error?: unknown;
          } | null;
          const detail =
            typeof body?.error === 'string' && body.error.trim().length > 0
              ? `: ${body.error}`
              : '';
          throw new Error(`Replay prefix rebuild failed (${response.status})${detail}`);
        }
        const rebuilt = (await response.json()) as {
          readonly targetSequence: number;
          readonly program: ProgramSnapshot;
          readonly radar: RadarSnapshot;
        };
        const snapshots = {
          program: programSnapshotSchema.parse(rebuilt.program),
          radar: radarSnapshotSchema.parse(rebuilt.radar),
        };
        if (
          rebuilt.targetSequence !== expected.cursor.sequence ||
          canonicalJson(snapshots) !==
            canonicalJson({ program: expected.program, radar: expected.radar })
        ) {
          throw new Error(
            `Replay prefix output drift at source sequence ${expected.cursor.sequence}`,
          );
        }
        return { ...expected, ...snapshots };
      },
    },
    replayScheduler,
  );

  return {
    ...(video === undefined ? {} : { video }),
    id,
    title:
      sourceFiles[id].title ??
      (id === 'ancient-round-03'
        ? 'Ancient · 第 3 回合'
        : id === 'nuke-demo-round-01'
          ? 'Nuke · 第 1 回合'
          : 'Ancient · 第 11 回合拆弹'),
    session,
    manifest,
    events,
    dispose: () => {
      session.dispose();
      if (videoObjectUrl !== undefined) URL.revokeObjectURL(videoObjectUrl);
    },
  };
}
