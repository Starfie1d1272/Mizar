import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parsePublication } from './statement.mjs';
import { makePublication } from './create.mjs';
import { verifyResourcePublicationBytes } from '../../../packages/resource-pack-contract/runtime.mjs';
import { verifyResourcePublication } from './verify.mjs';
import { buildOfficialPack, jsonBytes } from '../../asset-packs/pack.mjs';
import { releaseAttestationArgs } from '../release-identity.mjs';

const sourceSha = 'a'.repeat(40),
  promotionSha = 'b'.repeat(40);
const policy = {
  packVersion: '1.0.0',
  sourceSha,
  promotionSha,
  coreVersion: '1.1.0',
  minimumSequence: 4,
  now: Date.parse('2026-10-09T20:00:00Z'),
};
const declaration = {
  schemaVersion: 'mizar.resource-publication.v1',
  repository: 'Starfie1d1272/Mizar',
  packId: 'official:epl-default',
  packVersion: '1.0.0',
  sourceRef: 'refs/heads/main',
  sourceSha,
  promotionSha,
  contentKind: 'recorded-replay',
  compatibility: {
    resourceSchemaVersion: 1,
    minimumCoreVersion: '1.1.0',
    maximumCoreVersionExclusive: '2.0.0',
  },
  manifestSha256: 'c'.repeat(64),
  archive: {
    name: 'Mizar-official-epl-default-1.0.0.zip',
    format: 'zip',
    bytes: 300,
    sha256: 'd'.repeat(64),
  },
  sequence: 4,
  issuedAt: '2026-10-09T19:00:00Z',
  expiresAt: '2026-11-09T19:00:00Z',
};
describe('发行授权策略', () => {
  it('接受独立资源版本的结构；结构验证本身不签发可信结果', () => {
    expect(parsePublication(declaration, policy)).toBe(declaration);
  });
  it.each([
    ['repository', 'evil/Mizar'],
    ['packId', 'third-party:epl'],
    ['packVersion', '1.0.1'],
    ['sourceRef', 'refs/heads/feature'],
    ['sourceSha', 'e'.repeat(40)],
    ['promotionSha', 'f'.repeat(40)],
    ['sequence', 3],
    ['issuedAt', '2026-10-10T19:00:00Z'],
    ['expiresAt', '2026-10-09T20:00:00Z'],
    ['expiresAt', '2028-10-09T20:00:00Z'],
    ['contentKind', 'plugin'],
    ['manifestSha256', 'invalid'],
  ])('拒绝不可信身份、重放、过期或错误字段 %s', (key, value) => {
    expect(() => parsePublication({ ...declaration, [key]: value }, policy)).toThrow();
  });
  it('缺少外部固定策略时拒绝，而非信任镜像声称的最新 SHA', () => {
    expect(() => parsePublication(declaration, {})).toThrow();
  });
  it('现有签发验证参数固定 signer@main、source-ref 与精确源码', () => {
    const args = releaseAttestationArgs(
      'publication.json',
      promotionSha,
      'proof.json',
      'promotion',
    );
    expect(args).toEqual([
      'attestation',
      'verify',
      'publication.json',
      '--repo',
      'Starfie1d1272/Mizar',
      '--signer-workflow',
      'Starfie1d1272/Mizar/.github/workflows/release-promotion.yml@refs/heads/main',
      '--source-ref',
      'refs/heads/main',
      '--source-digest',
      promotionSha,
      '--bundle',
      'proof.json',
    ]);
  });
  it('真实归档配上自行生成声明与无签名证明也无法通过实际 gh 验证', async () => {
    execFileSync('gh', ['attestation', 'verify', '--help'], { stdio: 'pipe' });
    const root = new URL('../../../', import.meta.url).pathname;
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const pack = await buildOfficialPack(root, { packVersion: '1.0.0', sourceSha: sha });
    const statement = makePublication(pack, {
      promotionSha,
      sequence: 4,
      issuedAt: declaration.issuedAt,
      expiresAt: declaration.expiresAt,
    });
    const directory = await mkdtemp(join(tmpdir(), 'mizar-untrusted-resource-'));
    try {
      const statementPath = join(directory, 'statement.json'),
        archivePath = join(directory, 'pack.zip'),
        bundlePath = join(directory, 'fake-proof.json');
      await writeFile(statementPath, jsonBytes(statement));
      await writeFile(archivePath, pack.archiveBytes);
      await writeFile(bundlePath, '{}\n');
      await expect(
        verifyResourcePublication({
          statementPath,
          archivePath,
          publicationBundlePath: bundlePath,
          archiveBundlePath: bundlePath,
          policy: { ...policy, sourceSha: sha },
        }),
      ).rejects.toThrow();
      // 同一真实归档进入进程内入口；Sigstore 真实库拒绝无签名证明，未注入 verifier。
      await expect(
        verifyResourcePublicationBytes({
          statementBytes: jsonBytes(statement),
          archiveBytes: pack.archiveBytes,
          publicationBundleBytes: jsonBytes({}),
          archiveBundleBytes: jsonBytes({}),
          policy: { ...policy, sourceSha: sha },
          tufCachePath: join(directory, 'sigstore-cache'),
        }),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
