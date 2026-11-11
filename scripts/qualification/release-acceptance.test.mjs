import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyReleaseAcceptance } from './release-acceptance.mjs';

const identity = {
  qualificationRun: '123',
  gitSha: 'a'.repeat(40),
  archiveSha256: 'b'.repeat(64),
  webInstallerSha256: 'c'.repeat(64),
  coreSetupSha256: 'd'.repeat(64),
};
const passed = { status: 'passed', evidence: 'Windows 11 test run on the archived build' };
const standard = {
  ...identity,
  mode: 'standard',
  checks: {
    windows: passed,
    installer: passed,
    defender: passed,
    cs2: { status: 'not_applicable', reason: 'Documentation-only change' },
    obs: passed,
  },
};

test('stable acceptance requires the exact signed candidate and all applicable checks', () => {
  assert.equal(verifyReleaseAcceptance(standard, identity), standard);
  assert.throws(
    () => verifyReleaseAcceptance(standard, { ...identity, archiveSha256: 'e'.repeat(64) }),
    /archiveSha256/,
  );
  assert.throws(
    () =>
      verifyReleaseAcceptance(
        { ...standard, checks: { ...standard.checks, installer: { status: 'failed' } } },
        identity,
      ),
    /installer/,
  );
});

test('a hotfix can explicitly defer checks with a future recheck deadline', () => {
  const hotfix = {
    ...standard,
    mode: 'hotfix',
    reason: 'Resolve an active outage',
    checks: { ...standard.checks, obs: { status: 'deferred', reason: 'OBS rig unavailable' } },
    recheckBy: '2026-11-15T08:00:00Z',
  };
  assert.equal(verifyReleaseAcceptance(hotfix, identity, Date.parse('2026-11-12')), hotfix);
  assert.throws(
    () => verifyReleaseAcceptance(hotfix, identity, Date.parse('2026-11-16')),
    /future UTC/,
  );
  assert.throws(() => verifyReleaseAcceptance({ ...hotfix, mode: 'standard' }, identity), /obs/);
});
