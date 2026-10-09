import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validateCatalog } from './common.mjs';
import { verifyCs2Assets } from './verify.mjs';

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function writeFixture({ mutateCatalog, mutateManifest } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rivalhub-cs2-assets-verify-test-'));
  temporaryRoots.push(root);
  const packageRoot = join(root, 'packages', 'cs2-assets');
  const publicRoot = join(packageRoot, 'generated', 'public', 'assets', 'cs2', 'weapon');
  await mkdir(publicRoot, { recursive: true });
  await mkdir(join(packageRoot, 'generated', 'public', 'assets', 'cs2'), { recursive: true });
  await mkdir(join(root, 'scripts', 'cs2-assets'), { recursive: true });

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">\n</svg>\n';
  const outputSha256 = createHash('sha256').update(svg).digest('hex');
  const outputPath = `/assets/cs2/weapon/ak47.${outputSha256.slice(0, 12)}.svg`;
  const catalog = {
    schemaVersion: 1,
    items: [
      {
        canonicalKey: 'weapon.ak47',
        gsiWeaponNames: ['weapon_ak47'],
        sourcePath: 'panorama/images/icons/equipment/ak47.vsvg_c',
        kind: 'firearm',
        family: 'rifle',
        displayCategory: 'rifle',
        assetId: 'weapon.ak47',
        ammoPresentation: 'magazine',
        tintMode: 'mask',
        aliases: [],
        evidence: [{ kind: 'live-gsi', reference: 'fixture' }],
      },
    ],
  };
  mutateCatalog?.(catalog);
  const manifest = {
    schemaVersion: 1,
    source: { appId: 730, steamBuildId: '123456', container: 'game/csgo/pak01_dir.vpk' },
    extractor: { project: 'ValveResourceFormat', tool: 'Source2Viewer-CLI', version: '20.0' },
    assets: {
      'weapon.ak47': {
        sourcePath: 'panorama/images/icons/equipment/ak47.vsvg_c',
        sourceSha256: 'a'.repeat(64),
        outputPath,
        outputSha256,
        mediaType: 'image/svg+xml',
        tintMode: 'mask',
      },
    },
  };
  mutateManifest?.(manifest);
  const manifestAsset = manifest.assets['weapon.ak47'];
  if (manifestAsset !== undefined) {
    await mkdir(
      join(
        packageRoot,
        'generated',
        'public',
        ...manifestAsset.outputPath.slice(1).split('/').slice(0, -1),
      ),
      { recursive: true },
    );
    await writeFile(
      join(packageRoot, 'generated', 'public', manifestAsset.outputPath.slice(1)),
      svg,
    );
  }
  await mkdir(join(packageRoot, 'catalog'), { recursive: true });
  await writeFile(
    join(packageRoot, 'catalog', 'items.json'),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
  await mkdir(join(packageRoot, 'generated'), { recursive: true });
  await writeFile(
    join(packageRoot, 'generated', 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    join(packageRoot, 'generated', 'public', 'assets', 'cs2', 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    join(root, 'scripts', 'cs2-assets', 'toolchain.json'),
    `${JSON.stringify({ valveResourceFormat: manifest.extractor }, null, 2)}\n`,
  );
  return root;
}

describe('cs2-assets verify', () => {
  it('verifies a deterministic checked-in asset fixture', async () => {
    const root = await writeFixture();
    await expect(verifyCs2Assets({ rootDir: root })).resolves.toMatchObject({
      catalogItems: 1,
      assets: 1,
    });
  });

  it('accepts a valid 16-hex expanded output hash prefix', async () => {
    const root = await writeFixture({
      mutateManifest: (manifest) => {
        const asset = manifest.assets['weapon.ak47'];
        asset.outputPath = `/assets/cs2/weapon/ak47.${asset.outputSha256.slice(0, 16)}.svg`;
      },
    });

    await expect(verifyCs2Assets({ rootDir: root })).resolves.toMatchObject({
      catalogItems: 1,
      assets: 1,
    });
  });

  it('verifies pinned and content-hashed broadcast artwork separately from the item catalog', async () => {
    const root = await writeFixture();
    const generated = join(root, 'packages', 'cs2-assets', 'generated');
    const publicRoot = join(generated, 'public');
    const bytes = Buffer.from('fixture-map-thumbnail');
    const outputSha256 = createHash('sha256').update(bytes).digest('hex');
    const outputPath = `/assets/cs2/thumbnails/de_ancient.${outputSha256.slice(0, 12)}.jpg`;
    const sourceCommit = '1'.repeat(40);
    const manifest = {
      schemaVersion: 1,
      assets: {
        'map.de_ancient': {
          sourceRepository: 'MurkyYT/cs2-map-icons',
          sourceCommit,
          sourcePath: 'images/thumbs/de_ancient_1_png.png',
          sourceUrl: `https://github.com/MurkyYT/cs2-map-icons/blob/${sourceCommit}/images/thumbs/de_ancient_1_png.png`,
          sourceSha256: 'a'.repeat(64),
          transformation: 'resize and encode fixture',
          outputPath,
          outputSha256,
          mediaType: 'image/jpeg',
          owner: 'Valve / Counter-Strike 2 game asset',
        },
      },
    };
    const filePath = join(publicRoot, outputPath.slice(1));
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, bytes);
    await writeFile(
      join(generated, 'broadcast-assets.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    await expect(verifyCs2Assets({ rootDir: root })).resolves.toMatchObject({ broadcastAssets: 1 });
  });

  it('rejects an expanded output hash prefix that does not match outputSha256', async () => {
    const root = await writeFixture({
      mutateManifest: (manifest) => {
        const asset = manifest.assets['weapon.ak47'];
        const wrongSuffix = asset.outputSha256[12] === '0' ? '1' : '0';
        asset.outputPath = `/assets/cs2/weapon/ak47.${asset.outputSha256.slice(0, 12)}${wrongSuffix}${asset.outputSha256.slice(13, 16)}.svg`;
      },
    });

    await expect(verifyCs2Assets({ rootDir: root })).rejects.toThrow(
      'outputPath hash prefix 必须匹配 outputSha256',
    );
  });

  it('rejects unsupported content hash prefix lengths between expansion steps', async () => {
    const root = await writeFixture({
      mutateManifest: (manifest) => {
        const asset = manifest.assets['weapon.ak47'];
        asset.outputPath = `/assets/cs2/weapon/ak47.${asset.outputSha256.slice(0, 13)}.svg`;
      },
    });

    await expect(verifyCs2Assets({ rootDir: root })).rejects.toThrow(
      'outputPath hash prefix 长度必须为 12/16/20/.../64',
    );
  });

  it('rejects a catalog-known item when its manifest asset is missing', async () => {
    const root = await writeFixture({
      mutateManifest: (manifest) => {
        delete manifest.assets['weapon.ak47'];
      },
    });
    await expect(verifyCs2Assets({ rootDir: root })).rejects.toThrow(
      'catalog assetId 集合必须与 manifest assets 集合完全一致',
    );
  });

  it('rejects duplicate GSI weapon names or aliases across catalog items', async () => {
    const root = await writeFixture({
      mutateCatalog: (catalog) => {
        catalog.items.push({
          ...catalog.items[0],
          canonicalKey: 'weapon.ak47-duplicate',
          assetId: 'weapon.ak47-duplicate',
          gsiWeaponNames: ['weapon_ak47_alt'],
          aliases: ['weapon_ak47'],
        });
      },
    });
    await expect(verifyCs2Assets({ rootDir: root })).rejects.toThrow(
      'GSI weapon name/alias 冲突：weapon_ak47',
    );
  });
  it('strictly rejects catalog items with empty evidence even if ammoPresentation is none', () => {
    const invalidCatalog = {
      schemaVersion: 1,
      items: [
        {
          canonicalKey: 'weapon.knife',
          gsiWeaponNames: ['weapon_knife'],
          aliases: [],
          kind: 'melee',
          family: 'knife',
          displayCategory: 'Melee',
          assetId: 'weapon.knife',
          sourcePath: 'panorama/images/icons/equipment/knife.vsvg_c',
          ammoPresentation: 'none',
          tintMode: 'mask',
          evidence: [],
        },
      ],
    };
    expect(() => validateCatalog(invalidCatalog)).toThrow(/必须至少包含一条 evidence/);
  });
});
