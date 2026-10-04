/** Offline demo export → production GSI adapter → Core → Program/Radar.
 * This is explicitly demo-derived, never labelled as a captured GSI session. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { format } from 'prettier';
import { replayRealProgram } from '../support/real-program-replay.js';
import { createSemanticEvents } from './generate-acceptance-replay.js';
if (!process.argv[2] || !process.argv[3])
  throw new Error('Usage: generate-nuke-reference.ts <demo-derived input> <output>');
const capturePath = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const demoSource: unknown = JSON.parse(
  await readFile(resolve(capturePath, 'demo-source.json'), 'utf8'),
);
if (
  typeof demoSource !== 'object' ||
  demoSource === null ||
  !('kind' in demoSource) ||
  demoSource.kind !== 'demo-derived' ||
  !('demoSha256' in demoSource) ||
  typeof demoSource.demoSha256 !== 'string' ||
  !/^[a-f0-9]{64}$/.test(demoSource.demoSha256)
)
  throw Error('Missing demo provenance');
const frames: Array<Parameters<typeof createSemanticEvents>[0][number]> = [];
const result = await replayRealProgram({
  capturePath,
  configureManifest: (m) => ({
    ...m,
    match: { ...m.match, stage: 'DEMO REPLAY', format: 'bo1' },
    maps: m.maps.filter((x) => x.mapName === 'de_nuke').map((x) => ({ ...x, mapOrder: 1 })),
  }),
  afterEvent: (event, { coordinator }) => {
    if (event.kind !== 'frame') return;
    frames.push({
      cursor: {
        captureIndex: event.captureIndex,
        sequence: event.sourceFrame.sequence,
        scheduledElapsedUs: event.scheduledElapsedUs,
      },
      program: coordinator.getPublisher('program').getCurrent()!,
      radar: coordinator.getPublisher('radar').getCurrent()!,
    });
  },
});
const capture = { ...result.capture.manifest, demoSource };
const events = createSemanticEvents(frames, {
  capturePath: 'demo-derived:nuke-lgcy-flc-round-1',
  sourceCaptureId: capture.captureId,
  sourceFramesSha256: demoSource.demoSha256,
});
const files: Record<string, string> = {
  'frames.jsonl': frames.map((f) => JSON.stringify(f)).join('\n') + '\n',
  'events.jsonl': events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  'match-context.json': JSON.stringify({ manifest: result.manifest }),
  'capture-manifest.json': JSON.stringify(capture),
};
for (const name of ['match-context.json', 'capture-manifest.json'])
  files[name] = await format(files[name]!, { parser: 'json', printWidth: 100, tabWidth: 2 });
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
files['manifest.json'] = JSON.stringify(
  {
    schemaVersion: 1,
    eventIndexSchemaVersion: 1,
    harnessVersion: 1,
    source: {
      id: 'nuke-demo-round-01',
      kind: 'demo-derived',
      sourceCaptureId: capture.captureId,
      sourceFramesSha256: demoSource.demoSha256,
    },
    firstSequence: 1,
    frameCount: frames.length,
    eventCount: events.length,
    framesSha256: hash(files['frames.jsonl']!),
    eventIndexSha256: hash(files['events.jsonl']!),
    matchContextSha256: hash(files['match-context.json']!),
    captureManifestSha256: hash(files['capture-manifest.json']!),
    coverage: [],
  },
  null,
  2,
);
files['manifest.json'] = await format(files['manifest.json'], {
  parser: 'json',
  printWidth: 100,
  tabWidth: 2,
});
await mkdir(output, { recursive: true });
for (const [name, bytes] of Object.entries(files)) await writeFile(resolve(output, name), bytes);
console.log(
  frames.length,
  frames.find((f) => f.program.payload.bomb?.state === 'defusing')?.program.payload.bomb,
);
