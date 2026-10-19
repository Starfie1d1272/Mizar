import { expect, it, vi } from 'vitest';
import { buildMetadata } from './mulnx-bundle.mjs';

it('uses the existing build CLI identity only for approved upstream metadata', async () => {
  const run = vi.fn(() => Promise.resolve({ stdout: '[{"tag_name":"Beta15"}]' }));
  expect(
    await buildMetadata('https://api.github.com/repos/Co1Swet/MulNX_CS2/releases?per_page=20', run),
  ).toEqual([{ tag_name: 'Beta15' }]);
  expect(run).toHaveBeenCalledWith(
    'gh',
    ['api', '--hostname', 'github.com', '/repos/Co1Swet/MulNX_CS2/releases?per_page=20'],
    expect.objectContaining({ timeout: 20_000, maxBuffer: 2097152, windowsHide: true }),
  );
  for (const url of [
    'https://example.com/repos/Co1Swet/MulNX_CS2/releases',
    'https://api.github.com/user',
    'https://api.github.com/repos/Other/Private/releases',
    'http://api.github.com/repos/Co1Swet/MulNX_CS2/releases',
    'https://user@api.github.com/repos/Co1Swet/MulNX_CS2/releases',
  ])
    await expect(buildMetadata(url, run)).rejects.toThrow('mulnx_build_metadata_target');
  expect(run).toHaveBeenCalledTimes(1);
});

it('keeps failed and oversized metadata closed without emitting CLI diagnostics', async () => {
  const url = 'https://api.github.com/repos/ip7z/7zip/contents/DOC/License.txt?ref=26.04';
  await expect(
    buildMetadata(url, () => Promise.reject(new Error('private diagnostic'))),
  ).rejects.toThrow('mulnx_build_metadata_failed');
  await expect(
    buildMetadata(url, () => Promise.resolve({ stdout: 'x'.repeat(2097153) })),
  ).rejects.toThrow('mulnx_build_metadata_too_large');
});
