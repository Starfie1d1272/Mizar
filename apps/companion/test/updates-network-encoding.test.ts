import { expect, it } from 'vitest';
import { boundedBytes, updateRequest } from '../src/updates/network.js';

const url = 'https://box.nju.edu.cn/seafhttp/files/opaque';
const signal = new AbortController().signal;
const compressed =
  (bytes: Uint8Array, contentType = 'text/plain; charset=gbk') =>
  async () =>
    new Response(bytes, {
      headers: { 'content-encoding': 'gzip', 'content-type': contentType, 'content-length': '999' },
    });

it('accepts bounded decoded Box text bytes only when explicitly requested', async () => {
  const original = Uint8Array.from([0x81, 0x40, 0xff]);
  const fetcher = compressed(original);
  await expect(updateRequest(url, signal, fetcher)).rejects.toThrow('update_encoding_invalid');
  const response = await updateRequest(url, signal, fetcher, { allowCompressedBoxText: true });
  expect(await boundedBytes(response, original.length)).toEqual(Buffer.from(original));
  await expect(
    boundedBytes(
      await updateRequest(url, signal, fetcher, { allowCompressedBoxText: true }),
      original.length - 1,
    ),
  ).rejects.toThrow('update_response_too_large');
  await expect(
    updateRequest(url, signal, compressed(original, 'application/octet-stream'), {
      allowCompressedBoxText: true,
    }),
  ).rejects.toThrow('update_encoding_invalid');
});
