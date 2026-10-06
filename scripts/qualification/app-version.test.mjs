import { expect, it } from 'vitest';
import { readAppVersion, validateReleaseTag, windowsBundleName } from './app-version.mjs';
it('rejects mismatched or non-release tags while accepting exact RC/final identities', async () => {
  expect(await readAppVersion()).toMatch(/^\d+\.\d+\.\d+/);
  expect(() => validateReleaseTag('v1.0.0-rc.7', '1.0.0-rc.6')).toThrow();
  expect(() => validateReleaseTag('refs/tags/v1.0.0', '1.0.0')).toThrow();
  expect(() => validateReleaseTag('v1.0.0-rc.7', '1.0.0-rc.7')).not.toThrow();
  expect(() => validateReleaseTag('v1.0.0', '1.0.0')).not.toThrow();
});

it('uses the application version for RC and final Windows names and rejects unsafe versions', () => {
  expect(windowsBundleName('1.0.0-rc.10')).toBe('Mizar-v1.0.0-rc.10-Windows-x64');
  expect(windowsBundleName('1.0.0')).toBe('Mizar-v1.0.0-Windows-x64');
  expect(() => windowsBundleName('../RC10')).toThrow();
});
