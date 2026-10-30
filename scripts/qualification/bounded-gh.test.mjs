import test from 'node:test';
import assert from 'node:assert/strict';
import { runBoundedGh } from './bounded-gh.mjs';

test('one bounded write fails without replay when its result is uncertain', () => {
  let calls = 0;
  assert.throws(
    () =>
      runBoundedGh(['release', 'upload', 'v1.0.0', 'file'], (_command, _args, options) => {
        calls++;
        assert.equal(options.timeout, 180000);
        throw Object.assign(new Error('lost response'), { code: 'ETIMEDOUT' });
      }),
    /failed or timed out/,
  );
  assert.equal(calls, 1);
});
