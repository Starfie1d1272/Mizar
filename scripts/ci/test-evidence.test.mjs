import { verifyInstallerShards } from './verify-installer-shards.mjs';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { browserIdentities, verifyBrowserEvidence, verifyBrowserShards } from './test-evidence.mjs';
import { readBrowserShards } from './verify-browser-shards.mjs';

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

describe('same-source browser evidence across partial workflow reruns', () => {
  const context = { attempt: 2, runId: '42', sourceSha: 'a'.repeat(40) };
  function fixture(action) {
    const root = mkdtempSync(join(tmpdir(), 'mizar-browser-evidence-'));
    const save = (shard, attempt = 1, changes = {}) => {
      const directory = join(
        root,
        `browser-evidence-${attempt}-${shard}`,
        'test-evidence',
        `${shard}-2`,
      );
      mkdirSync(directory, { recursive: true });
      const values = {
        identity: { ...context, attempt, shard, count: 2 },
        full: report(['first', 'second']),
        selected: report([shard === 1 ? 'first' : 'second']),
        actual: report([shard === 1 ? 'first' : 'second'], passed),
        ...changes,
      };
      for (const [name, value] of Object.entries(values))
        writeFileSync(join(directory, `${name}.json`), JSON.stringify(value));
    };
    try {
      return action(root, save);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  it('uses prior successful shards when only another job or the gate reruns', () => {
    fixture((root, save) => {
      save(1);
      save(2);
      expect(verifyBrowserShards(readBrowserShards(root, 2, context))).toEqual({
        full: 2,
        passed: 2,
      });
      save(2, 2);
      expect(verifyBrowserShards(readBrowserShards(root, 2, context))).toEqual({
        full: 2,
        passed: 2,
      });
    });
  });
  it('rejects a failed newest shard instead of reusing its earlier success', () => {
    fixture((root, save) => {
      save(1);
      save(2);
      save(2, 2, { actual: report(['second'], { status: 'failed', retry: 0 }) });
      expect(() => verifyBrowserShards(readBrowserShards(root, 2, context))).toThrow('non-passing');
    });
  });
  it.each([
    { runId: '43' },
    { sourceSha: 'b'.repeat(40) },
    { attempt: 1 },
    { shard: 1 },
    { count: 3 },
  ])('rejects newest evidence with a different identity: %j', (change) => {
    fixture((root, save) => {
      save(1);
      save(2);
      save(2, 2, { identity: { ...context, shard: 2, count: 2, ...change } });
      expect(() => readBrowserShards(root, 2, context)).toThrow('identity differs');
    });
  });
  it('rejects a missing shard and evidence from a future attempt', () => {
    fixture((root, save) => {
      save(1);
      expect(() => readBrowserShards(root, 2, context)).toThrow('missing browser shard');
      save(2, 3);
      expect(() => readBrowserShards(root, 2, context)).toThrow('unexpected attempt');
    });
  });
});

describe('isolated installer group evidence', () => {
  const context = { attempt: 2, runId: '42', sourceSha: 'a'.repeat(40) };
  const cases = {
    update: [
      'pending-marker',
      'prepared-install',
      'destination-selection',
      'same-version-update',
      'ambiguous-launch',
      'prepared-recovery',
      'update-rollback',
    ],
    faults: [
      'historical-bridge',
      'app-resource-boundary',
      'unknown-existing-files',
      'completed-pending',
      'owned-residue',
      'post-install-identity',
      'cancelled-install',
      'invalid-installer',
    ],
  };
  function fixture(action) {
    const root = mkdtempSync(join(tmpdir(), 'mizar-installer-evidence-'));
    const save = (group, attempt = 1, changes = {}) => {
      const folder = join(root, `installer-evidence-${attempt}-${group}`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, 'nsis-evidence.json'),
        JSON.stringify({
          ...context,
          attempt: String(attempt),
          group,
          cases: cases[group],
          ...changes,
        }),
      );
    };
    try {
      action(root, save);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  it('requires the original case union and supports a single-group or gate-only rerun', () => {
    fixture((root, save) => {
      save('update');
      save('faults');
      expect(verifyInstallerShards(root, context)).toEqual({ groups: 2, passed: 15 });
      save('faults', 2);
      expect(verifyInstallerShards(root, context)).toEqual({ groups: 2, passed: 15 });
    });
  });
  it.each(['update', 'faults'])(
    'rejects missing or incomplete newest %s evidence without fallback',
    (group) => {
      fixture((root, save) => {
        save(group === 'update' ? 'faults' : 'update');
        expect(() => verifyInstallerShards(root, context)).toThrow('missing installer');
        save(group);
        save(group, 2, { cases: cases[group].slice(1) });
        expect(() => verifyInstallerShards(root, context)).toThrow('case coverage');
      });
    },
  );
  it.each([
    { sourceSha: 'b'.repeat(40) },
    { runId: '43' },
    { attempt: '1' },
    { group: 'update' },
    { cases: Array(8).fill('cancelled-install') },
  ])('rejects wrong identities or duplicated cases: %j', (change) => {
    fixture((root, save) => {
      save('update');
      save('faults');
      save('faults', 2, change);
      expect(() => verifyInstallerShards(root, context)).toThrow();
    });
  });
  it('rejects a future attempt and an undeclared group', () => {
    fixture((root, save) => {
      save('update');
      save('faults', 3);
      expect(() => verifyInstallerShards(root, context)).toThrow('future');
    });
    fixture((root, save) => {
      save('update');
      save('faults');
      save('other');
      expect(() => verifyInstallerShards(root, context)).toThrow('unknown');
    });
  });
});
