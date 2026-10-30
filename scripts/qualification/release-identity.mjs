import { execFile, execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { promisify } from 'node:util';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeLogText } from './product-logs.mjs';

const REPOSITORY = 'Starfie1d1272/Mizar';
const MAIN_REF = 'refs/heads/main';
const QUALIFICATION_WORKFLOW = '.github/workflows/release-qualification.yml';
const PROMOTION_WORKFLOW = '.github/workflows/release-promotion.yml';
const isSha = (sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha);

function assertMainWorkflow(context, checkedOutSha, workflow) {
  if (
    context.repository !== REPOSITORY ||
    context.ref !== MAIN_REF ||
    !(
      context.event === 'workflow_dispatch' ||
      (workflow === PROMOTION_WORKFLOW && context.event === 'workflow_run')
    ) ||
    context.workflowRef !== `${REPOSITORY}/${workflow}@${MAIN_REF}` ||
    !isSha(context.sha) ||
    checkedOutSha !== context.sha
  )
    throw new Error('发布工作流必须来自 main，checkout 必须等于本次工作流源码 SHA');
}

export function assertQualificationIdentity(context, checkedOutSha, requestedSha, manifestSha) {
  assertMainWorkflow(context, checkedOutSha, QUALIFICATION_WORKFLOW);
  if (requestedSha !== context.sha || (manifestSha !== undefined && manifestSha !== context.sha))
    throw new Error('候选、请求源码与签发工作流 SHA 必须一致');
  return context.sha;
}

export function assertQualificationRun(run, sourceSha) {
  if (
    !isSha(sourceSha) ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.event !== 'workflow_dispatch' ||
    run.path !== QUALIFICATION_WORKFLOW ||
    run.head_branch !== 'main' ||
    run.head_repository?.full_name !== REPOSITORY ||
    run.head_sha !== sourceSha
  )
    throw new Error('资格任务必须是 main 上产品精确源码的成功签发任务');
}

export function releaseAttestationArgs(file, sourceSha, bundle, workflow = 'qualification') {
  if (!isSha(sourceSha)) throw new Error('来源证明必须绑定有效产品源码 SHA');
  if (!['qualification', 'promotion'].includes(workflow)) throw new Error('非法签发工作流');
  return [
    'attestation',
    'verify',
    file,
    '--repo',
    REPOSITORY,
    '--signer-workflow',
    `${REPOSITORY}/.github/workflows/release-${workflow}.yml@${MAIN_REF}`,
    '--source-ref',
    MAIN_REF,
    '--source-digest',
    sourceSha,
    ...(bundle ? ['--bundle', bundle] : []),
  ];
}

// gh processes share its default TUF cache. Keep verification serial, including
// resource archive/publication pairs; parallel downloads do not use this owner.
export async function verifyReleaseAttestations(subjects, execute = promisify(execFile)) {
  if (!Array.isArray(subjects) || subjects.length === 0) throw new Error('缺少待验证原始资产');
  const argumentsBySubject = subjects.map(({ file, sourceSha, bundle, workflow }) =>
    releaseAttestationArgs(file, sourceSha, bundle, workflow),
  );
  for (const args of argumentsBySubject) {
    try {
      await execute('gh', args, {
        timeout: 60000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        // Verbose includes the otherwise hidden initialization warning. Never
        // inherit GH_DEBUG=api, which would dump request headers and bodies.
        env: { ...process.env, GH_DEBUG: '1' },
      });
    } catch (error) {
      const diagnostics = [error.stdout, error.stderr].filter(Boolean).join('\n') || error.message;
      // eslint-disable-next-line preserve-caught-error -- Raw gh errors retain credentials and signed URLs; preserve only sanitized diagnostics.
      throw new Error(
        safeLogText(
          `gh attestation verification failed (code=${error.code ?? 'unknown'}, signal=${error.signal ?? 'none'}): ${diagnostics}`,
          [process.env.GH_TOKEN, process.env.GITHUB_TOKEN],
        ),
      );
    }
  }
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
function workflowContext() {
  return {
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
    event: process.env.GITHUB_EVENT_NAME,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'qualification' && args.length <= 1) {
    const checkedOutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const manifest = args[0] ? await readJson(args[0]) : undefined;
    const sha = assertQualificationIdentity(
      workflowContext(),
      checkedOutSha,
      process.env.QUALIFICATION_SOURCE_INPUT,
      manifest?.gitSha,
    );
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
    console.log(`候选与签发身份一致：${sha}`);
  } else if (mode === 'promotion' && args.length === 2) {
    const checkedOutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assertMainWorkflow(workflowContext(), checkedOutSha, PROMOTION_WORKFLOW);
    const manifest = await readJson(args[1]);
    assertQualificationRun(await readJson(args[0]), manifest.gitSha);
  } else if (mode === 'attestation' && (args.length === 2 || args.length === 4)) {
    if (args.length === 4 && args[2] !== '--bundle') throw new Error('非法证明参数');
    await verifyReleaseAttestations([{ file: args[0], sourceSha: args[1], bundle: args[3] }]);
  } else if (mode === 'attestations' && args.length >= 2) {
    await verifyReleaseAttestations(args.slice(1).map((file) => ({ file, sourceSha: args[0] })));
  } else
    throw new Error(
      '用法：release-identity.mjs qualification [manifest] | promotion run manifest | attestation file SHA [--bundle file] | attestations SHA file...',
    );
}

// Call only on a private snapshot that remains the input to the subsequent release.
// A successful gh verification authenticates the complete DSSE payload, after which
// this code checks every requested name and the SHA-256 of its snapshotted bytes.
export async function verifyGroupedReleaseAttestations(subjects, execute = promisify(execFile)) {
  const started = globalThis.performance.now();
  const { createHash } = await import('node:crypto');
  const { createReadStream } = await import('node:fs');
  const { basename } = await import('node:path');
  const { lstat } = await import('node:fs/promises');
  if (!Array.isArray(subjects) || !subjects.length) throw new Error('缺少待验证原始资产');
  const sha256 = async (path) => {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('来源校验必须使用普通冻结文件');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
  };
  const groups = new Map();
  for (const subject of subjects) {
    releaseAttestationArgs(subject.file, subject.sourceSha, subject.bundle, subject.workflow);
    if (!subject.bundle) throw new Error('分组来源校验必须使用原 bundle');
    const bytes = await readFile(subject.bundle);
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error('原 bundle 大小无效');
    const bundleHash = createHash('sha256').update(bytes).digest('hex');
    const key = `${subject.workflow ?? 'qualification'}:${subject.sourceSha}:${bundleHash}`;
    if (!groups.has(key)) groups.set(key, { subjects: [], bytes, bundle: subject.bundle });
    groups.get(key).subjects.push({
      ...subject,
      name: basename(subject.file),
      sha256: await sha256(subject.file),
    });
  }
  let calls = 0;
  let status = 'failure';
  try {
    for (const group of groups.values()) {
      const names = new Set();
      for (const subject of group.subjects) {
        if (names.has(subject.name)) throw new Error('重复待验证资产名称');
        names.add(subject.name);
      }
      const representative = group.subjects[0];
      await verifyReleaseAttestations([representative], async (...args) => {
        calls++;
        return execute(...args);
      });
      for (const subject of group.subjects) {
        const after = await readFile(subject.bundle);
        if (!after.equals(group.bytes)) throw new Error('验证期间来源 bundle 已变化');
      }
      let envelope;
      try {
        envelope = JSON.parse(group.bytes.toString('utf8')).dsseEnvelope;
      } catch {
        throw new Error('来源 bundle 格式无效');
      }
      if (
        envelope?.payloadType !== 'application/vnd.in-toto+json' ||
        typeof envelope.payload !== 'string'
      )
        throw new Error('来源 DSSE 信封无效');
      const raw = Buffer.from(envelope.payload, 'base64');
      if (!raw.length || raw.toString('base64') !== envelope.payload)
        throw new Error('来源 DSSE 编码无效');
      const payloadText = raw.toString('utf8');
      if (!Buffer.from(payloadText, 'utf8').equals(raw)) throw new Error('来源 DSSE UTF-8 无效');
      let statement;
      try {
        statement = JSON.parse(payloadText);
      } catch {
        throw new Error('来源 DSSE 内容无效');
      }
      if (
        statement?._type !== 'https://in-toto.io/Statement/v1' ||
        !Array.isArray(statement.subject)
      )
        throw new Error('来源 subject 格式无效');
      const statementNames = statement.subject.map((entry) => entry?.name);
      if (
        statementNames.some((name) => typeof name !== 'string') ||
        new Set(statementNames).size !== statementNames.length
      )
        throw new Error('来源 subject 名称无效或重复');
      for (const subject of group.subjects) {
        const matches = statement.subject.filter((entry) => entry?.name === subject.name);
        if (
          matches.length !== 1 ||
          matches[0]?.digest?.sha256 !== subject.sha256 ||
          (await sha256(subject.file)) !== subject.sha256
        )
          throw new Error(`来源 subject 缺失、重复或字节不一致：${subject.name}`);
      }
    }
    status = 'success';
    return { groups: groups.size, calls };
  } finally {
    console.log(
      `PROVENANCE_GROUPS groups=${groups.size} gh_calls=${calls} elapsed_ms=${Math.round(globalThis.performance.now() - started)} status=${status}`,
    );
  }
}
