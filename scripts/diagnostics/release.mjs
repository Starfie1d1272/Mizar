import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { github, promotionTag, releaseIdentity } from '../qualification/box-sync.mjs';

const WORKER = 'apps/diagnostics-worker';
const ACCOUNT = '754634a82d628d202a3da6771b5fb348';
const NAME = 'mizar-diagnostics';
const DATABASE = 'e85505ac-5388-471c-abbe-7a4d9e15bde7';
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SECRET_NAMES = ['ADMIN_KEY', 'INGEST_SIGNING_KEY', 'IP_HASH_KEY'];
const SCHEMA_QUERY =
  "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name != 'd1_migrations' AND tbl_name != 'd1_migrations' ORDER BY type,name";
const VAR_NAMES = [
  'ACCEPTING',
  'DATABASE_BYTES',
  'DAILY_BYTES',
  'DAILY_BATCHES',
  'DAILY_REGISTRATIONS',
  'INSTALLATION_DAILY_BYTES',
  'INSTALLATION_DAILY_BATCHES',
];
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
export const digest = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : canonical(value))
    .digest('hex');
const fail = (reason) => {
  throw new Error(reason);
};
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const git = (root, ...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30000 }).trim();

export function assertStable(tag, previous) {
  if (!TAG.test(tag) || (previous && !TAG.test(previous))) fail('只允许准确的正式版本标签');
  if (previous) {
    const a = tag.slice(1).split('.').map(BigInt);
    const b = previous.slice(1).split('.').map(BigInt);
    for (let i = 0; i < 3; i++) {
      if (a[i] < b[i]) fail('拒绝旧版本重跑导致接收器降级');
      if (a[i] > b[i]) break;
    }
  }
}

export function uploadConfig(config) {
  const keys = [
    '$schema',
    'name',
    'account_id',
    'main',
    'compatibility_date',
    'workers_dev',
    'preview_urls',
    'observability',
    'r2_buckets',
    'd1_databases',
    'ratelimits',
    'vars',
    'triggers',
  ];
  if (
    Object.keys(config).some((key) => !keys.includes(key)) ||
    config.account_id !== ACCOUNT ||
    config.name !== NAME ||
    config.main !== 'src/index.ts' ||
    config.workers_dev !== false ||
    config.preview_urls !== false ||
    config.observability?.enabled !== false
  )
    fail('部署模板或目标变化，必须先重新审查');
  if (
    canonical(config.r2_buckets) !==
      canonical([{ binding: 'DIAGNOSTICS_BUCKET', bucket_name: 'mizar-telemetry' }]) ||
    canonical(config.d1_databases) !==
      canonical([
        {
          binding: 'DIAGNOSTICS_DB',
          database_name: 'mizar-telemetry',
          database_id: DATABASE,
          migrations_dir: 'migrations',
        },
      ])
  )
    fail('拒绝修改诊断资源绑定');
  if (
    canonical(config.ratelimits) !==
      canonical([
        { name: 'ENROLL_LIMITER', namespace_id: '1001', simple: { limit: 120, period: 60 } },
        { name: 'UPLOAD_LIMITER', namespace_id: '1002', simple: { limit: 300, period: 60 } },
      ]) ||
    canonical(config.triggers) !== canonical({ crons: ['*/15 * * * *'] })
  )
    fail('拒绝修改限流或清理计划');
  // versions upload does not update routes, schedules, subdomains or observability.
  // Never send the default zero budgets; inherit live variables and all secrets.
  return {
    name: NAME,
    account_id: ACCOUNT,
    main: 'bundle/index.js',
    compatibility_date: config.compatibility_date,
    r2_buckets: config.r2_buckets,
    d1_databases: [
      { binding: 'DIAGNOSTICS_DB', database_name: 'mizar-telemetry', database_id: DATABASE },
    ],
    ratelimits: config.ratelimits,
    vars: {},
    keep_vars: true,
    version_metadata: { binding: 'DIAGNOSTICS_VERSION' },
    upload_source_maps: false,
    send_metrics: false,
    no_bundle: true,
  };
}

export function liveConfig(settings) {
  if (!Array.isArray(settings.bindings)) fail('缺少线上绑定证据');
  const names = new Set();
  const bindings = settings.bindings
    .filter((binding) => binding.type !== 'version_metadata')
    .map((binding) => {
      if (names.has(binding.name)) fail('重复线上绑定');
      names.add(binding.name);
      const { name, type } = binding;
      if (type === 'secret_text' && SECRET_NAMES.includes(name)) return { name, type };
      if (
        type === 'plain_text' &&
        VAR_NAMES.includes(name) &&
        /^(0|[1-9]\d*)$/.test(binding.text) &&
        Number.isSafeInteger(Number(binding.text)) &&
        (name !== 'ACCEPTING' || ['0', '1'].includes(binding.text))
      )
        return { name, type, text: binding.text };
      if (
        type === 'r2_bucket' &&
        name === 'DIAGNOSTICS_BUCKET' &&
        binding.bucket_name === 'mizar-telemetry' &&
        !binding.jurisdiction
      )
        return { name, type, bucket_name: binding.bucket_name };
      if (type === 'd1' && name === 'DIAGNOSTICS_DB' && binding.id === DATABASE)
        return { name, type, id: binding.id };
      const limit = name === 'ENROLL_LIMITER' ? 120 : name === 'UPLOAD_LIMITER' ? 300 : 0;
      if (
        type === 'ratelimit' &&
        limit &&
        binding.namespace_id === (limit === 120 ? '1001' : '1002') &&
        canonical(binding.simple) === canonical({ limit, period: 60 })
      )
        return { name, type, namespace_id: binding.namespace_id, simple: binding.simple };
      fail('线上绑定不在已审范围内');
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  if (bindings.length !== SECRET_NAMES.length + VAR_NAMES.length + 4)
    fail('线上绑定或运行时密钥缺失');
  if (
    settings.bindings.some(
      (binding) => binding.type === 'version_metadata' && binding.name !== 'DIAGNOSTICS_VERSION',
    )
  )
    fail('未知版本元数据绑定');
  if (
    (settings.compatibility_flags ?? []).length ||
    settings.placement?.mode ||
    settings.tail_consumers?.length ||
    (settings.limits && Object.keys(settings.limits).length)
  )
    fail('线上存在未接管的版本配置');
  return {
    bindings,
    compatibility_date: settings.compatibility_date,
    compatibility_flags: settings.compatibility_flags ?? [],
  };
}

export function currentVersion(deployments) {
  const deployment = deployments?.deployments?.[0];
  if (
    !UUID.test(deployment?.id) ||
    deployment?.versions?.length !== 1 ||
    deployment.versions[0].percentage !== 100 ||
    !UUID.test(deployment.versions[0].version_id)
  )
    fail('当前部署必须是可识别的单版本全量部署');
  return { deploymentId: deployment.id, versionId: deployment.versions[0].version_id };
}

export function versionIdentity(version) {
  const message = version?.annotations?.['workers/message'];
  if (!message?.startsWith('mizar-diagnostics/1 ')) return null;
  const identity = JSON.parse(message.slice('mizar-diagnostics/1 '.length));
  if (
    !SHA.test(identity.sha) ||
    !TAG.test(identity.tag) ||
    !DIGEST.test(identity.inputs) ||
    !DIGEST.test(identity.bundle) ||
    !UUID.test(identity.base)
  )
    fail('接收器发行身份无效');
  return identity;
}

export function verifyHealth(response, body, versionId, config) {
  const vars = Object.fromEntries(
    config.bindings
      .filter((binding) => binding.type === 'plain_text')
      .map((binding) => [binding.name, binding.text]),
  );
  const limits = {
    dailyBytes: 'DAILY_BYTES',
    dailyBatches: 'DAILY_BATCHES',
    dailyRegistrations: 'DAILY_REGISTRATIONS',
    installationDailyBytes: 'INSTALLATION_DAILY_BYTES',
    installationDailyBatches: 'INSTALLATION_DAILY_BATCHES',
    databaseBytes: 'DATABASE_BYTES',
  };
  if (
    response.status !== 200 ||
    response.headers.get('x-diagnostics-event-version') !== '2' ||
    body.deploymentVersionId !== versionId ||
    body.accepting !== (vars.ACCEPTING === '1') ||
    Object.entries(limits).some(([key, variable]) => body.limits?.[key] !== Number(vars[variable]))
  )
    fail('接收端身份、event/2、接收状态或预算验证失败');
}

function wrangler(root, args, env = {}) {
  const entry = join(root, WORKER, 'node_modules/wrangler/bin/wrangler.js');
  // Do not echo process errors: they can contain headers, environment or private responses.
  try {
    execFileSync(process.execPath, [entry, ...args], {
      cwd: join(root, WORKER),
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true', ...env },
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: 'pipe',
    });
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Child errors may contain credentials; retain only command and exit status.
    throw new Error(
      `Wrangler ${args.slice(0, 2).join(' ')} 失败或结果不确定（退出码 ${error.status ?? 'unknown'}）；先核实远端状态再恢复`,
    );
  }
}

export async function prepare(root, manifest, tag, output) {
  assertStable(tag);
  if (
    !SHA.test(manifest.gitSha) ||
    manifest.gitSha !== git(root, 'rev-parse', 'HEAD') ||
    tag !== `v${manifest.appVersion}`
  )
    fail('接收器必须来自已核验的准确客户端源码');
  const paths = [
    WORKER,
    'packages/protocol',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'tsconfig.library.json',
    'tsconfig.node.json',
  ];
  if (git(root, 'status', '--porcelain', '--', ...paths)) fail('接收器构建输入存在未提交修改');
  const { parse } = createRequire(join(root, 'package.json'))('jsonc-parser');
  const template = parse(await readFile(join(root, WORKER, 'wrangler.jsonc'), 'utf8'));
  const config = uploadConfig(template);
  await mkdir(join(output, 'bundle'), { recursive: true });
  wrangler(root, [
    'versions',
    'upload',
    '--dry-run',
    '--config',
    join(root, WORKER, 'wrangler.jsonc'),
    '--outdir',
    join(output, 'bundle'),
    '--upload-source-maps=false',
  ]);
  const bundle = await readFile(join(output, 'bundle/index.js'));
  if (!bundle.toString('utf8').includes('deploymentVersionId'))
    fail('此源码没有接收器版本回读能力，不能自动部署后冒充验证成功');
  const migrations = (await readdir(join(root, WORKER, 'migrations')))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(':memory:');
  let schemaDigest;
  try {
    for (const migration of migrations)
      database.exec(await readFile(join(root, WORKER, 'migrations', migration), 'utf8'));
    schemaDigest = digest(database.prepare(SCHEMA_QUERY).all());
  } finally {
    database.close();
  }
  const identity = {
    sha: manifest.gitSha,
    tag,
    inputs: digest(git(root, 'ls-tree', '-r', manifest.gitSha, '--', ...paths)),
    bundle: createHash('sha256').update(bundle).digest('hex'),
  };
  await writeFile(join(output, 'wrangler.json'), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(
    join(output, 'candidate.json'),
    `${JSON.stringify({ identity, configDigest: digest(config), schemaDigest, migrations }, null, 2)}\n`,
  );
  return identity;
}

function apiClient(token) {
  return async (path, options = {}) => {
    const response = await globalThis.fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/${path}`,
      {
        ...options,
        redirect: 'error',
        signal: globalThis.AbortSignal.timeout(30000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      },
    );
    if (!response.ok) fail(`Cloudflare 管理读取失败（HTTP ${response.status}）`);
    const data = await response.json();
    if (data.success !== true) fail('Cloudflare 管理请求未确认成功');
    return data.result;
  };
}

export async function snapshot(api) {
  const prefix = `workers/scripts/${NAME}`;
  const before = currentVersion(await api(`${prefix}/deployments`));
  const version = await api(`${prefix}/versions/${before.versionId}`);
  const settings = liveConfig({
    ...version.resources.script_runtime,
    bindings: version.resources.bindings,
  });
  const subdomain = await api(`${prefix}/subdomain`);
  const schedules = await api(`${prefix}/schedules`);
  const scriptSettings = await api(`${prefix}/script-settings`);
  if (
    subdomain.enabled ||
    subdomain.previews_enabled ||
    scriptSettings.observability?.enabled ||
    scriptSettings.logpush ||
    scriptSettings.tail_consumers?.length ||
    canonical((schedules.schedules ?? schedules).map(({ cron }) => cron).sort()) !==
      canonical(['*/15 * * * *'])
  )
    fail('公开入口、日志或清理计划与已审边界不符');
  const query = async (sql) => {
    const results = await api(`d1/database/${DATABASE}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql }),
    });
    if (results.length !== 1 || results[0].success !== true) fail('D1 只读校验失败');
    return results[0].results;
  };
  const schema = await query(SCHEMA_QUERY);
  // Deliberately do not CREATE a ledger or replay 0001 against an existing database.
  const migrations = await query('SELECT name FROM d1_migrations ORDER BY name');
  const after = currentVersion(await api(`${prefix}/deployments`));
  if (canonical(before) !== canonical(after)) fail('读取期间部署发生变化，不能继续');
  return {
    ...before,
    settings,
    identity: versionIdentity(version),
    configDigest: digest(settings),
    schemaDigest: digest(schema),
    migrations: migrations.map(({ name }) => name),
  };
}

export async function deploy({
  root,
  output,
  env = process.env,
  api = apiClient(env.CLOUDFLARE_API_TOKEN),
  execute = wrangler,
  health = globalThis.fetch,
  latestTag,
}) {
  const report = { status: 'failed', phase: 'configuration', productionUploadTest: 'not-run' };
  const record = async () =>
    writeFile(join(output, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  await mkdir(output, { recursive: true });
  try {
    for (const name of [
      'CLOUDFLARE_API_TOKEN',
      'DIAGNOSTICS_ADMIN_KEY',
      'DIAGNOSTICS_ENDPOINT',
      'DIAGNOSTICS_CONFIG_SHA256',
      'DIAGNOSTICS_SCHEMA_SHA256',
      'DIAGNOSTICS_BASELINE_VERSION',
      'DIAGNOSTICS_BASELINE_TAG',
    ])
      if (!env[name]) fail(`缺少已审配置 ${name}`);
    if (
      !DIGEST.test(env.DIAGNOSTICS_CONFIG_SHA256) ||
      !DIGEST.test(env.DIAGNOSTICS_SCHEMA_SHA256) ||
      !UUID.test(env.DIAGNOSTICS_BASELINE_VERSION)
    )
      fail('已审接管基线无效');
    const endpoint = new URL(env.DIAGNOSTICS_ENDPOINT);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== '/'
    )
      fail('诊断入口必须是已审 HTTPS 源');
    const candidate = await json(join(output, 'candidate.json'));
    const { identity } = candidate;
    assertStable(latestTag);
    assertStable(identity.tag, latestTag);
    assertStable(identity.tag, env.DIAGNOSTICS_BASELINE_TAG);
    const config = await json(join(output, 'wrangler.json'));
    if (
      digest(config) !== candidate.configDigest ||
      createHash('sha256')
        .update(await readFile(join(output, 'bundle/index.js')))
        .digest('hex') !== identity.bundle
    )
      fail('冻结接收器构件已改变');
    report.candidate = identity;
    report.phase = 'preflight';
    const before = await snapshot(api);
    report.before = {
      deploymentId: before.deploymentId,
      versionId: before.versionId,
      configDigest: before.configDigest,
      schemaDigest: before.schemaDigest,
      migrations: before.migrations,
    };
    if (
      before.configDigest !== env.DIAGNOSTICS_CONFIG_SHA256 ||
      before.schemaDigest !== env.DIAGNOSTICS_SCHEMA_SHA256 ||
      before.schemaDigest !== candidate.schemaDigest ||
      canonical(before.migrations) !== canonical(candidate.migrations)
    )
      fail('配置/schema/迁移记录不匹配；需先完成已审增量迁移，不执行初始化 SQL');
    if (before.settings.compatibility_date !== config.compatibility_date)
      fail('兼容日期变更需独立接管审查');
    if (before.identity) assertStable(identity.tag, before.identity.tag);
    else if (before.versionId !== env.DIAGNOSTICS_BASELINE_VERSION)
      fail('未知线上版本，拒绝接管或覆盖');
    await record();
    let versionId = before.versionId;
    const matches = (value) =>
      value?.inputs === identity.inputs && value?.bundle === identity.bundle;
    if (!matches(before.identity)) {
      report.phase = 'upload';
      await record();
      const prefix = `workers/scripts/${NAME}`;
      const versions = await api(`${prefix}/versions?deployable=true`);
      // Resume an uploaded but not activated version after a failed prior attempt.
      const reusable = versions.items.find((version) => {
        const prior = versionIdentity(version);
        return matches(prior) && prior.base === before.versionId;
      });
      if (versions.items[0]?.id !== (reusable?.id ?? before.versionId))
        fail('最新上传版本不是已核验版本，拒绝继承未知配置或密钥');
      if (reusable) versionId = reusable.id;
      else {
        const outputFile = join(output, 'upload.ndjson');
        execute(
          root,
          [
            'versions',
            'upload',
            '--config',
            join(output, 'wrangler.json'),
            '--no-bundle',
            '--keep-vars',
            '--message',
            `mizar-diagnostics/1 ${JSON.stringify({ ...identity, base: before.versionId })}`,
          ],
          { WRANGLER_OUTPUT_FILE_PATH: outputFile },
        );
        const lines = (await readFile(outputFile, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        versionId = lines.filter((line) => line.type === 'version-upload').at(-1)?.version_id;
      }
      if (!UUID.test(versionId)) fail('上传结果缺少准确版本身份');
      const uploaded = await api(`${prefix}/versions/${versionId}`);
      if (!matches(versionIdentity(uploaded))) fail('上传版本与冻结构件不一致');
      // keep-vars inherits the latest uploaded version, not necessarily the live version.
      // Verify its actual bindings before giving it any traffic.
      if (
        digest(
          liveConfig({
            ...uploaded.resources.script_runtime,
            bindings: uploaded.resources.bindings,
          }),
        ) !== before.configDigest
      )
        fail('上传版本未保留已审生产配置');
      const current = await snapshot(api);
      if (
        current.versionId !== before.versionId ||
        current.deploymentId !== before.deploymentId ||
        current.configDigest !== before.configDigest ||
        current.schemaDigest !== before.schemaDigest
      )
        fail('激活前线上状态已改变');
      report.phase = 'activate';
      report.uploadedVersionId = versionId;
      await record();
      execute(root, [
        'versions',
        'deploy',
        `${versionId}@100`,
        '--yes',
        '--config',
        join(output, 'wrangler.json'),
        '--message',
        `Mizar ${identity.tag} ${identity.sha}`,
      ]);
    }
    report.phase = 'verify';
    await record();
    const after = await snapshot(api);
    report.after = { deploymentId: after.deploymentId, versionId: after.versionId };
    if (
      after.versionId !== versionId ||
      after.configDigest !== before.configDigest ||
      after.schemaDigest !== before.schemaDigest ||
      canonical(after.migrations) !== canonical(before.migrations)
    )
      fail('激活后版本或保留配置验证失败');
    const response = await health(new URL('/admin/health', endpoint), {
      headers: { authorization: `Bearer ${env.DIAGNOSTICS_ADMIN_KEY}` },
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(30000),
    });
    verifyHealth(response, await response.json(), versionId, after.settings);
    report.status = before.versionId === versionId ? 'matched' : 'deployed';
    report.phase = 'complete';
    return report;
  } finally {
    // Only allowlisted identities and validation state are retained, never config values or bodies.
    await record();
  }
}

export async function resolveRelease(
  output,
  env = process.env,
  api = github,
  verify = releaseIdentity,
) {
  if (
    env.GITHUB_REPOSITORY !== 'Starfie1d1272/Mizar' ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    env.GITHUB_WORKFLOW_REF !==
      'Starfie1d1272/Mizar/.github/workflows/diagnostics-release.yml@refs/heads/main'
  )
    fail('诊断部署控制流程必须来自原仓库 main');
  let tag = env.RELEASE_TAG;
  if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    const event = await json(env.GITHUB_EVENT_PATH);
    if (!Number.isSafeInteger(event.workflow_run?.id)) fail('缺少晋级运行身份');
    const run = await api(`actions/runs/${event.workflow_run.id}`);
    if (
      run.status !== 'completed' ||
      run.conclusion !== 'success' ||
      run.path !== '.github/workflows/release-promotion.yml' ||
      !['workflow_run', 'workflow_dispatch'].includes(run.event) ||
      run.head_branch !== 'main' ||
      run.head_repository?.full_name !== env.GITHUB_REPOSITORY ||
      run.repository?.full_name !== env.GITHUB_REPOSITORY
    )
      fail('触发来源不是原仓库 main 的成功晋级');
    if (run.display_title.startsWith('Stage draft ')) {
      await writeFile(output, JSON.stringify({ status: 'skipped', reason: 'draft-only' }));
      return;
    }
    const { jobs } = await api(`actions/runs/${run.id}/jobs?per_page=100`);
    tag = promotionTag(run, jobs);
  } else if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') fail('非法诊断部署触发器');
  if (/^v\d+\.\d+\.\d+-(?:alpha|beta|rc)\.[1-9]\d*$/.test(tag ?? '')) {
    await writeFile(output, JSON.stringify({ status: 'skipped', reason: 'prerelease', tag }));
    return;
  }
  assertStable(tag);
  // Reuse the existing signed release identity verification without downloading installers.
  const published = await verify(tag, { runtime: false, bootstrap: false });
  const latest = await api('releases/latest');
  assertStable(latest.tag_name);
  const { gitSha } = published.manifest;
  if (!SHA.test(gitSha)) fail('已发布源码身份无效');
  if (tag !== latest.tag_name) {
    assertStable(latest.tag_name, tag);
    await writeFile(
      output,
      JSON.stringify({
        status: 'skipped',
        reason: 'superseded',
        tag,
        gitSha,
        latest: latest.tag_name,
      }),
    );
    return;
  }
  await writeFile(output, JSON.stringify({ status: 'verified', tag, gitSha }));
  await appendFile(env.GITHUB_OUTPUT, `sync=true\nsha=${gitSha}\ntag=${tag}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'resolve' && args.length === 1) await resolveRelease(args[0]);
  else if (mode === 'prepare' && args.length === 4)
    await prepare(resolve(args[0]), await json(args[1]), args[2], resolve(args[3]));
  else if (mode === 'inspect' && !args.length) {
    if (!process.env.CLOUDFLARE_API_TOKEN) fail('缺少只读核查凭据');
    const state = await snapshot(apiClient(process.env.CLOUDFLARE_API_TOKEN));
    console.log(
      JSON.stringify(
        {
          versionId: state.versionId,
          configDigest: state.configDigest,
          schemaDigest: state.schemaDigest,
          migrations: state.migrations,
        },
        null,
        2,
      ),
    );
  } else if (mode === 'deploy' && args.length === 3) {
    await deploy({
      root: resolve(args[0]),
      output: resolve(args[1]),
      latestTag: (await json(args[2])).tag_name,
    });
  } else
    fail(
      '用法：release.mjs resolve OUTPUT | prepare ROOT MANIFEST TAG OUTPUT | inspect | deploy ROOT OUTPUT LATEST_RELEASE_JSON',
    );
}
