import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseManifest, verifyFiles } from '../src/index.js';

const data = Buffer.from('example');
const sha256 = createHash('sha256').update(data).digest('hex');
const base = {
  format: 'mizar.pack',
  formatVersion: 1,
  packageId: '5a72a7f4-6e27-4f32-8b3a-9d2ab35963dc',
  version: '1.0.0',
  name: 'Test',
  author: '',
  modules: [
    { entryId: 'music', module: 'music', schemaVersion: 1, fileId: 'audio', required: true },
  ],
  presets: [],
  dependencies: [],
  requirements: [],
  files: [
    { id: 'audio', path: 'assets/example.wav', mediaType: 'audio/wav', bytes: data.length, sha256 },
  ],
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

describe('pack manifest', () => {
  it('uses canonical JSON identity and verifies bytes', () => {
    const first = parseManifest(encode(base));
    const second = parseManifest(encode(Object.fromEntries(Object.entries(base).reverse())));
    expect(first.digest).toBe(second.digest);
    expect(() =>
      verifyFiles(first.manifest, new Map([['assets/example.wav', data]])),
    ).not.toThrow();
    expect(() =>
      verifyFiles(first.manifest, new Map([['assets/example.wav', Buffer.from('changed')]])),
    ).toThrow();
  });
  it('rejects duplicate keys, unsafe paths, collisions and missing references', () => {
    expect(() =>
      parseManifest(
        Buffer.from(
          JSON.stringify(base).replace('"formatVersion":1', '"formatVersion":1,"formatVersion":1'),
        ),
      ),
    ).toThrow();
    for (const path of ['../x', 'C:/x', 'assets/CON.txt', 'assets/example.wav/x']) {
      expect(() =>
        parseManifest(
          encode({ ...base, files: [...base.files, { ...base.files[0], id: 'other', path }] }),
        ),
      ).toThrow();
    }
    expect(() =>
      parseManifest(encode({ ...base, modules: [{ ...base.modules[0], fileId: 'missing' }] })),
    ).toThrow();
  });
});
