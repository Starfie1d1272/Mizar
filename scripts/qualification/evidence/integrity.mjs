import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  QUALIFICATION_CONTRACT,
  QUALIFICATION_REPOSITORY,
  QUALIFICATION_SCHEMA_VERSION,
  SHA256_PATTERN,
  SECRET_PATTERN,
  STEAM_LIKE_ID_PATTERN,
  QualificationEvidenceError,
} from './contract.mjs';

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new QualificationEvidenceError('INVALID_EVIDENCE', `${name} 必须是非空字符串`);
  }
  return value;
}

export async function readJson(path, code = 'INVALID_EVIDENCE') {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new QualificationEvidenceError(code, `无法读取 ${path}：${String(error)}`, error);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new QualificationEvidenceError(code, `${path} 不是有效 JSON：${String(error)}`, error);
  }
}

export async function readOptionalJson(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new QualificationEvidenceError(
      'INVALID_EVIDENCE',
      `无法访问 ${path}：${String(error)}`,
      error,
    );
  }
  return readJson(path);
}

export function assertUtc(value, name) {
  requireString(value, name);
  if (!Number.isFinite(Date.parse(value))) {
    throw new QualificationEvidenceError('INVALID_EVIDENCE', `${name} 必须是有效时间戳`);
  }
}

export function validateArtifact(artifact) {
  if (!isRecord(artifact))
    throw new QualificationEvidenceError('INVALID_EVIDENCE', '验收包身份文件必须是对象');
  if (artifact.developmentOnly === true)
    throw new QualificationEvidenceError('INVALID_EVIDENCE', '开发结构包不能作为真实环境验收产物');
  if (artifact.schemaVersion !== 1)
    throw new QualificationEvidenceError('INVALID_EVIDENCE', '验收包身份文件的格式版本不受支持');
  if (artifact.repository !== QUALIFICATION_REPOSITORY)
    throw new QualificationEvidenceError('INVALID_EVIDENCE', '验收包身份信息不属于 Mizar');
  requireString(artifact.gitSha, 'artifact.gitSha');
  assertUtc(artifact.buildTimestamp, 'artifact.buildTimestamp');
  if (artifact.platform !== 'win32-x64') {
    throw new QualificationEvidenceError(
      'INVALID_EVIDENCE',
      '验收包身份信息的平台必须是 win32-x64',
    );
  }
  if (artifact.nodeVersion !== QUALIFICATION_CONTRACT.nodeRuntimeVersion) {
    throw new QualificationEvidenceError(
      'INVALID_EVIDENCE',
      `验收包内置运行时必须是固定版本 ${QUALIFICATION_CONTRACT.nodeRuntimeVersion}`,
    );
  }
  if (artifact.qualificationSchemaVersion !== QUALIFICATION_SCHEMA_VERSION) {
    throw new QualificationEvidenceError('INVALID_EVIDENCE', '验收包的现场验收格式版本不受支持');
  }
  if (artifact.artifactSha256 !== undefined && !SHA256_PATTERN.test(artifact.artifactSha256)) {
    throw new QualificationEvidenceError('INVALID_EVIDENCE', '验收包身份摘要无效');
  }
  return artifact;
}

function scanForSecrets(value, path) {
  if (typeof value !== 'string') return;
  if (STEAM_LIKE_ID_PATTERN.test(value)) {
    throw new QualificationEvidenceError('SECRET_LEAK', `${path} 包含疑似 Steam 身份标识`);
  }
  if (SECRET_PATTERN.test(path) && value.length > 0) {
    throw new QualificationEvidenceError('SECRET_LEAK', `${path} 包含不应公开的敏感值`);
  }
}

export function scanJsonForSecrets(value, path = '$') {
  if (typeof value === 'string') {
    scanForSecrets(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanJsonForSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) scanJsonForSecrets(child, `${path}.${key}`);
  }
}

export async function walkFiles(root) {
  const output = [];
  async function visit(path) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'hashes.txt' || entry.name === '.qualification-local') continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) output.push(child);
    }
  }
  await visit(root);
  return output.sort();
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function verifyHashes(runDir) {
  const hashesPath = join(runDir, 'hashes.txt');
  try {
    await access(hashesPath);
  } catch {
    throw new QualificationEvidenceError('INVALID_HASHES', `缺少 ${hashesPath}`);
  }
  const text = await readFile(hashesPath, 'utf8');
  const entries = text.length === 0 ? [] : text.trimEnd().split('\n');
  const expectedPaths = new Set(
    (await walkFiles(runDir)).map((path) => relative(resolve(runDir), path).replaceAll('\\', '/')),
  );
  const seenPaths = new Set();
  for (const line of entries) {
    const match = /^(?<hash>[a-f0-9]{64})\x20{2}(?<path>.+)$/.exec(line);
    if (match?.groups === undefined)
      throw new QualificationEvidenceError('INVALID_HASHES', `无效的完整性摘要记录：${line}`);
    if (seenPaths.has(match.groups.path)) {
      throw new QualificationEvidenceError(
        'INVALID_HASHES',
        '完整性摘要路径重复：' + match.groups.path,
      );
    }
    seenPaths.add(match.groups.path);
    if (!expectedPaths.has(match.groups.path)) {
      throw new QualificationEvidenceError(
        'INVALID_HASHES',
        '完整性摘要列表包含意外路径：' + match.groups.path,
      );
    }
    const path = resolve(runDir, match.groups.path);
    const relativePath = relative(resolve(runDir), path);
    if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new QualificationEvidenceError(
        'INVALID_HASHES',
        `完整性摘要路径超出验收证据根目录：${match.groups.path}`,
      );
    }
    if ((await sha256File(path)) !== match.groups.hash) {
      throw new QualificationEvidenceError(
        'HASH_MISMATCH',
        `完整性摘要与文件不一致：${match.groups.path}`,
      );
    }
  }
  if (seenPaths.size !== expectedPaths.size) {
    const missing = [...expectedPaths].find((path) => !seenPaths.has(path));
    throw new QualificationEvidenceError(
      'INVALID_HASHES',
      '完整性摘要列表缺少 ' + (missing ?? '一个或多个验收证据文件'),
    );
  }
  return entries.length;
}
