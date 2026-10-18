import { Buffer } from 'node:buffer';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Resolve upstream once per candidate; the product digest freezes these exact bytes. */
export async function stageMulnxBundle(root, destination) {
  const {
    latestMulnxRelease,
    downloadVerified,
    extractMulnx,
    publicJson,
    upstreamNotice,
    SEVEN_ZIP,
  } = await import(
    pathToFileURL(join(root, 'apps/companion/dist/orchestration/tool-release.js')).href
  );
  const release = await latestMulnxRelease();
  await mkdir(destination, { recursive: true });
  const downloads = await Promise.allSettled([
    downloadVerified(release.url, join(destination, 'MulNX.7z'), release.sha256, release.size),
    downloadVerified(SEVEN_ZIP.url, join(destination, '7zr.exe'), SEVEN_ZIP.sha256),
    ...['LICENSE.txt', 'COPYRIGHT.md', 'SECURITY.md'].map(async (name) => {
      await writeFile(join(destination, `MulNX-${name}`), await upstreamNotice(name, release.tag));
    }),
  ]);
  const failure = downloads.find((item) => item.status === 'rejected');
  if (failure) throw failure.reason;
  const license = await publicJson(
    'https://api.github.com/repos/ip7z/7zip/contents/DOC/License.txt?ref=26.04',
  );
  if (license.encoding !== 'base64' || typeof license.content !== 'string')
    throw new Error('7zip_license_missing');
  await writeFile(join(destination, '7zip-License.txt'), Buffer.from(license.content, 'base64'));
  await writeFile(
    join(destination, 'SOURCES.txt'),
    [
      `MulNX ${release.tag}: https://github.com/Co1Swet/MulNX_CS2/tree/${release.tag}`,
      `MulNX source: https://github.com/Co1Swet/MulNX_CS2/archive/refs/tags/${release.tag}.zip`,
      'MulNX is distributed as a separate upstream program; its original third-party notices remain in the archive.',
      '7-Zip 26.04 source: https://github.com/ip7z/7zip/tree/26.04',
      '7-Zip source archive: https://github.com/ip7z/7zip/archive/refs/tags/26.04.zip',
      '',
    ].join('\n'),
  );
  const scratch = join(destination, '.verify');
  try {
    const unpacked = await extractMulnx(
      join(destination, '7zr.exe'),
      join(destination, 'MulNX.7z'),
      scratch,
    );
    const notice = await readFile(join(unpacked.root, 'CS2OBTool/CameraSystem/CamPacks/readme.md'));
    await writeFile(join(destination, 'CameraPack-NOTICE.md'), notice);
    await writeFile(
      join(destination, 'release.json'),
      JSON.stringify(
        {
          schema: 1,
          release,
          extractor: SEVEN_ZIP,
          files: unpacked.files,
          expandedBytes: unpacked.bytes,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return release;
}
