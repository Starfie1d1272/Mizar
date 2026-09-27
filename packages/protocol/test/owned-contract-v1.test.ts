import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { parseMatchDocumentV1, parseScheduleWindowV1 } from '../src/context.js';
import { parseLiveSnapshotV1, parseReliableEventV1 } from '../src/output.js';

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(join(process.cwd(), 'packages/protocol/test/fixtures', name), 'utf8'),
  );
}

it('keeps Mizar input and output fixtures compatible and rejects private or unversioned fields', async () => {
  const document = parseMatchDocumentV1(await fixture('match-document-v1.json'));
  const window = parseScheduleWindowV1(await fixture('schedule-window-v1.json'));
  const snapshot = parseLiveSnapshotV1(await fixture('live-snapshot-v1.json'));
  const event = parseReliableEventV1(await fixture('reliable-event-v1.json'));
  expect(document.veto).toEqual([]);
  expect(window.from).toBeNull();
  expect(snapshot.radar).toBeNull();
  expect(event.kind).toBe('map_ended');
  expect(() =>
    parseMatchDocumentV1({ ...document, schemaVersion: 'rivalhub.broadcast-manifest.v1' }),
  ).toThrow();
  expect(() => parseLiveSnapshotV1({ ...snapshot, assist: { future: true } })).toThrow();
  expect(() => parseReliableEventV1({ ...event, rawGsi: {} })).toThrow();
  expect(() =>
    parseReliableEventV1({ ...event, payload: { ...event.payload, reason: 'x'.repeat(200) } }),
  ).toThrow();
});
