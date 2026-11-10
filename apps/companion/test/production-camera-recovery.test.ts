import { expect, it } from 'vitest';
import { createProduction, type ProductionDependencies } from '../src/program-scenes/production.js';
import type { ProgramSceneController } from '../src/program-scenes/controller.js';

it('rejects a delayed camera begin from the prior preparation after finish and re-entry', async () => {
  let retired = 0;
  const production = createProduction({
    scenes: {
      get: () => ({ active: 'waiting', revision: 'scene' }),
      holdAutomatic: () => {},
      controlValid: () => () => true,
      selectWaitingForExit: async () => ({ ok: true }),
    } as unknown as ProgramSceneController,
    music: () => undefined,
    camera: () => ({
      beginProduction: () => {},
      finishProduction: () => {
        retired++;
      },
    }),
    demo: () => undefined,
    observer: { endProduction: () => {} } as ProductionDependencies['observer'],
    binding: () => undefined,
    waitForBroadcast: async () => {},
    obsExit: { previousUnconfirmed: false, record: async () => {}, wait: async () => {} },
    warn: () => {},
    error: () => {},
  });
  expect(
    (
      await production.change({
        action: 'enter',
        preparationId: null,
        expectedRevision: production.get().revision,
      })
    ).ok,
  ).toBe(true);
  const oldRevision = production.get().revision;
  let committed = 0;
  production.configureCameraSession(oldRevision, () => {
    committed++;
  });
  expect(
    (
      await production.change({
        action: 'finish',
        preparationId: null,
        expectedRevision: oldRevision,
      })
    ).ok,
  ).toBe(true);
  expect(retired).toBe(1);
  expect(() =>
    production.configureCameraSession(oldRevision, () => {
      committed++;
    }),
  ).toThrow('camera_production_changed');
  expect(
    (
      await production.change({
        action: 'enter',
        preparationId: null,
        expectedRevision: production.get().revision,
      })
    ).ok,
  ).toBe(true);
  expect(() =>
    production.configureCameraSession(oldRevision, () => {
      committed++;
    }),
  ).toThrow('camera_production_changed');
  production.configureCameraSession(production.get().revision, () => {
    committed++;
  });
  expect(committed).toBe(2);
});
