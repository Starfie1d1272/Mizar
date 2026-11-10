import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseModuleRecord, type ModuleRecord } from '@mizar/broadcast-config';
import { exportModule, importModule, type ModuleTemplate } from '../src/index.js';

const resource = { id: 'local:music:track', version: '1', digest: 'a'.repeat(64) };
const asset = { resource, fileId: 'track.wav' };
const tool = {
  kind: 'upstream' as const,
  release: {
    repository: 'Co1Swet/MulNX_CS2' as const,
    releaseId: 1,
    assetId: 2,
    tag: 'v1',
    archiveSha256: 'b'.repeat(64),
  },
};
const track = {
  entryId: randomUUID(),
  asset,
  name: 'Opening',
  startMs: 100,
  endMs: 800,
  gain: 0.4,
};
const group = {
  enabled: true,
  order: 'sequence',
  volume: 0.5,
  fadeInMs: 600,
  fadeOutMs: 600,
  tracks: [],
};
const refs = {
  asset: () => ({ package: '$self', fileId: 'audio' }),
  resource: () => ({ package: 'hud' }),
  tool: () => ({ package: 'tool' }),
};
const imports = {
  asset: (ref: { package: string; fileId: string }) => {
    if (ref.package !== '$self' || ref.fileId !== 'audio') throw new Error('missing');
    return asset;
  },
  resource: (ref: { package: string }) => {
    if (ref.package !== 'hud') throw new Error('missing');
    return resource;
  },
  tool: (ref: { package: string }) => {
    if (ref.package !== 'tool') throw new Error('missing');
    return tool;
  },
};
const identity = { id: randomUUID(), revision: randomUUID(), origin: null };
function module(kind: string, schemaVersion: number, value: unknown): ModuleRecord {
  return parseModuleRecord({ ...identity, kind, schemaVersion, name: 'Test', value });
}

describe('portable module references', () => {
  it('round trips music and standalone camera audio with gain and acquisition', () => {
    const music = module('music', 1, {
      version: 1,
      automaticEnabled: true,
      groups: {
        waiting: { ...group, tracks: [track] },
        tactical: group,
        technical: group,
        halftime: group,
        mapVictory: group,
        matchVictory: group,
        opening: group,
      },
    });
    const camera = module('camera', 2, {
      format: 'mizar.camera-config',
      version: 2,
      name: 'Camera',
      automaticEnabled: true,
      maps: [
        {
          map: 'de_inferno',
          source: {
            sourceName: 'default',
            treeSha256: 'c'.repeat(64),
            converterVersion: 1,
            acquisition: tool,
          },
          opening: null,
          openingSound: track,
          rounds: [],
          pauseCandidates: { tactical: [], technical: [] },
          stages: {
            warmup: null,
            tactical: null,
            technical: null,
            halftime: null,
            mapVictory: null,
            matchVictory: null,
          },
        },
      ],
    });
    for (const item of [music, camera]) {
      const template = JSON.parse(JSON.stringify(exportModule(item, refs))) as ModuleTemplate;
      expect(JSON.stringify(template)).not.toContain(resource.id);
      expect(importModule(template, imports, identity)).toEqual(item);
    }
  });
});
