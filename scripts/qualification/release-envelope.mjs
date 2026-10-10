import { readFile, readdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { assertPublication, assertPublishedAssets } from './update-publication.mjs';
import { releaseAttestationArgs } from './release-identity.mjs';
import { validateReleaseTag } from './app-version.mjs';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireValue = (ok, message) => {
  if (!ok) throw new Error(message);
};
const maximum = 64 * 1024 * 1024;
const namePattern =
  /^(?:(?:product|resources|evidence)\/[A-Za-z0-9][A-Za-z0-9_.-]{0,180}\.(?:json|txt|zip|sha256)|promotion-(?:identity|ci|records-provenance)\.json|update-publication(?:-provenance)?\.json)$/;
export function evidenceName(version) {
  validateReleaseTag(`v${version}`, version);
  return `Mizar-v${version}-evidence.zip`;
}
export function makeUpdateIndex(
  manifestBytes,
  provenanceBytes,
  publicationBytes,
  publicationProvenanceBytes,
) {
  for (const bytes of [manifestBytes, publicationBytes])
    requireValue(bytes.length <= 65536, '更新清单或发布确认超限');
  for (const bytes of [provenanceBytes, publicationProvenanceBytes])
    requireValue(bytes.length <= 2097152, '更新证明超限');
  const manifest = JSON.parse(manifestBytes);
  assertPublication(JSON.parse(publicationBytes), manifestBytes, manifest);
  const bytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 'mizar.update-index.v2',
      manifestBase64: manifestBytes.toString('base64'),
      provenance: JSON.parse(provenanceBytes),
      publicationBase64: publicationBytes.toString('base64'),
      publicationProvenance: JSON.parse(publicationProvenanceBytes),
    }) + '\n',
  );
  requireValue(bytes.length <= 2097152, '更新信封超限');
  return bytes;
}

// Standard ZIP is a transport only. Original signed files remain byte-exact,
// and consumers must verify their existing fixed-main proofs, not this container.
const zipProgram = `import sys,json,base64,zipfile,io,stat
mode=sys.argv[1]
if mode=='encode':
 entries=json.load(sys.stdin)
 out=io.BytesIO()
 with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_STORED) as z:
  for name,data in sorted(entries.items()):
   info=zipfile.ZipInfo(name,date_time=(1980,1,1,0,0,0))
   info.external_attr=0o100644<<16
   z.writestr(info,base64.b64decode(data,validate=True))
 sys.stdout.buffer.write(out.getvalue())
else:
 data=sys.stdin.buffer.read(67108865)
 if len(data)>67108864: raise ValueError('archive limit')
 entries={}
 with zipfile.ZipFile(io.BytesIO(data)) as z:
  infos=z.infolist()
  if len(infos)>64 or sum(i.file_size for i in infos)>67108864: raise ValueError('expanded limit')
  folded=set()
  for i in infos:
   if i.filename.casefold() in folded or i.is_dir() or stat.S_ISLNK(i.external_attr>>16) or i.flag_bits&1: raise ValueError('invalid entry')
   if i.file_size>33554432: raise ValueError('entry limit')
   folded.add(i.filename.casefold())
   entries[i.filename]=base64.b64encode(z.read(i)).decode('ascii')
 json.dump(entries,sys.stdout,separators=(',',':'))
`;
function zip(mode, bytes) {
  return execFileSync(
    process.platform === 'win32' ? 'python' : 'python3',
    ['-c', zipProgram, mode],
    { input: bytes, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: maximum * 2, timeout: 60000 },
  );
}
function checkEntries(entries) {
  requireValue(entries.size > 0 && entries.size <= 64, '证据文件数量无效');
  let total = 0;
  const folded = new Set();
  for (const [name, bytes] of entries) {
    requireValue(
      namePattern.test(name) && !name.includes('..') && bytes.length <= 32 * 1024 * 1024,
      '证据路径、类型或大小无效',
    );
    requireValue(!folded.has(name.toLowerCase()), '证据路径重复');
    folded.add(name.toLowerCase());
    total += bytes.length;
  }
  requireValue(total <= maximum, '证据总字节超限');
}
export function encodeEvidence(entries) {
  checkEntries(entries);
  const bytes = zip(
    'encode',
    Buffer.from(
      JSON.stringify(
        Object.fromEntries([...entries].map(([name, bytes]) => [name, bytes.toString('base64')])),
      ),
    ),
  );
  requireValue(bytes.length <= maximum, '证据归档超限');
  return bytes;
}
export function decodeEvidence(bytes) {
  requireValue(bytes.length <= maximum, '证据归档超限');
  const entries = new Map(
    Object.entries(JSON.parse(zip('decode', bytes))).map(([name, data]) => [
      name,
      Buffer.from(data, 'base64'),
    ]),
  );
  checkEntries(entries);
  return entries;
}
export async function productAssets(product) {
  const manifest = JSON.parse(await readFile(join(product, 'release-manifest.json')));
  const distribution = JSON.parse(await readFile(join(product, 'distribution-manifest.json')));
  validateReleaseTag(`v${manifest.appVersion}`, manifest.appVersion);
  requireValue(
    manifest.archive === `Mizar-v${manifest.appVersion}-Windows-x64.zip` &&
      distribution.archive === `Mizar-v${manifest.appVersion}-Windows-x64-Setup.exe` &&
      distribution.installerLicense === 'NSIS-LICENSE.txt' &&
      distribution.gitSha === manifest.gitSha &&
      distribution.appVersion === manifest.appVersion &&
      distribution.originalArchiveSha256 === manifest.archiveSha256,
    '产品资产必须绑定同一完整资格候选',
  );
  const names = [manifest.archive, distribution.archive, distribution.installerLicense];
  if (/^\d+\.\d+\.\d+$/.test(manifest.appVersion)) names.push('update-manifest.json');
  requireValue(
    names.every((name) => typeof name === 'string' && !/[/\\]/.test(name)) &&
      new Set(names).size === names.length,
    '产品资产名称无效',
  );
  return names.map((name) => join(product, name));
}
export async function collectEvidence(product, evidence, resources, includePromotion = true) {
  const entries = new Map();
  for (const [folder, prefix] of [
    [product, 'product'],
    [evidence, 'evidence'],
    ...(resources ? [[resources, 'resources']] : []),
  ]) {
    for (const file of await readdir(folder, { withFileTypes: true })) {
      requireValue(file.isFile(), '证据输入必须为普通文件');
      if (prefix === 'product' && /\.(zip|exe)$/.test(file.name)) continue;
      if (prefix === 'resources' && file.name.endsWith('.zip')) continue;
      const bytes = await readFile(join(folder, file.name));
      entries.set(`${prefix}/${file.name}`, bytes);
    }
  }
  if (!includePromotion) {
    checkEntries(entries);
    return entries;
  }
  for (const name of [
    'promotion-identity.json',
    'promotion-ci.json',
    'promotion-records-provenance.json',
    'update-publication.json',
    'update-publication-provenance.json',
  ]) {
    if (
      name.startsWith('update-') &&
      !/^\d+\.\d+\.\d+$/.test(JSON.parse(entries.get('product/release-manifest.json')).appVersion)
    )
      continue;
    entries.set(name, await readFile(name));
  }
  checkEntries(entries);
  requireValue(entries.has('product/qualification-provenance.json'), '缺少原资格证明');
  return entries;
}
export async function verifyEvidencePublication(entries, release) {
  const manifestBytes = entries.get('product/update-manifest.json');
  if (!manifestBytes) {
    requireValue(release.prerelease, '正式版本缺少更新清单');
    return;
  }
  const publicationBytes = entries.get('update-publication.json');
  requireValue(
    publicationBytes && entries.has('update-publication-provenance.json'),
    '缺少原发布确认或证明',
  );
  const manifest = JSON.parse(manifestBytes),
    publication = JSON.parse(publicationBytes);
  assertPublication(publication, manifestBytes, manifest);
  requireValue(
    publication.releaseId === release.id && publication.publishedAt === release.published_at,
    '发布确认属于不同 Release',
  );
  const temporary = await mkdtemp(join(tmpdir(), 'mizar-evidence-proof-'));
  try {
    for (const [name, bytes] of [
      ['update-manifest.json', manifestBytes],
      ['qualification-provenance.json', entries.get('product/update-provenance.json')],
      ['update-publication.json', publicationBytes],
      ['publication-provenance.json', entries.get('update-publication-provenance.json')],
    ]) {
      requireValue(bytes, '证据缺少原证明');
      await writeFile(join(temporary, name), bytes);
    }
    execFileSync(
      'gh',
      releaseAttestationArgs(
        join(temporary, 'update-manifest.json'),
        manifest.gitSha,
        join(temporary, 'qualification-provenance.json'),
      ),
      { stdio: 'pipe', timeout: 60000 },
    );
    execFileSync(
      'gh',
      releaseAttestationArgs(
        join(temporary, 'update-publication.json'),
        publication.promotionSha,
        join(temporary, 'publication-provenance.json'),
        'promotion',
      ),
      { stdio: 'pipe', timeout: 60000 },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, product, evidence, resources, output, releasePath] = process.argv.slice(2);
  if (mode === 'assets') {
    const entries = await collectEvidence(product, evidence, undefined, false);
    const manifest = JSON.parse(entries.get('product/release-manifest.json'));
    await verifyCoreEvidence(entries, manifest.gitSha);
    console.log(JSON.stringify(await productAssets(product)));
  } else if (mode === 'finalize') {
    const entries = await collectEvidence(
      product,
      evidence,
      resources === '-' ? undefined : resources,
    );
    const manifest = JSON.parse(entries.get('product/release-manifest.json'));
    const release = JSON.parse(await readFile(releasePath));
    await verifyCoreEvidence(entries, manifest.gitSha);
    await verifyPromotionEvidence(entries, process.env.GITHUB_SHA);
    await verifyEvidencePublication(entries, release);
    await writeFile(join(output, evidenceName(manifest.appVersion)), encodeEvidence(entries), {
      flag: 'wx',
    });
    if (entries.has('product/update-manifest.json'))
      await writeFile(
        join(output, 'update-index.json'),
        makeUpdateIndex(
          entries.get('product/update-manifest.json'),
          entries.get('product/update-provenance.json'),
          entries.get('update-publication.json'),
          entries.get('update-publication-provenance.json'),
        ),
        { flag: 'wx' },
      );
  } else
    throw new Error(
      'release-envelope: assets product | finalize product evidence resources-or-dash output',
    );
}

export async function verifyCoreEvidence(entries, sourceSha) {
  const temporary = await mkdtemp(join(tmpdir(), 'mizar-core-proof-'));
  try {
    const proof = entries.get('product/qualification-provenance.json');
    requireValue(proof && proof.length <= 2097152, '缺少有界原资格证明');
    await writeFile(join(temporary, 'proof.json'), proof);
    for (const name of ['release-manifest.json', 'distribution-manifest.json']) {
      const bytes = entries.get(`product/${name}`);
      requireValue(bytes && bytes.length <= 65536, '缺少原产品清单');
      await writeFile(join(temporary, name), bytes);
      execFileSync(
        'gh',
        releaseAttestationArgs(join(temporary, name), sourceSha, join(temporary, 'proof.json')),
        { stdio: 'pipe', timeout: 60000 },
      );
    }
    const manifest = JSON.parse(entries.get('product/release-manifest.json'));
    const originalEvidence = `Mizar-${manifest.label}-evidence.zip`;
    requireValue(
      /^[A-Za-z0-9_.-]{1,180}$/.test(originalEvidence) && !originalEvidence.includes('..'),
      '原资格证据名称无效',
    );
    const evidence = entries.get(`evidence/${originalEvidence}`);
    requireValue(evidence && evidence.length <= 33554432, '缺少原资格验收证据');
    await writeFile(join(temporary, originalEvidence), evidence);
    execFileSync(
      'gh',
      releaseAttestationArgs(
        join(temporary, originalEvidence),
        sourceSha,
        join(temporary, 'proof.json'),
      ),
      { stdio: 'pipe', timeout: 60000 },
    );
    const distribution = JSON.parse(entries.get('product/distribution-manifest.json'));
    const license = entries.get('product/NSIS-LICENSE.txt');
    requireValue(
      distribution.installerLicense === 'NSIS-LICENSE.txt' &&
        license &&
        sha256(license) === distribution.installerLicenseSha256,
      '许可与已签分发清单不一致',
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function verifyCompactExisting(release, ref, identity, product, evidence) {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-existing-evidence-'));
  try {
    const name = evidenceName(identity.appVersion);
    const files = [name, ...(release.prerelease ? [] : ['update-index.json'])];
    for (const file of files) {
      const assets = release.assets.filter((a) => a.name === file);
      requireValue(
        assets.length === 1 &&
          assets[0].size > 0 &&
          assets[0].size <= (file.endsWith('.zip') ? maximum : 2097152),
        '发行缺少唯一持久证据或更新信封',
      );
      requireValue(
        assets[0].browser_download_url ===
          `https://github.com/Starfie1d1272/Mizar/releases/download/${identity.tag}/${file}`,
        '证据下载地址无效',
      );
      execFileSync(
        'gh',
        [
          'release',
          'download',
          identity.tag,
          '--repo',
          'Starfie1d1272/Mizar',
          '--pattern',
          file,
          '--dir',
          directory,
        ],
        { stdio: 'pipe', timeout: 60000 },
      );
      const bytes = await readFile(join(directory, file));
      assertPublishedAssets(release, ref, identity, [
        { name: file, size: bytes.length, sha256: sha256(bytes) },
      ]);
    }
    const entries = decodeEvidence(await readFile(join(directory, name)));
    // A retry verifies the immutable original promoter records, not new records.
    const originalIdentity = JSON.parse(entries.get('promotion-identity.json'));
    requireValue(
      originalIdentity.tag === identity.tag &&
        originalIdentity.gitSha === identity.gitSha &&
        originalIdentity.archiveSha256 === identity.archiveSha256 &&
        originalIdentity.contentDigest === identity.contentDigest,
      '证据的原晋级身份与候选不一致',
    );
    const expected = await collectEvidence(product, evidence, undefined, false);
    for (const [file, bytes] of expected)
      requireValue(entries.get(file)?.equals(bytes), `原资格字节不一致：${file}`);
    await verifyCoreEvidence(entries, identity.gitSha);
    await verifyPromotionEvidence(entries);
    await verifyEvidencePublication(entries, release);
    if (!release.prerelease) {
      const index = makeUpdateIndex(
        entries.get('product/update-manifest.json'),
        entries.get('product/update-provenance.json'),
        entries.get('update-publication.json'),
        entries.get('update-publication-provenance.json'),
      );
      requireValue(
        (await readFile(join(directory, 'update-index.json'))).equals(index),
        '更新信封与原证明不一致',
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function verifyPromotionEvidence(entries, expectedSource) {
  const proof = entries.get('promotion-records-provenance.json');
  requireValue(proof && proof.length <= 2097152, '缺少有界原晋级记录证明');
  // An untrusted hint is only a verifier constraint, never an accepted policy.
  const statement = JSON.parse(Buffer.from(JSON.parse(proof).dsseEnvelope.payload, 'base64'));
  const sources = statement.predicate.buildDefinition.resolvedDependencies.filter(
    (d) => d.uri === 'git+https://github.com/Starfie1d1272/Mizar@refs/heads/main',
  );
  requireValue(
    sources.length === 1 && /^[a-f0-9]{40}$/.test(sources[0].digest.gitCommit),
    '晋级记录来源无效',
  );
  const source = sources[0].digest.gitCommit;
  requireValue(!expectedSource || source === expectedSource, '晋级记录不是本次 main 精确源码');
  const manifest = JSON.parse(entries.get('product/release-manifest.json'));
  const identity = JSON.parse(entries.get('promotion-identity.json'));
  const ci = JSON.parse(entries.get('promotion-ci.json'));
  requireValue(
    ci.gitSha === manifest.gitSha &&
      Number.isSafeInteger(ci.runId) &&
      ci.runId > 0 &&
      Number.isSafeInteger(ci.runAttempt) &&
      ci.runAttempt > 0 &&
      ci.url === `https://github.com/Starfie1d1272/Mizar/actions/runs/${ci.runId}`,
    '原晋级 CI 记录与资格源码不一致',
  );
  requireValue(
    identity.tag === `v${manifest.appVersion}` &&
      identity.appVersion === manifest.appVersion &&
      identity.gitSha === manifest.gitSha &&
      identity.archive === manifest.archive &&
      identity.archiveSha256 === manifest.archiveSha256 &&
      identity.contentDigest === manifest.contentDigest,
    '原晋级记录与已验资格产品不一致',
  );
  if (entries.has('update-publication.json')) {
    const publication = JSON.parse(entries.get('update-publication.json'));
    requireValue(publication.promotionSha === source, '发布确认与晋级记录来源不一致');
  }
  const directory = await mkdtemp(join(tmpdir(), 'mizar-promotion-proof-'));
  try {
    await writeFile(join(directory, 'proof.json'), proof);
    for (const name of ['promotion-identity.json', 'promotion-ci.json']) {
      const bytes = entries.get(name);
      requireValue(bytes && bytes.length <= 2097152, '缺少有界原晋级记录');
      await writeFile(join(directory, name), bytes);
      execFileSync(
        'gh',
        releaseAttestationArgs(
          join(directory, name),
          source,
          join(directory, 'proof.json'),
          'promotion',
        ),
        { stdio: 'pipe', timeout: 60000 },
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
