import { describe, expect, it } from 'vitest';
import { balanceBrowserFiles } from './browser-sharding.mjs';

const full = {
  suites: ['slow.spec.ts', 'medium.spec.ts', 'small.spec.ts', 'tiny.spec.ts'].map((file) => ({
    title: file,
    column: 0,
    specs: [{ file, title: 'consumer passes', tests: [{ projectName: 'chromium' }] }],
  })),
};

describe('whole-file browser duration balancing', () => {
  it('assigns each file once and pairs short files with the less loaded lane', () => {
    expect(
      balanceBrowserFiles(full, 2, {
        'slow.spec.ts': 10000,
        'medium.spec.ts': 6000,
        'small.spec.ts': 3000,
        'tiny.spec.ts': 1000,
      }),
    ).toEqual([
      { files: ['slow.spec.ts'], estimatedMs: 10000 },
      { files: ['medium.spec.ts', 'small.spec.ts', 'tiny.spec.ts'], estimatedMs: 10000 },
    ]);
  });
  it('keeps newly discovered files with a positive fallback and stable routing', () => {
    const reversed = { suites: [...full.suites].reverse() };
    expect(balanceBrowserFiles(reversed, 2)).toEqual(balanceBrowserFiles(full, 2));
    expect(
      balanceBrowserFiles(full, 2)
        .flatMap((lane) => lane.files)
        .sort(),
    ).toEqual(full.suites.map((suite) => suite.title).sort());
  });
  it('rejects invalid discovery, estimates and empty lanes', () => {
    expect(() => balanceBrowserFiles({ errors: [{}] }, 1)).toThrow('FULL discovery failed');
    expect(() => balanceBrowserFiles(full, 5)).toThrow('empty selections');
    expect(() => balanceBrowserFiles(full, 0)).toThrow('invalid browser shard count');
    expect(() => balanceBrowserFiles(full, 2, { 'slow.spec.ts': -1 })).toThrow(
      'invalid browser duration',
    );
  });
});
