import assert from 'node:assert/strict';
import { test } from 'vitest';
import { syncHealthText, type SyncHealth } from '../src/workspace/SyncHealthAlert.js';

test('classified reliable failures give specific safe next steps', () => {
  const health: SyncHealth = {
    status: 'attention',
    reason: 'sequence_stale',
    incidentId: 'incident',
    deviceName: null,
  };
  assert.match(syncHealthText(health), /进度.*核对/);
  assert.match(syncHealthText({ ...health, reason: 'context_stale' }), /刷新/);
  assert.match(syncHealthText({ ...health, reason: 'authority_changed' }), /归属/);
  assert.equal(syncHealthText({ ...health, reason: 'unrecognized' }), '网站尚未确认接收本场数据');
});
