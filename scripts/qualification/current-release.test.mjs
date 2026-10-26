import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { readAppVersion } from './app-version.mjs';
import { readReleaseNotes } from './release-notes.mjs';
import { makeUpdateManifest } from './update-manifest.mjs';

// Check the actual committed declarations in ordinary CI, before an expensive
// exact-SHA Windows qualification. Synthetic hashes never qualify a real binary.
it('keeps current release notes and stable update policy aligned with the app', async () => {
  const version = await readAppVersion();
  const notes = await readReleaseNotes(version);
  expect(notes.text.trim()).not.toBe('');
  if (!/^\d+\.\d+\.\d+$/.test(version)) return;
  const policy = JSON.parse(
    await readFile(new URL('./update-release.json', import.meta.url), 'utf8'),
  );
  const release = {
    appVersion: version,
    gitSha: 'a'.repeat(40),
    archiveSha256: 'b'.repeat(64),
    contentDigest: 'c'.repeat(64),
    developmentOnly: false,
    desktopBuildProfile: 'release',
  };
  const distribution = {
    appVersion: version,
    gitSha: release.gitSha,
    originalArchiveSha256: release.archiveSha256,
    contentDigest: release.contentDigest,
    format: 'nsis-setup',
    archive: `Mizar-v${version}-Windows-x64-Setup.exe`,
    archiveSha256: 'd'.repeat(64),
    archiveBytes: 1,
  };
  expect(makeUpdateManifest(release, distribution, policy, notes.text).version).toBe(version);
  expect(() =>
    makeUpdateManifest(release, distribution, { ...policy, version: '0.0.0' }, notes.text),
  ).toThrow();
});
