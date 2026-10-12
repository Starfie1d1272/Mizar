import { describe, expect, it } from 'vitest';
import { markCleanupFailure, shouldCleanupQualificationState } from './supervisor.mjs';

describe('qualification supervisor finalization', () => {
  it('keeps cleanup failure separate from the verified qualification result', () => {
    const completion = {
      result: 'PASS',
      verification: 'passed',
      cleanup: 'pending',
      reportPath: 'evidence/run/REPORT.md',
      qualificationPath: 'evidence/run/qualification.json',
    };

    expect(markCleanupFailure(completion)).toMatchObject({
      result: 'PASS',
      verification: 'passed',
      cleanup: 'failed',
    });
    expect(shouldCleanupQualificationState({ ...completion, cleanup: 'failed' })).toBe(false);
    expect(shouldCleanupQualificationState({ ...completion, cleanup: 'passed' })).toBe(true);
    expect(
      shouldCleanupQualificationState({ ...completion, verification: 'failed', cleanup: 'passed' }),
    ).toBe(false);
  });
});
