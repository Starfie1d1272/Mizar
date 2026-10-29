import { expect, it, vi } from 'vitest';
import { getBuiltinLayout, getBuiltinPreset, getBuiltinTheme } from '@mizar/hud-config';
import type { ModuleKind, ModuleRecord } from '@mizar/broadcast-config';
import { createBroadcastResolver } from '../../src/broadcast-config/resolver.js';

it('checks every referenced asset before returning a candidate', async () => {
  const layout = getBuiltinLayout();
  const visual = { kind: 'builtin', id: 'pulse', apiVersion: 1 };
  const asset = {
    resource: { id: 'local:asset', version: '1', digest: 'a'.repeat(64) },
    fileId: 'track',
  };
  const hud = {
    kind: 'hud',
    value: {
      renderer: { kind: 'native', id: 'mizar.hud', apiVersion: 1 },
      preset: getBuiltinPreset(),
      layout,
      theme: getBuiltinTheme(),
      overlays: {
        pause: { enabled: true, visual: 'default' },
        chat: { enabled: true, placement: Object.values(layout.widgets)[0] },
      },
      accent: { source: 'event', fallback: getBuiltinTheme().brandColor },
    },
  } as unknown as ModuleRecord;
  const program = {
    kind: 'program',
    value: {
      scenes: {
        waiting: visual,
        matchup: visual,
        bp: visual,
        halftime: visual,
        map_result: visual,
        intermap: visual,
        match_result: visual,
      },
      tokens: {},
      assets: { 'pulse.background': asset },
    },
  } as unknown as ModuleRecord;
  const verify = vi.fn(() => Promise.reject(new Error('dependency_missing')));
  const resolver = createBroadcastResolver({
    asset: verify,
    image: verify,
    hud: () => Promise.resolve(),
    scene: () => Promise.resolve(),
    camera: () => Promise.reject(new Error('unused')),
  });
  const modules = new Map<ModuleKind, ModuleRecord | null>([
    ['hud', hud],
    ['program', program],
    ['music', null],
    ['camera', null],
  ]);
  await expect(resolver.resolve(modules)).rejects.toThrow('dependency_missing');
  expect(verify).toHaveBeenCalledWith(asset);
  if (program.kind !== 'program') throw new Error('expected program');
  program.value.assets = { logo: asset };
  verify.mockClear();
  await expect(resolver.resolve(modules)).rejects.toThrow('capability_unsupported');
  expect(verify).not.toHaveBeenCalled();
});
