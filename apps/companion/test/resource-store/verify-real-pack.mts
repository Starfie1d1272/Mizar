/** 本地跨分支接线验证；输入真实 producer/runtime checkout，不替换来源验证器。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import {
  createManifestVerifier,
  type ResourcePackConsumer,
} from '../../src/resource-store/manifest-adapter.js';
import { ResourceStore } from '../../src/resource-store/store.js';

const checkout = resolve(process.argv[2] ?? '');
assert(process.argv[2], '需要真实 Pack/Trust checkout 路径');
const contract = (await import(
  pathToFileURL(join(checkout, 'packages/resource-pack-contract/index.mjs')).href
)) as Pick<
  ResourcePackConsumer,
  'parsePackManifest' | 'assertResourcePath' | 'assertCompatibility'
>;
const producer = (await import(
  pathToFileURL(join(checkout, 'scripts/asset-packs/pack.mjs')).href
)) as {
  buildOfficialPack: (
    root: string,
    input: { packVersion: string; sourceSha: string },
  ) => Promise<{
    archiveBytes: Buffer;
    manifest: {
      packId: string;
      packVersion: string;
      compatibility: unknown;
      files: readonly { path: string; bytes: number; sha256: string }[];
    };
    manifestSha256: string;
    archive: { format: string; bytes: number; sha256: string };
    entries: Map<string, Buffer>;
  }>;
};
interface RuntimeInput {
  statementBytes: Buffer;
  publicationBundleBytes: Buffer;
  archiveBytes: Buffer;
  archiveBundleBytes: Buffer;
  policy: {
    packVersion: string;
    sourceSha: string;
    promotionSha: string;
    coreVersion: string;
    minimumSequence: number;
    now: number;
  };
  tufCachePath: string;
  signal: AbortSignal;
}
const runtime = (await import(
  pathToFileURL(join(checkout, 'packages/resource-pack-contract/runtime.mjs')).href
)) as {
  verifyResourcePublicationBytes: (input: RuntimeInput) => Promise<{ manifest: unknown }>;
};
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: checkout,
  encoding: 'utf8',
}).trim();
const started = performance.now();
const pack = await producer.buildOfficialPack(checkout, { packVersion: '1.0.0', sourceSha });
const now = Math.floor(Date.now() / 1000) * 1000;
const instant = (time: number) => new Date(time).toISOString().replace('.000Z', 'Z');
// 这是明确未签的反例声明，不是正式发行，也不将其字段当成用户可配置的信任根。
const statementBytes = Buffer.from(
  JSON.stringify({
    schemaVersion: 'mizar.resource-publication.v1',
    repository: 'Starfie1d1272/Mizar',
    packId: pack.manifest.packId,
    packVersion: pack.manifest.packVersion,
    sourceRef: 'refs/heads/main',
    sourceSha,
    promotionSha: sourceSha,
    contentKind: 'recorded-replay',
    compatibility: pack.manifest.compatibility,
    manifestSha256: pack.manifestSha256,
    archive: { ...pack.archive, name: 'Mizar-official-epl-default-1.0.0.zip' },
    sequence: 1,
    issuedAt: instant(now - 60000),
    expiresAt: instant(now + 86400000),
  }),
);
const root = await mkdtemp(join(await realpath(tmpdir()), 'mizar-real-pack-'));
let calls = 0;
const store = await ResourceStore.open({
  root,
  activateWhenSafe: async (commit) => {
    await commit();
    return true;
  },
  verifyTrustedPack: createManifestVerifier(
    {
      ...contract,
      verifyReceipt: async ({ signal }) => {
        calls++;
        const verified = await runtime.verifyResourcePublicationBytes({
          statementBytes,
          publicationBundleBytes: Buffer.from('{}'),
          archiveBytes: pack.archiveBytes,
          archiveBundleBytes: Buffer.from('{}'),
          policy: {
            packVersion: '1.0.0',
            sourceSha,
            promotionSha: sourceSha,
            coreVersion: '1.1.0',
            minimumSequence: 0,
            now,
          },
          tufCachePath: join(root, 'tuf'),
          signal,
        });
        return verified.manifest;
      },
    },
    '1.1.0',
  ),
});
try {
  let rejection = '';
  await assert.rejects(
    store.installVerified('official:epl-default', async ({ directory, onProgress }) => {
      for (const file of pack.manifest.files) {
        contract.assertResourcePath(file.path);
        const path = join(directory, file.path);
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, pack.entries.get(file.path)!);
      }
      onProgress(pack.archiveBytes.length);
      return 'unsigned-real-pack-test';
    }),
    (error: unknown) => {
      const original = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      rejection = original instanceof Error ? original.message : String(original);
      // 证明到了真实 bundle/签名拒绝，网络或 TUF 初始化失败不能冒充此断言通过。
      return /bundle|media.?type|signature/i.test(rejection);
    },
  );
  assert.equal(calls, 1);
  assert.equal(store.getStatus('official:epl-default').activeVersion, null);
  assert.equal(store.getStatus('official:epl-default').phase, 'failed');
  console.log(
    JSON.stringify({
      result: 'PASS: real unsigned pack refused by actual runtime',
      sourceSha,
      archiveBytes: pack.archive.bytes,
      resourceBytes: pack.manifest.files.reduce((sum, file) => sum + file.bytes, 0),
      files: pack.manifest.files.length,
      rejection,
      wallMs: performance.now() - started,
      limitation:
        'Online unsigned-install negative only; authenticated publication positive requires formal signing. Offline receipt cryptography is covered by app-integration.test.ts.',
    }),
  );
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
