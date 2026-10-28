import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Buffer } from 'node:buffer';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, URL } from 'node:url';

const execute = promisify(execFile);

/** Build-only GitHub reader: use the workflow's existing CLI identity, never ship it. */
export async function buildMetadata(url, run = execute) {
  const target = new URL(url);
  if (
    target.protocol !== 'https:' ||
    target.hostname !== 'api.github.com' ||
    target.username ||
    target.password ||
    target.port ||
    target.hash ||
    !(
      /^\/repos\/Starfie1d1272\/MulNX_CS2\/(?:releases|contents\/(?:LICENSE\.txt|COPYRIGHT\.md|SECURITY\.md))$/.test(
        target.pathname,
      ) || target.pathname === '/repos/ip7z/7zip/contents/DOC/License.txt'
    )
  )
    throw new Error('mulnx_build_metadata_target');
  let stdout;
  try {
    ({ stdout } = await run(
      'gh',
      ['api', '--hostname', 'github.com', target.pathname + target.search],
      {
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
    ));
  } catch (error) {
    const status = /HTTP ([1-5][0-9]{2})/.exec(String(error?.stderr ?? ''))?.[1];
    const code = ['ENOENT', 'ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(error?.code)
      ? error.code
      : 'unavailable';
    // eslint-disable-next-line preserve-caught-error -- Raw gh errors retain command output; preserve only the bounded HTTP/system classification.
    throw new Error(`mulnx_build_metadata_failed_${status ?? code}`);
  }
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 2 * 1024 * 1024)
    throw new Error('mulnx_build_metadata_too_large');
  return JSON.parse(stdout);
}

/** Resolve upstream once per candidate; the product digest freezes these exact bytes. */
export async function stageMulnxBundle(root, destination) {
  const { latestMulnxRelease, downloadVerified, extractMulnx, upstreamNotice, SEVEN_ZIP } =
    await import(
      pathToFileURL(join(root, 'apps/companion/dist/orchestration/tool-release.js')).href
    );
  const release = await latestMulnxRelease(buildMetadata);
  await mkdir(destination, { recursive: true });
  const downloads = await Promise.allSettled([
    downloadVerified(release.url, join(destination, 'MulNX.7z'), release.sha256, release.size),
    downloadVerified(SEVEN_ZIP.url, join(destination, '7zr.exe'), SEVEN_ZIP.sha256),
    ...['LICENSE.txt', 'COPYRIGHT.md', 'SECURITY.md'].map(async (name) => {
      await writeFile(
        join(destination, `MulNX-${name}`),
        await upstreamNotice(name, release.tag, buildMetadata),
      );
    }),
  ]);
  const failure = downloads.find((item) => item.status === 'rejected');
  if (failure) throw failure.reason;
  const license = await buildMetadata(
    'https://api.github.com/repos/ip7z/7zip/contents/DOC/License.txt?ref=26.04',
  );
  if (license.encoding !== 'base64' || typeof license.content !== 'string')
    throw new Error('7zip_license_missing');
  await writeFile(join(destination, '7zip-License.txt'), Buffer.from(license.content, 'base64'));
  await writeFile(
    join(destination, 'SOURCES.txt'),
    [
      'LOCAL COMPATIBILITY TEST ONLY — NOT AN OFFICIAL RELEASE CANDIDATE.',
      `MulNX test fork ${release.tag}: https://github.com/Starfie1d1272/MulNX_CS2/tree/${release.tag}`,
      `MulNX test source: https://github.com/Starfie1d1272/MulNX_CS2/archive/refs/tags/${release.tag}.zip`,
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
