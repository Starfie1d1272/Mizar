import { Buffer } from 'node:buffer';
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import seeds from '@sigstore/tuf/seeds.json' with { type: 'json' };
import { Metadata, MetadataKind } from '@tufjs/models';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import { Verifier, toSignedEntity, toTrustMaterial } from '@sigstore/verify';
import { bundleFromJSON } from '@sigstore/bundle';
import { requireValue } from './index.mjs';
import { sha256 } from './content.mjs';
import { mizarCertificatePolicy } from './attestation.mjs';
const repository = 'https://tuf-repo-cdn.sigstore.dev';
const seed = seeds[repository];
const MAX_METADATA = 64 * 1024;
const encode = (bytes) => bytes.toString('base64');
export const RECEIPT_MAX_BYTES = 2 * 1024 * 1024;
function decode(value) {
  requireValue(
    typeof value === 'string' && value.length <= Math.ceil(MAX_METADATA / 3) * 4,
    '离线信任材料大小无效',
  );
  const bytes = Buffer.from(value, 'base64');
  requireValue(
    bytes.length > 0 && bytes.length <= MAX_METADATA && encode(bytes) === value,
    '离线信任材料编码无效',
  );
  return bytes;
}
function metadata(role, bytes) {
  return Metadata.fromJSON(role, JSON.parse(bytes.toString('utf8')));
}
/** receipt 里的所有材料均不可信；必须从固定 SDK seed 验证 root 轮换和签名 target。不联网、不接受替换根。 */
export function verifyTrustSnapshot(snapshot) {
  requireValue(
    snapshot?.schemaVersion === 'mizar.sigstore-cache.v1' &&
      Array.isArray(snapshot.rootChain) &&
      snapshot.rootChain.length <= 32,
    '离线信任证据版本或链长度无效',
  );
  let root = metadata(MetadataKind.Root, Buffer.from(seed['root.json'], 'base64'));
  for (const encoded of snapshot.rootChain) {
    const next = metadata(MetadataKind.Root, decode(encoded));
    requireValue(next.signed.version === root.signed.version + 1, '离线根轮换不连续');
    root.verifyDelegate(MetadataKind.Root, next);
    next.verifyDelegate(MetadataKind.Root, next);
    root = next;
  }
  const targets = metadata(MetadataKind.Targets, decode(snapshot.targetsBase64));
  root.verifyDelegate(MetadataKind.Targets, targets);
  const target = targets.signed.targets['trusted_root.json'],
    material = decode(snapshot.trustedRootBase64);
  requireValue(
    target && target.length === material.length && target.hashes.sha256 === sha256(material),
    '离线 Sigstore 材料不等于已签 target',
  );
  // 只用于已授权缓存的历史签名：不把 TUF 元数据到期等同于已安装数据撤销。
  // 新安装仍先使用 SDK 的在线 TUF freshness 验证，不能通过此函数取得新安装资格。
  return TrustedRoot.fromJSON(JSON.parse(material.toString('utf8')));
}
export function createOfflineMizarVerifier(snapshot, workflow, sourceSha) {
  const material = verifyTrustSnapshot(snapshot),
    policy = mizarCertificatePolicy(workflow, sourceSha);
  const engine = new Verifier(toTrustMaterial(material), { ctlogThreshold: 1, tlogThreshold: 1 });
  return {
    verify(bundle) {
      return engine.verify(toSignedEntity(bundleFromJSON(bundle)), {
        subjectAlternativeName: policy.certificateIdentityURI,
        extensions: { issuer: policy.certificateIssuer },
        oids: Object.entries(policy.certificateOIDs).map(([oid, value]) => ({
          oid: { id: oid.split('.').map(Number) },
          value: Buffer.from(value),
        })),
      });
    },
  };
}
async function boundedFile(path) {
  const stat = await lstat(path);
  requireValue(
    stat.isFile() && stat.size > 0 && stat.size <= MAX_METADATA,
    'TUF 缓存文件类型或大小无效',
  );
  const bytes = await readFile(path);
  requireValue(bytes.length === stat.size, 'TUF 缓存读取时变化');
  return bytes;
}
/** 在线安装已经完成 SDK TUF 验证后，捕获可持久化的公开签名证据；不是自报可信 hash。 */
export async function captureTrustSnapshot(tufCachePath, signal) {
  requireValue(
    typeof tufCachePath === 'string' && tufCachePath.length > 0,
    '资源安装必须提供应用持有的 TUF 持久目录',
  );
  const directory = join(tufCachePath, 'tuf-repo-cdn.sigstore.dev');
  const cachedRoot = metadata(MetadataKind.Root, await boundedFile(join(directory, 'root.json')));
  const initial = metadata(MetadataKind.Root, Buffer.from(seed['root.json'], 'base64'));
  requireValue(
    cachedRoot.signed.version >= initial.signed.version &&
      cachedRoot.signed.version - initial.signed.version <= 32,
    'TUF 缓存根不在固定 seed 的可验证范围',
  );
  const rootChain = [];
  for (let version = initial.signed.version + 1; version <= cachedRoot.signed.version; version++) {
    signal?.throwIfAborted();
    const response = await globalThis.fetch(`${repository}/${version}.root.json`, {
      redirect: 'error',
      signal: signal
        ? globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(5000)])
        : globalThis.AbortSignal.timeout(5000),
    });
    requireValue(response.status === 200 && response.body, '无法保留 Sigstore 已签根轮换证据');
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      requireValue(total <= MAX_METADATA, 'Sigstore 根轮换证据超限');
      chunks.push(chunk);
    }
    rootChain.push(encode(Buffer.concat(chunks, total)));
  }
  const snapshot = {
    schemaVersion: 'mizar.sigstore-cache.v1',
    rootChain,
    targetsBase64: encode(await boundedFile(join(directory, 'targets.json'))),
    trustedRootBase64: encode(await boundedFile(join(directory, 'targets/trusted_root.json'))),
  };
  verifyTrustSnapshot(snapshot);
  return snapshot;
}
