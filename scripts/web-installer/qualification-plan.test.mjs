import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qualificationPlan } from './qualification-plan.mjs';

let product;
afterEach(async () => {
  if (product) await rm(product, { recursive: true, force: true });
});
it('rejects a real candidate manifest outside the main qualification identity before using its pins', async () => {
  product = await mkdtemp(join(tmpdir(), 'mizar installer candidate '));
  await writeFile(
    join(product, 'release-manifest.json'),
    JSON.stringify({ gitSha: 'a'.repeat(40), archiveSha256: 'b'.repeat(64) }),
  );
  await expect(
    qualificationPlan(
      product,
      {
        repository: 'Starfie1d1272/Mizar',
        ref: 'refs/heads/main',
        sha: 'a'.repeat(40),
        event: 'workflow_dispatch',
        workflowRef: 'Starfie1d1272/Mizar/.github/workflows/ci.yml@refs/heads/main',
      },
      'a'.repeat(40),
      'a'.repeat(40),
    ),
  ).rejects.toThrow('发布工作流必须来自 main');
});
