import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ObsOutputsStatus } from '@mizar/protocol/obs';
import { confirmHudActivation, obsOutputsIdle } from './hud-activation';

test('only confirmed idle OBS outputs allow activation without confirmation', () => {
  const idle = { phase: 'idle', active: false, pending: null, revision: '1' } as const;
  const status: ObsOutputsStatus = { stream: idle, record: idle };
  assert.equal(obsOutputsIdle(status), true);
  assert.equal(obsOutputsIdle(null), false);
  for (const phase of [
    'unknown',
    'starting',
    'active',
    'stopping',
    'reconnecting',
    'paused',
  ] as const) {
    assert.equal(obsOutputsIdle({ ...status, stream: { ...idle, phase } }), false);
    assert.equal(obsOutputsIdle({ ...status, record: { ...idle, phase } }), false);
  }
  assert.equal(obsOutputsIdle({ ...status, record: { ...idle, pending: 'start' } }), false);
  assert.equal(obsOutputsIdle({ ...status, stream: { ...idle, active: null } }), false);
});

test('activation checks the target after confirmation and respects cancellation', async () => {
  const original = globalThis.fetch;
  const idle = { phase: 'idle', active: false, pending: null, revision: '1' } as const;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ stream: idle, record: idle }));
    let confirmations = 0;
    const accept = async () => {
      confirmations++;
      return true;
    };
    assert.equal(await confirmHudActivation('A', accept, () => true), 'ready');
    assert.equal(confirmations, 0);
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ stream: { ...idle, phase: 'active' }, record: idle }));
    assert.equal(
      await confirmHudActivation(
        'A',
        async () => false,
        () => true,
      ),
      'cancelled',
    );
    assert.equal(await confirmHudActivation('A', accept, () => false), 'changed');
    assert.equal(await confirmHudActivation('A', accept, () => true), 'ready');
    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    assert.equal(
      await confirmHudActivation(
        'A',
        async () => false,
        () => true,
      ),
      'cancelled',
    );
  } finally {
    globalThis.fetch = original;
  }
});
