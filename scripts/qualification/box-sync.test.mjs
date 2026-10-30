import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { BoxClient } from './box-sync.mjs';

const { Response } = globalThis;

function client(transport) {
  const box = new BoxClient('test-token', transport);
  box.api = async (_endpoint, _path, _method, _body, signal) => {
    assert.ok(signal);
    return 'https://box.example/upload';
  };
  box.temporaryUrl = (value) => new URL(value);
  return box;
}

test('retries only the zero-byte failed chunk and retains the successful prefix', async () => {
  const ranges = [];
  const box = client(async (_url, options) => {
    const range = options.headers['Content-Range'];
    ranges.push(range);
    if (ranges.length === 2)
      throw Object.assign(new Error('connection failed'), {
        code: 'BOX_CURL_FAILED',
        retrySafeUpload: true,
      });
    return Response.json(range.startsWith('bytes 2-') ? [{ name: 'payload' }] : { success: true });
  });
  await box.uploadChunks('/Archive/test', 'payload', Buffer.from('abcd'), 2);
  assert.deepEqual(ranges, ['bytes 0-1/4', 'bytes 2-3/4', 'bytes 2-3/4']);
});

test('uncertain chunk failure is not replayed', async () => {
  let calls = 0;
  const box = client(async () => {
    calls++;
    throw Object.assign(new Error('connection lost'), { code: 'BOX_CURL_FAILED' });
  });
  await assert.rejects(box.uploadChunks('/Archive/test', 'payload', Buffer.from('abcd'), 2), {
    uploadOutcomeUnknown: true,
    retrySafeUpload: false,
  });
  assert.equal(calls, 1);
});

test('zero-byte retries stop after three attempts', async () => {
  let calls = 0;
  const box = client(async () => {
    calls++;
    throw Object.assign(new Error('connection failed'), {
      code: 'BOX_CURL_FAILED',
      retrySafeUpload: true,
    });
  });
  await assert.rejects(box.uploadChunks('/Archive/test', 'payload', Buffer.from('a')), {
    retrySafeUpload: true,
  });
  assert.equal(calls, 3);
});
