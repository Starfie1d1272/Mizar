import { describe, expect, it } from 'vitest';
import { browserIdentities, verifyBrowserEvidence, verifyBrowserShards } from './test-evidence.mjs';

function report(names, result = undefined) {
  return {
    suites: [
      {
        title: 'flow.spec.ts',
        file: 'flow.spec.ts',
        column: 0,
        specs: names.map((title) => ({
          file: 'flow.spec.ts',
          title,
          tests: [{ projectName: 'chromium', results: result === undefined ? [] : [result] }],
        })),
      },
    ],
  };
}
const passed = { status: 'passed', retry: 0 };

describe('browser discovery and actual execution proof', () => {
  it('matches a selected shard to FULL and its actual single passing attempts', () => {
    expect(
      verifyBrowserEvidence(
        report(['first', 'second']),
        report(['second']),
        report(['second'], passed),
      ),
    ).toMatchObject({ full: 2, selected: 1, passed: 1 });
  });
  it.each([
    ['omitted test', report(['first', 'second']), report(['first'], passed)],
    ['unexpected test', report(['first']), report(['first', 'second'], passed)],
    ['duplicate identity', report(['first']), report(['first', 'first'], passed)],
    ['zero discovery', report([]), report([], passed)],
    ['unexecuted', report(['first']), report(['first'])],
    ['skip', report(['first']), report(['first'], { status: 'skipped', retry: 0 })],
    ['retry pass', report(['first']), report(['first'], { status: 'passed', retry: 1 })],
    ['failure', report(['first']), report(['first'], { status: 'failed', retry: 0 })],
  ])('rejects %s', (_name, selected, actual) => {
    expect(() => verifyBrowserEvidence(report(['first', 'second']), selected, actual)).toThrow();
  });
  it('rejects a selection not present in FULL and runner errors', () => {
    expect(() =>
      verifyBrowserEvidence(report(['first']), report(['second']), report(['second'], passed)),
    ).toThrow('absent from FULL');
    expect(() =>
      verifyBrowserEvidence(report(['first']), report(['first']), {
        ...report(['first'], passed),
        errors: [{ message: 'server died' }],
      }),
    ).toThrow('runner errors');
  });
  it('rejects repeated attempts even when the last attempt passes', () => {
    const actual = report(['first'], passed);
    actual.suites[0].specs[0].tests[0].results.unshift({ status: 'failed', retry: 0 });
    expect(() => verifyBrowserEvidence(report(['first']), report(['first']), actual)).toThrow(
      'repeated attempt',
    );
  });
  it('distinguishes equal titles in different projects and nested suites', () => {
    const sample = report([]);
    sample.suites[0].suites = ['left', 'right'].map((title) => ({
      title,
      column: 1,
      specs: report(['same']).suites[0].specs,
    }));
    const ids = browserIdentities(sample).map((test) => test.id);
    expect(new Set(ids).size).toBe(2);
    const nested = sample.suites[0].suites[0].specs[0].tests;
    nested.push({ projectName: 'other', results: [] });
    expect(new Set(browserIdentities(sample).map((test) => test.id)).size).toBe(3);
  });
});

it('requires shard union to cover the same FULL exactly once', () => {
  const full = report(['first', 'second']);
  const shard = (names) => ({ full, selected: report(names), actual: report(names, passed) });
  expect(verifyBrowserShards([shard(['first']), shard(['second'])])).toEqual({
    full: 2,
    passed: 2,
  });
  expect(() => verifyBrowserShards([shard(['first'])])).toThrow('shard union');
  expect(() => verifyBrowserShards([shard(['first']), shard(['first'])])).toThrow('shard union');
  expect(() =>
    verifyBrowserShards([shard(['first']), { ...shard(['second']), full: report(['second']) }]),
  ).toThrow('different FULL');
});
