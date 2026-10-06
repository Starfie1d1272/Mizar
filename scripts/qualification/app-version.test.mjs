import { expect, it } from 'vitest';
import { readAppVersion, validateReleaseTag } from './app-version.mjs';
it('rejects mismatched or non-release tags while accepting exact RC/final identities', async () => {
  expect(await readAppVersion()).toMatch(/^\d+\.\d+\.\d+/);
  expect(() => validateReleaseTag('v1.0.0-rc.7', '1.0.0-rc.6')).toThrow();
  expect(() => validateReleaseTag('refs/tags/v1.0.0', '1.0.0')).toThrow();
  expect(() => validateReleaseTag('v1.0.0-rc.7', '1.0.0-rc.7')).not.toThrow();
  expect(() => validateReleaseTag('v1.0.0', '1.0.0')).not.toThrow();
});
