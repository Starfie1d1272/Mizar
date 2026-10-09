import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { platformTestFiles, verifyPlatformReport } from './platform-contracts.mjs';

const root = resolve(import.meta.dirname, '../..');
const files = [
  'scripts/qualification/offline.test.mjs',
  'apps/companion/test/support-export.test.ts',
];
function report() {
  return {
    success: true,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    testResults: files.map((file) => ({
      name: resolve(root, file),
      assertionResults: [{ title: 'contract', fullName: 'suite contract', status: 'passed' }],
    })),
  };
}

describe('platform contract evidence', () => {
  it('requires real passing execution from every selected consumer', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(platformTestFiles(platform)).toEqual(
        expect.arrayContaining([
          'apps/companion/test/resource-store/store.test.ts',
          'apps/companion/test/resource-store/app-integration.test.ts',
        ]),
      );
    }
    expect(verifyPlatformReport(report(), files, 'linux').passed).toBe(2);
    const missing = report();
    missing.testResults.pop();
    expect(() => verifyPlatformReport(missing, files, 'linux')).toThrow('required files');
    const empty = report();
    empty.testResults[0].assertionResults = [];
    expect(() => verifyPlatformReport(empty, files, 'linux')).toThrow('no passing tests');
  });

  it('rejects extra, duplicate, failed and skipped execution', () => {
    const duplicate = report();
    duplicate.testResults[1] = duplicate.testResults[0];
    expect(() => verifyPlatformReport(duplicate, files, 'linux')).toThrow('required files');
    const extra = report();
    extra.testResults.push({ name: resolve(root, 'other.test.mjs'), assertionResults: [] });
    expect(() => verifyPlatformReport(extra, files, 'linux')).toThrow('required files');
    for (const status of ['failed', 'pending', 'todo']) {
      const failed = report();
      failed.testResults[0].assertionResults.push({ title: 'broken', status });
      expect(() => verifyPlatformReport(failed, files, 'linux')).toThrow('non-passing test');
    }
    const failedRunner = report();
    failedRunner.success = false;
    expect(() => verifyPlatformReport(failedRunner, files, 'linux')).toThrow('runner failed');
  });

  it('accounts only for the existing Windows Unix-symlink exception', () => {
    const windows = report();
    windows.testResults[1].assertionResults.push({
      title: 'rejects symlink log targets',
      fullName: 'support export rejects symlink log targets',
      status: 'skipped',
    });
    expect(verifyPlatformReport(windows, files, 'win32').skips).toHaveLength(1);
    expect(() => verifyPlatformReport(windows, files, 'darwin')).toThrow('non-passing test');
    expect(platformTestFiles('win32')).toContain('scripts/qualification/gsi-discovery.test.mjs');
    expect(platformTestFiles('darwin')).not.toContain(
      'scripts/qualification/gsi-discovery.test.mjs',
    );
  });
});
