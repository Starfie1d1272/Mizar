import { Buffer } from 'node:buffer';
import { createVerifier } from 'sigstore';
import { isSourceSha, isSha256, requireValue } from './index.mjs';
import { sha256 } from './content.mjs';
import { REPOSITORY } from './publication.mjs';
export const signerIdentity = (workflow) => {
  requireValue(['qualification', 'promotion'].includes(workflow), '不允许的 Mizar 签发角色');
  return `https://github.com/${REPOSITORY}/.github/workflows/release-${workflow}.yml@refs/heads/main`;
};
// Fulcio 通用 OID 值为 DER UTF8String；当前固定 URI/ref/SHA 均是短 ASCII 字符串。
// https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md
const derString = (value) => {
  const bytes = Buffer.from(value);
  requireValue(bytes.length < 128 && bytes.every((byte) => byte < 128), '证书策略字段无效');
  return Buffer.concat([Buffer.from([0x0c, bytes.length]), bytes]).toString('utf8');
};
export function mizarCertificatePolicy(workflow, sourceSha) {
  requireValue(isSourceSha(sourceSha), '证书策略必须绑定精确源码 SHA');
  const identity = signerIdentity(workflow);
  return {
    certificateIssuer: 'https://token.actions.githubusercontent.com',
    // sigstore 5 将此选项作为正则；转义并锚定，精确匹配 signer@main。
    certificateIdentityURI: `^${identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
    certificateOIDs: {
      '1.3.6.1.4.1.57264.1.12': derString(`https://github.com/${REPOSITORY}`),
      '1.3.6.1.4.1.57264.1.13': derString(sourceSha),
      '1.3.6.1.4.1.57264.1.14': derString('refs/heads/main'),
    },
  };
}
/** 沿用既有 issuer/CT/tlog/Sigstore TUF 根，并与 CLI 一致绑定证书 source-ref/digest。 */
export async function createMizarVerifier(workflow, sourceSha, tufCachePath) {
  return createVerifier({
    ...mizarCertificatePolicy(workflow, sourceSha),
    ctLogThreshold: 1,
    tlogThreshold: 1,
    tufCachePath,
    retry: 0,
    timeout: 5000,
  });
}
/** 供现有更新验证器共用的已配置 verifier 边界；资源生产入口不接收外部 verifier。 */
export function verifyMizarAttestation(bytes, name, bundle, verifier, workflow = 'qualification') {
  return verifyMizarAttestationDigest(sha256(bytes), name, bundle, verifier, workflow);
}
export function verifyMizarAttestationDigest(
  digest,
  name,
  bundle,
  verifier,
  workflow = 'qualification',
) {
  requireValue(isSha256(digest), '签名 subject 摘要无效');
  signerIdentity(workflow);
  verifier.verify(bundle);
  const envelope = bundle?.dsseEnvelope;
  requireValue(
    envelope?.payloadType === 'application/vnd.in-toto+json' &&
      typeof envelope.payload === 'string',
    '资源 provenance 信封无效',
  );
  const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  const definition = statement?.predicate?.buildDefinition,
    context = definition?.externalParameters?.workflow;
  requireValue(
    statement?._type === 'https://in-toto.io/Statement/v1' &&
      statement?.predicateType === 'https://slsa.dev/provenance/v1' &&
      context?.repository === `https://github.com/${REPOSITORY}` &&
      context?.path === `.github/workflows/release-${workflow}.yml` &&
      context?.ref === 'refs/heads/main',
    '资源 provenance 不是预期 main 工作流',
  );
  requireValue(
    Array.isArray(statement.subject) &&
      statement.subject.some(
        (subject) => subject.name === name && subject.digest?.sha256 === digest,
      ),
    '资源签名 subject 不等于实际字节',
  );
  requireValue(Array.isArray(definition.resolvedDependencies), '资源 provenance 缺少源码');
  const sources = definition.resolvedDependencies.filter(
    (dependency) => dependency.uri === `git+https://github.com/${REPOSITORY}@refs/heads/main`,
  );
  requireValue(
    sources.length === 1 && isSourceSha(sources[0]?.digest?.gitCommit),
    '资源 provenance 源码不唯一或无效',
  );
  return sources[0].digest.gitCommit;
}
