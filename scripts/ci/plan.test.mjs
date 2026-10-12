import { describe, expect, it } from 'vitest';

import { parseGitDiffNameStatus } from './plan.mjs';

describe('changed-surface CI planner', () => {
  it('parses ordinary and rename diff records', () => {
    expect(parseGitDiffNameStatus('M\tpackages/core/src/index.ts\nR100\told.ts\tnew.ts\n')).toEqual(
      [
        { path: 'packages/core/src/index.ts', status: 'M' },
        { path: 'old.ts', status: 'R100' },
        { path: 'new.ts', status: 'R100' },
      ],
    );
  });
});
