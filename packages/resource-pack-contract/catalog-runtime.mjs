import { Buffer } from 'node:buffer';
import { requireValue } from './index.mjs';
import { sha256, jsonBytes } from './content.mjs';
import { RESOURCE_ASSET_NAMES, parseResourceCatalogBytes } from './catalog.mjs';
import {
  createMizarVerifier,
  verifyMizarAttestation,
  verifyMizarAttestationDigest,
} from './attestation.mjs';
import {
  captureTrustSnapshot,
  createOfflineMizarVerifier,
  RECEIPT_MAX_BYTES,
} from './trust-snapshot.mjs';
import { parsePublication } from './publication.mjs';
import { verifyResourcePublicationBytes, verifyResourceReceipt } from './runtime.mjs';

const authorizations = new WeakMap();
function snapshot(value, limit) {
  requireValue(
    Buffer.isBuffer(value) && value.length > 0 && value.length <= limit,
    '资源目录证据大小无效',
  );
  return Buffer.from(value);
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function decode(value, limit) {
  requireValue(
    typeof value === 'string' && value.length <= Math.ceil(limit / 3) * 4,
    '资源目录离线证据超限',
  );
  const bytes = Buffer.from(value, 'base64');
  requireValue(
    bytes.length > 0 && bytes.length <= limit && bytes.toString('base64') === value,
    '资源目录离线证据编码无效',
  );
  return bytes;
}
function parse(bytes, expectedCore, purpose) {
  const parsed = parseResourceCatalogBytes(bytes.descriptorBytes, bytes.catalogBytes, expectedCore);
  const publication = parsed.catalog.authorization ?? parsed.entry.publication;
  const now = Date.now();
  requireValue(
    Date.parse(publication.issuedAt) <= now &&
      (['cache', 'rollback'].includes(purpose) || now < Date.parse(publication.expiresAt)),
    '资源目录已过期或尚未生效',
  );
  return parsed;
}
function verifyProofs(bytes, parsed, qualification, promotion) {
  requireValue(
    verifyMizarAttestation(
      bytes.descriptorBytes,
      RESOURCE_ASSET_NAMES.descriptor,
      JSON.parse(bytes.descriptorBundleBytes.toString('utf8')),
      qualification,
    ) === parsed.descriptor.core.gitSha,
    '资源资格目录签名源码不符',
  );
  requireValue(
    verifyMizarAttestation(
      bytes.catalogBytes,
      RESOURCE_ASSET_NAMES.catalog,
      JSON.parse(bytes.catalogBundleBytes.toString('utf8')),
      promotion,
      'promotion',
    ) === parsed.catalog.promotionSha,
    '资源晋级目录签名源码不符',
  );
}
function authorize(parsed, receipt) {
  const identity = freeze({
    core: parsed.catalog.core,
    policy: { ...parsed.entry.policy, now: Date.now() },
    manifestSha256: parsed.entry.manifestSha256,
    archive: parsed.entry.archive,
    publication: parsed.entry.publication,
    assets: parsed.entry.assets,
    descriptorSha256: parsed.catalog.descriptorSha256,
    ...(parsed.catalog.origin
      ? { origin: parsed.catalog.origin, authorization: parsed.catalog.authorization }
      : {}),
  });
  const handle = Object.freeze({ schemaVersion: 'mizar.authenticated-resource-catalog.v1' });
  authorizations.set(handle, { identity, receipt: freeze(receipt) });
  return handle;
}
/** Only handles produced by real fixed-root verification can supply installer policy. */
export function getResourceAuthorization(authorization) {
  const verified = authorization && authorizations.get(authorization);
  requireValue(verified, '必须先认证原 Qualification descriptor 与 Promotion catalog');
  return verified.identity;
}
export async function verifyResourceCatalogBytes({
  descriptorBytes,
  descriptorBundleBytes,
  catalogBytes,
  catalogBundleBytes,
  expectedCore,
  tufCachePath,
  signal,
}) {
  requireValue(
    typeof tufCachePath === 'string' && tufCachePath.length > 0,
    '资源目录安装必须提供应用 TUF 持久目录',
  );
  const bytes = {
    descriptorBytes: snapshot(descriptorBytes, 65536),
    catalogBytes: snapshot(catalogBytes, 65536),
    descriptorBundleBytes: snapshot(descriptorBundleBytes, RECEIPT_MAX_BYTES),
    catalogBundleBytes: snapshot(catalogBundleBytes, RECEIPT_MAX_BYTES),
  };
  expectedCore = { ...expectedCore };
  const parsed = parse(bytes, expectedCore, 'install');
  signal?.throwIfAborted();
  const qualification = await createMizarVerifier(
    'qualification',
    parsed.descriptor.core.gitSha,
    tufCachePath,
  );
  signal?.throwIfAborted();
  const promotion = await createMizarVerifier(
    'promotion',
    parsed.catalog.promotionSha,
    tufCachePath,
  );
  signal?.throwIfAborted();
  verifyProofs(bytes, parsed, qualification, promotion);
  const trust = await captureTrustSnapshot(tufCachePath, signal);
  const receipt = {
    schemaVersion: 'mizar.resource-catalog-receipt.v1',
    descriptorBase64: bytes.descriptorBytes.toString('base64'),
    descriptorBundleBase64: bytes.descriptorBundleBytes.toString('base64'),
    catalogBase64: bytes.catalogBytes.toString('base64'),
    catalogBundleBase64: bytes.catalogBundleBytes.toString('base64'),
    trust,
  };
  // Prove persisted evidence is usable before returning policy or downloading a Pack.
  return verifyResourceCatalogReceipt({ receipt, expectedCore, purpose: 'cache', signal });
}
export async function verifyResourceCatalogReceipt({
  receipt,
  expectedCore,
  purpose = 'cache',
  tufCachePath,
  signal,
}) {
  requireValue(
    ['install', 'legacy', 'cache', 'rollback'].includes(purpose),
    '资源目录验证用途无效',
  );
  const serialized = JSON.stringify(receipt);
  requireValue(
    typeof serialized === 'string' && Buffer.byteLength(serialized) <= RECEIPT_MAX_BYTES,
    '资源目录 receipt 超限',
  );
  receipt = JSON.parse(serialized);
  requireValue(
    receipt?.schemaVersion === 'mizar.resource-catalog-receipt.v1',
    '资源目录 receipt 版本无效',
  );
  const bytes = {
    descriptorBytes: decode(receipt.descriptorBase64, 65536),
    catalogBytes: decode(receipt.catalogBase64, 65536),
    descriptorBundleBytes: decode(receipt.descriptorBundleBase64, RECEIPT_MAX_BYTES),
    catalogBundleBytes: decode(receipt.catalogBundleBase64, RECEIPT_MAX_BYTES),
  };
  const parsed = parse(bytes, { ...expectedCore }, purpose);
  signal?.throwIfAborted();
  verifyProofs(
    bytes,
    parsed,
    createOfflineMizarVerifier(receipt.trust, 'qualification', parsed.descriptor.core.gitSha),
    createOfflineMizarVerifier(receipt.trust, 'promotion', parsed.catalog.promotionSha),
  );
  signal?.throwIfAborted();
  if (purpose === 'install' || purpose === 'legacy') {
    const qualification = await createMizarVerifier(
      'qualification',
      parsed.descriptor.core.gitSha,
      tufCachePath,
    );
    signal?.throwIfAborted();
    const promotion = await createMizarVerifier(
      'promotion',
      parsed.catalog.promotionSha,
      tufCachePath,
    );
    signal?.throwIfAborted();
    verifyProofs(bytes, parsed, qualification, promotion);
  }
  return authorize(parsed, receipt);
}
export async function verifyCatalogResourcePublicationBytes({ authorization, ...inputs }) {
  const identity = getResourceAuthorization(authorization);
  const statementBytes = snapshot(inputs.statementBytes, 65536);
  requireValue(
    sha256(statementBytes) === identity.publication.sha256,
    '资源声明不是签名目录绑定的原字节',
  );
  const verified = await verifyResourcePublicationBytes({
    ...inputs,
    statementBytes,
    policy: { ...identity.policy, now: Date.now() },
    authorization,
  });
  requireValue(
    statementBytes.equals(jsonBytes(verified.statement)) &&
      ['sequence', 'issuedAt', 'expiresAt'].every(
        (key) => verified.statement[key] === identity.publication[key],
      ) &&
      verified.manifestSha256 === identity.manifestSha256 &&
      verified.archive.sha256 === identity.archive.sha256 &&
      verified.archive.bytes === identity.archive.bytes,
    '资源 manifest、归档或规范声明不属于已认证目录',
  );
  const receipt = { ...verified.receipt, catalog: authorizations.get(authorization).receipt };
  requireValue(
    Buffer.byteLength(JSON.stringify(receipt)) <= RECEIPT_MAX_BYTES,
    '带目录双证据的资源 receipt 超限',
  );
  return { ...verified, receipt };
}

/** Refresh only Core compatibility authorization; retain original content and signer evidence. */
export async function authorizeCachedResource({ authorization, receipt, signal }) {
  const identity = getResourceAuthorization(authorization);
  requireValue(identity.origin?.publication, '此目录未明确授权复用原始发行声明');
  const previous = globalThis.structuredClone(receipt);
  const replacement = {
    ...previous,
    catalog: previous.catalog ?? authorizations.get(authorization).receipt,
    catalogHistory: [authorizations.get(authorization).receipt, ...(previous.catalogHistory ?? [])]
      .filter(
        (item, index, all) =>
          item &&
          (index === 0 ||
            (() => {
              const core = JSON.parse(decode(item.descriptorBase64, 65536).toString('utf8')).core;
              return (
                core.appVersion !== identity.core.appVersion || core.gitSha !== identity.core.gitSha
              );
            })()) &&
          JSON.stringify(item) !== JSON.stringify(previous.catalog) &&
          all.findIndex((other) => JSON.stringify(other) === JSON.stringify(item)) === index,
      )
      .slice(0, 2),
  };
  const manifest = await verifyResourceReceipt({
    receipt: replacement,
    expectedCore: identity.core,
    purpose: 'cache',
    signal,
  });
  return { manifest, receipt: replacement };
}

/** Authenticate all small original messages before requesting the resource ZIP. */
export async function verifyCatalogResourceMetadata({
  authorization,
  statementBytes,
  publicationBundleBytes,
  archiveBundleBytes,
  tufCachePath,
  signal,
}) {
  const identity = getResourceAuthorization(authorization);
  const declaration = snapshot(statementBytes, 65536);
  const statement = parsePublication(
    JSON.parse(declaration.toString('utf8')),
    { ...identity.policy, now: Date.now() },
    { purpose: identity.origin?.publication ? 'cache' : 'install' },
  );
  requireValue(
    sha256(declaration) === identity.publication.sha256 &&
      declaration.equals(jsonBytes(statement)) &&
      statement.manifestSha256 === identity.manifestSha256 &&
      ['name', 'bytes', 'sha256', 'format'].every(
        (key) => statement.archive[key] === identity.archive[key],
      ) &&
      ['sequence', 'issuedAt', 'expiresAt'].every(
        (key) => statement[key] === identity.publication[key],
      ),
    '原资源声明不等于当前签名目录',
  );
  signal?.throwIfAborted();
  const publicationVerifier = await createMizarVerifier(
    'promotion',
    statement.promotionSha,
    tufCachePath,
  );
  requireValue(
    verifyMizarAttestation(
      declaration,
      RESOURCE_ASSET_NAMES.publication,
      JSON.parse(snapshot(publicationBundleBytes, RECEIPT_MAX_BYTES).toString('utf8')),
      publicationVerifier,
      'promotion',
    ) === statement.promotionSha,
    '原资源发行签名身份不符',
  );
  signal?.throwIfAborted();
  const archiveVerifier = await createMizarVerifier(
    'qualification',
    statement.sourceSha,
    tufCachePath,
  );
  requireValue(
    verifyMizarAttestationDigest(
      statement.archive.sha256,
      statement.archive.name,
      JSON.parse(snapshot(archiveBundleBytes, RECEIPT_MAX_BYTES).toString('utf8')),
      archiveVerifier,
    ) === statement.sourceSha,
    '原资源归档签名身份不符',
  );
  signal?.throwIfAborted();
  return statement;
}
