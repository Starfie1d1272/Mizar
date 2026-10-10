import { URL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { expect, it } from 'vitest';
import { makeMachineMetadata, readMachineMetadata, readMachineFile } from './transport.mjs';
it('preserves real original proof bytes and rejects traversal, duplicate entries and noncanonical carriers', async () => {
  const original = await readFile(
    new URL('../../apps/companion/test/fixtures/updates/update-index-v2.json', import.meta.url),
  );
  const carrier = makeMachineMetadata(new Map([['update-index.json', original]]));
  expect(readMachineFile(carrier, 'update-index.json')).toEqual(original);
  expect(() => makeMachineMetadata([['../update-index.json', original]])).toThrow();
  expect(() =>
    makeMachineMetadata([
      ['update-index.json', original],
      ['update-index.json', original],
    ]),
  ).toThrow();
  expect(() => readMachineFile(carrier, 'resource-catalog.json')).toThrow();
  const value = JSON.parse(carrier.toString());
  value.files.push(value.files[0]);
  expect(() => readMachineMetadata(Buffer.from(JSON.stringify(value) + '\n'))).toThrow();
  expect(() =>
    readMachineMetadata(Buffer.from(carrier.toString().replace('"files":', '"files":[],"files":'))),
  ).toThrow();
  expect(() =>
    makeMachineMetadata(new Map([['release-manifest.json', Buffer.alloc(65537)]])),
  ).toThrow();
});
