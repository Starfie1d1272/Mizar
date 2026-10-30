import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadReleaseAssets } from './upload-release-assets.mjs';

test('failed upload joins its siblings and never starts the next batch', async () => {
  const calls = [],
    finished = [];
  await assert.rejects(
    uploadReleaseAssets('v1.0.0', ['a', 'b', 'c', 'd'], async (_command, args, options) => {
      const name = args[3];
      calls.push(name);
      assert.equal(options.timeout, 180000);
      if (name === 'b') throw new Error('lost response');
      await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
      finished.push(name);
    }),
    /outcome unknown/,
  );
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.deepEqual(finished.sort(), ['a', 'c']);
});
