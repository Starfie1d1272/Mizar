import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateReleaseTag, windowsBundleName } from './app-version.mjs';
import { githubReleaseNotes } from './release-notes.mjs';
import { makeUpdateManifest } from './update-manifest.mjs';
import { makeUpdateIndex } from './update-index.mjs';
import { missingAssets } from './release-assets.mjs';

const sha = 'a'.repeat(40);
const prereleases = ['2.0.0-alpha.1', '2.0.0-beta.2', '2.0.0-rc.3'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

describe('bounded application release versions', () => {
  it.each(['0.0.0', '1.5.0', ...prereleases])(
    'accepts an exact %s tag and retains the full version in filenames',
    (version) => {
      expect(() => validateReleaseTag(`v${version}`, version)).not.toThrow();
      expect(windowsBundleName(version)).toBe(`Mizar-v${version}-Windows-x64`);
      expect(() => validateReleaseTag('v2.0.0', version + '-alpha.1')).toThrow();
      expect(() => validateReleaseTag(`v${version}`, '1.5.0-beta.1')).toThrow();
    },
  );
  it.each([
    '2.0',
    '2.0.0-alpha',
    '2.0.0-alpha.0',
    '2.0.0-beta.0',
    '2.0.0-rc.0',
    '2.0.0-beta.x',
    '2.0.0-rc.-1',
    '2.0.0-preview.1',
    '2.0.0-ALPHA.1',
    '2.0.0-alpha.1.2',
    '2.0.0+build.1',
    '2.0.0-rc.1+build',
    '02.0.0',
    '2.00.0',
    '2.0.00',
    '2.0.0-beta.01',
    '2.0.0 ',
  ])('rejects malformed %s even when source and tag agree', (version) => {
    expect(() => validateReleaseTag(`v${version}`, version)).toThrow();
  });
});

describe('prereleases stay outside Stable distribution', () => {
  const version = '2.0.0-rc.3';
  const tag = `v${version}`;
  it('links the exact full Setup and ZIP, without a stable Box or WebInstaller entry', () => {
    const notes = githubReleaseNotes(
      { version, markdown: '- 测试版本' },
      { sourceSha: sha, qualificationRunId: 123 },
    );
    const base = `https://github.com/Starfie1d1272/Mizar/releases/download/${tag}/Mizar-${tag}-Windows-x64`;
    expect(notes).toContain(`(${base}-Setup.exe)`);
    expect(notes).toContain(`(${base}.zip)`);
    expect(notes).not.toContain('box.nju.edu.cn');
    expect(notes).not.toContain('WebInstaller.exe');
  });
  it('does not generate a Stable manifest or accept a fabricated publication/index', () => {
    expect(makeUpdateManifest({ appVersion: version }, {}, {}, '')).toBeNull();
    const manifest = Buffer.from(JSON.stringify({ version, channel: 'stable', gitSha: sha }));
    const publication = Buffer.from(
      JSON.stringify({
        schemaVersion: 'mizar.update-publication.v1',
        repository: 'Starfie1d1272/Mizar',
        version,
        gitSha: sha,
        manifestSha256: hash(manifest),
        promotionSha: sha,
        releaseId: 1,
        publishedAt: '2026-10-17T00:00:00Z',
      }),
    );
    expect(() =>
      makeUpdateIndex(manifest, Buffer.from('{}'), publication, Buffer.from('{}')),
    ).toThrow('正式发布确认');
  });
  it('rejects a wrong prerelease flag, tag/source identity or existing asset bytes', () => {
    const identity = { tag, gitSha: sha };
    const ref = { object: { type: 'commit', sha } };
    const asset = { name: `Mizar-${tag}-Windows-x64-Setup.exe`, size: 123, sha256: 'b'.repeat(64) };
    const release = {
      tag_name: tag,
      prerelease: true,
      draft: true,
      assets: [
        {
          ...asset,
          digest: `sha256:${asset.sha256}`,
          browser_download_url: `https://github.com/Starfie1d1272/Mizar/releases/download/${tag}/${asset.name}`,
        },
      ],
    };
    expect(missingAssets(release, ref, identity, [asset])).toEqual([]);
    for (const change of [{ prerelease: false }, { tag_name: 'v2.0.0' }])
      expect(() => missingAssets({ ...release, ...change }, ref, identity, [asset])).toThrow();
    expect(() =>
      missingAssets(release, { object: { type: 'commit', sha: 'c'.repeat(40) } }, identity, [
        asset,
      ]),
    ).toThrow();
    expect(() =>
      missingAssets(release, ref, identity, [{ ...asset, sha256: 'c'.repeat(64) }]),
    ).toThrow();
  });
});

it('keeps stable release notes on Box and the stable WebInstaller', () => {
  const notes = githubReleaseNotes(
    { version: '1.5.0', markdown: '- 修复' },
    { sourceSha: sha, qualificationRunId: 123 },
  );
  expect(notes).toContain('box.nju.edu.cn');
  expect(notes).toContain('/v1.5.0/Mizar-v1.5.0-Windows-x64-WebInstaller.exe');
});
