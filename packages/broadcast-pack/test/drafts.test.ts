import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  parseManifest,
  preparePackDrafts,
  readPackArchive,
  writePackArchive,
} from '../src/index.js';

it('imports multiple independent draft copies from a verified archive', async () => {
  const resource = { id: 'local:web-hud:test', version: '1', digest: 'b'.repeat(64) };
  const hud = {
    module: 'hud',
    schemaVersion: 1,
    name: 'HUD',
    value: {
      renderer: {
        kind: 'web-hud',
        resource: { package: 'hud' },
        profile: 'lhm-cs2-v1',
        variant: null,
      },
      panelValues: {},
      panelAssets: {},
    },
  };
  const pulse = { kind: 'builtin', id: 'pulse', apiVersion: 1 };
  const program = {
    module: 'program',
    schemaVersion: 1,
    name: 'Program',
    value: {
      scenes: Object.fromEntries(
        ['waiting', 'matchup', 'bp', 'halftime', 'map_result', 'intermap', 'match_result'].map(
          (k) => [k, pulse],
        ),
      ),
      tokens: {},
      assets: {},
    },
  };
  const preset = {
    name: 'Live',
    bindings: [
      { kind: 'hud', mode: 'use', entryId: 'hud' },
      { kind: 'program', mode: 'use', entryId: 'program' },
      { kind: 'music', mode: 'off' },
      { kind: 'camera', mode: 'off' },
    ],
  };
  const data = new Map([
    ['modules/hud.json', Buffer.from(JSON.stringify(hud))],
    ['modules/program.json', Buffer.from(JSON.stringify(program))],
    ['presets/live.json', Buffer.from(JSON.stringify(preset))],
  ]);
  const files = [...data].map(([path, bytes], i) => ({
    id: `file${i}`,
    path,
    mediaType: 'application/json',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }));
  const manifestBytes = Buffer.from(
    JSON.stringify({
      format: 'mizar.pack',
      formatVersion: 1,
      packageId: randomUUID(),
      version: '1.0.0',
      name: 'Pack',
      author: '',
      modules: [
        { entryId: 'hud', module: 'hud', schemaVersion: 1, fileId: 'file0', required: true },
        {
          entryId: 'program',
          module: 'program',
          schemaVersion: 1,
          fileId: 'file1',
          required: true,
        },
      ],
      presets: [
        { entryId: 'live', schemaVersion: 1, fileId: 'file2' },
        { entryId: 'clean', schemaVersion: 1, fileId: 'file2' },
      ],
      dependencies: [{ alias: 'hud', resource, delivery: { kind: 'external' } }],
      requirements: [],
      files,
    }),
  );
  const source = {
    id: 'local:mizar-pack:test',
    version: '1.0.0',
    digest: parseManifest(manifestBytes).digest,
  };
  const archive = await readPackArchive(writePackArchive(manifestBytes, data));
  const result = preparePackDrafts({
    manifestBytes: archive.manifestBytes,
    files: archive.files,
    source,
    refs: {
      asset: () => {
        throw new Error('unexpected');
      },
      resource: () => resource,
      tool: () => {
        throw new Error('unexpected');
      },
    },
    supports: () => true,
  });
  expect(result.presets).toHaveLength(2);
  expect(result.modules).toHaveLength(4);
  expect(result.moduleEntries.hud).toHaveLength(2);
  expect(result.presets[0]!.bindings[0]).not.toEqual(result.presets[1]!.bindings[0]);
  expect(() =>
    preparePackDrafts({
      manifestBytes: archive.manifestBytes,
      files: archive.files,
      source: { ...source, digest: '0'.repeat(64) },
      refs: {
        asset: () => {
          throw new Error();
        },
        resource: () => resource,
        tool: () => {
          throw new Error();
        },
      },
      supports: () => true,
    }),
  ).toThrow('package_identity_mismatch');
});
