import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { clearTimeout, setTimeout } from 'node:timers';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const root = resolve(process.argv[2]);
const reportPath = resolve(process.argv[3]);
const exe = join(root, 'Mizar.exe');
const stateRoot = join(root, 'state', 'synthetic-soak');
const port = 3000;
const origin = `http://127.0.0.1:${port}`;
const SUBPROTOCOL = 'mizar.local.v1';
const matches = [
  { id: 'A', map: 'de_ancient' },
  { id: 'B', map: 'de_inferno' },
  { id: 'C', map: 'de_mirage' },
];
const winsByMatch = [
  [
    'A',
    'B',
    'A',
    'B',
    'A',
    'A',
    'B',
    'A',
    'B',
    'A',
    'B',
    'A',
    'A',
    'B',
    'A',
    'B',
    'A',
    'B',
    'A',
    'B',
    'A',
    'B',
    'A',
    'B',
  ],
  [
    'B',
    'A',
    'A',
    'B',
    'A',
    'B',
    'A',
    'A',
    'B',
    'A',
    'B',
    'A',
    'B',
    'A',
    'B',
    'A',
    'A',
    'B',
    'A',
    'B',
    'A',
    'B',
    'A',
    'B',
  ],
  [
    'A',
    'A',
    'B',
    'A',
    'B',
    'A',
    'B',
    'A',
    'A',
    'B',
    'A',
    'B',
    'A',
    'B',
    'A',
    'B',
    'A',
    'A',
    'B',
    'A',
    'B',
    'A',
    'B',
    'B',
  ],
];
const requireFromCompanion = createRequire(join(root, 'resources/app/package.json'));
const websocketPackage = requireFromCompanion.resolve('@fastify/websocket');
const WebSocket = createRequire(websocketPackage)('ws');

function command(file, args, env, timeoutMs = 60000) {
  const child = spawn(file, args, {
    cwd: root,
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  const completion = new Promise((resolveDone, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`命令超时：${file}`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveDone(code);
    });
  });
  completion.catch(() => {});
  return { child, completion };
}

async function health() {
  try {
    const response = await globalThis.fetch(`${origin}/health`, {
      signal: globalThis.AbortSignal.timeout(1000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function waitForHealth(expectedArtifactSha256, timeoutMs = 45000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const current = await health();
    if (current?.product?.artifactSha256 === expectedArtifactSha256) return current;
    await delay(150);
  }
  throw new Error('便携 Companion 未在限定时间内就绪');
}

async function waitFor(predicate, message, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  assert.ok(predicate(), message);
}

function connectChannel(path, userAgent) {
  const socket = new WebSocket(`${origin}${path}`, SUBPROTOCOL, {
    headers: { Origin: origin, 'User-Agent': userAgent },
    handshakeTimeout: 5000,
  });
  const stats = {
    frames: 0,
    highestSequence: 0,
    lastSequence: 0,
    sequenceGaps: 0,
    nonMonotonicSequences: 0,
    baselineSeen: false,
  };
  socket.on('message', (data) => {
    try {
      const value = JSON.parse(data.toString());
      if (Number.isSafeInteger(value.channelSeq)) {
        if (stats.lastSequence > 0 && value.channelSeq > stats.lastSequence + 1) {
          stats.sequenceGaps += value.channelSeq - stats.lastSequence - 1;
        }
        if (stats.lastSequence > 0 && value.channelSeq <= stats.lastSequence)
          stats.nonMonotonicSequences += 1;
        stats.lastSequence = value.channelSeq;
        stats.highestSequence = Math.max(stats.highestSequence, value.channelSeq);
        stats.frames += 1;
        stats.baselineSeen = true;
      }
    } catch {
      // Ignore non-snapshot control messages; they are not publication evidence.
    }
  });
  const opened = new Promise((resolveOpen, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket 未连接：${path}`)), 6000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolveOpen();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { socket, opened, stats };
}

async function closeChannel(client) {
  if (client.socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolveClose) => client.socket.once('close', resolveClose));
  client.socket.close(1000, 'soak reconnect');
  await Promise.race([closed, delay(3000)]);
}

async function jsonAt(path) {
  const response = await globalThis.fetch(`${origin}${path}`, {
    signal: globalThis.AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, `${path} returned ${response.status}`);
  return response.json();
}

async function waitForJson(path, predicate, message, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await jsonAt(path);
    if (predicate(value)) return value;
    await delay(20);
  }
  throw new Error(message);
}

function powershell(script) {
  const env = { ...process.env };
  delete env.PSModulePath;
  return spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      env,
    },
  );
}

function powershellProcessMetrics(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, '缺少 Companion 进程 ID');
  const script = `Get-Process -Id ${pid} | Select-Object @{Name='workingSetBytes';Expression={[long]$_.WorkingSet64}}, @{Name='cpuSeconds';Expression={[double]$_.CPU}} | ConvertTo-Json -Compress`;
  const result = powershell(script);
  if (result.status !== 0) throw new Error(`无法读取 Companion 进程指标：${result.stderr}`);
  const metrics = JSON.parse(result.stdout.trim());
  assert.ok(Number.isFinite(metrics.workingSetBytes) && Number.isFinite(metrics.cpuSeconds));
  return metrics;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setRoundState(base, mapName, roundNumber, phase, scores, teamAIsCt, winner) {
  const payload = clone(base);
  payload.map.name = mapName;
  payload.map.mode = 'competitive';
  payload.map.phase = phase === 'over' && roundNumber === 24 ? 'gameover' : 'live';
  payload.map.round = roundNumber;
  payload.map.round_wins ??= {};
  payload.map.team_ct.name = teamAIsCt ? 'Team A' : 'Team B';
  payload.map.team_t.name = teamAIsCt ? 'Team B' : 'Team A';
  payload.map.team_ct.score = teamAIsCt ? scores.a : scores.b;
  payload.map.team_t.score = teamAIsCt ? scores.b : scores.a;
  if (phase === 'over' && winner !== undefined) {
    payload.map.round_wins[String(roundNumber)] =
      (winner === 'A') === teamAIsCt ? 'ct_win_elimination' : 't_win_elimination';
  }
  payload.round = { phase };
  if (payload.phase_countdowns) payload.phase_countdowns = { phase, phase_ends_in: '19.8' };
  return payload;
}

async function sendGsi(token, payload) {
  const response = await globalThis.fetch(`${origin}/gsi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, auth: { token } }),
    signal: globalThis.AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 204, `GSI input returned ${response.status}`);
}

function deliveryMetrics(value) {
  return (Array.isArray(value) ? value : []).map((entry) => ({
    id: typeof entry.id === 'string' ? entry.id : '未命名',
    state: typeof entry.state === 'string' ? entry.state : 'unknown',
    offered: Number.isSafeInteger(entry.offered) ? entry.offered : 0,
    sent: Number.isSafeInteger(entry.sent) ? entry.sent : 0,
    coalesced: Number.isSafeInteger(entry.coalesced) ? entry.coalesced : 0,
    failed: Number.isSafeInteger(entry.failed) ? entry.failed : 0,
  }));
}

const startedAt = new Date().toISOString();
let launcher;
let matchStartRuntimeId;
const allClients = [];
try {
  assert.equal(
    process.platform,
    'win32',
    '该 exact-artifact soak 只在 Windows qualification runner 执行',
  );
  const artifact = JSON.parse(
    await readFile(join(root, 'resources/metadata/artifact.json'), 'utf8'),
  );
  await mkdir(stateRoot, { recursive: true });
  const runtimeEnv = { ...process.env, MIZAR_STATE_ROOT: stateRoot };
  const version = spawnSync(join(root, 'resources/runtime/node.exe'), ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(version.status, 0, '便携 Node runtime 无法执行');

  launcher = command(exe, ['--no-browser'], runtimeEnv, 180000);
  await waitForHealth(artifact.artifactSha256);
  const runtimeState = JSON.parse(await readFile(join(stateRoot, 'data/runtime.json'), 'utf8'));
  const token = (await readFile(join(stateRoot, 'data/gsi-token.txt'), 'utf8')).trim();
  const initialRuntime = await jsonAt('/debug/runtime');
  matchStartRuntimeId = initialRuntime.producerInstanceId;
  const processStart = powershellProcessMetrics(runtimeState.pid);

  const obsProgram = connectChannel(
    '/local/v1/program',
    'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36 OBS/32.0.2',
  );
  const obsRadar = connectChannel(
    '/local/v1/radar',
    'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36 OBS/32.0.2',
  );
  let operator = connectChannel('/local/v1/operator', 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36');
  allClients.push(obsProgram, obsRadar, operator);
  await Promise.all([obsProgram.opened, obsRadar.opened, operator.opened]);
  await waitFor(
    () => [obsProgram, obsRadar, operator].every((client) => client.stats.baselineSeen),
    '播出画面、Radar 或制作控制未收到当前基线',
  );

  const fixtureText = await readFile(
    join(repositoryRoot, 'fixtures/gsi/acceptance/ancient-round-03/frames.jsonl'),
    'utf8',
  );
  const fixtureFrame = fixtureText
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
    .find((frame) => frame.payload?.map?.team_ct && frame.payload?.map?.team_t);
  assert.ok(fixtureFrame, '缺少可用的已脱敏 GSI 回合样例');
  const sourceFixture = JSON.parse(
    await readFile(
      join(repositoryRoot, 'fixtures/gsi/acceptance/ancient-round-03/manifest.json'),
      'utf8',
    ),
  );
  const basePayload = clone(fixtureFrame.payload);
  delete basePayload.auth;

  const matchReports = [];
  let totalInputs = 0;
  for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
    const match = matches[matchIndex];
    const startSequences = {
      program: obsProgram.stats.highestSequence,
      radar: obsRadar.stats.highestSequence,
      operator: operator.stats.highestSequence,
    };
    const startFrames = {
      program: obsProgram.stats.frames,
      radar: obsRadar.stats.frames,
      operator: operator.stats.frames,
    };
    const startSequenceGaps = {
      program: obsProgram.stats.sequenceGaps,
      radar: obsRadar.stats.sequenceGaps,
      operator: operator.stats.sequenceGaps,
    };
    const startNonMonotonicSequences = {
      program: obsProgram.stats.nonMonotonicSequences,
      radar: obsRadar.stats.nonMonotonicSequences,
      operator: operator.stats.nonMonotonicSequences,
    };
    const started = performance.now();
    let scoreA = 0;
    let scoreB = 0;
    const winners = winsByMatch[matchIndex];
    assert.equal(winners.length, 24);
    assert.equal(winners.filter((winner) => winner === 'A').length, 13);
    assert.equal(winners.filter((winner) => winner === 'B').length, 11);

    for (let round = 1; round <= 24; round += 1) {
      const teamAIsCt = round <= 12;
      const winner = winners[round - 1];
      const currentScores = { a: scoreA, b: scoreB };
      for (const phase of ['freezetime', 'live']) {
        await sendGsi(
          token,
          setRoundState(basePayload, match.map, round, phase, currentScores, teamAIsCt),
        );
        totalInputs += 1;
      }
      if (winner === 'A') scoreA += 1;
      else scoreB += 1;
      await sendGsi(
        token,
        setRoundState(
          basePayload,
          match.map,
          round,
          'over',
          { a: scoreA, b: scoreB },
          teamAIsCt,
          winner,
        ),
      );
      totalInputs += 1;
    }
    assert.deepEqual({ a: scoreA, b: scoreB }, { a: 13, b: 11 });
    const elapsedMs = Math.round(performance.now() - started);
    const runtime = await jsonAt('/debug/runtime');
    const host = await jsonAt('/debug/hosts');
    assert.equal(
      runtime.producerInstanceId,
      matchStartRuntimeId,
      '单进程 soak 期间运行实例发生变化',
    );
    assert.equal(runtime.freshness, 'fresh');
    assert.equal(runtime.runtime.current?.map?.name, match.map);
    const runtimeMapEpoch = runtime.runtime.current?.map?.epoch;
    assert.ok(Number.isSafeInteger(runtimeMapEpoch) && runtimeMapEpoch > 0);
    const previousMapEpoch = matchReports.at(-1)?.runtimeMapEpoch;
    if (previousMapEpoch !== undefined)
      assert.ok(runtimeMapEpoch > previousMapEpoch, '每张新地图都应推进 map epoch');
    assert.equal(host.active.obs, 2);
    assert.equal(host.active.browser, 1);
    await waitFor(
      () =>
        obsProgram.stats.highestSequence > startSequences.program &&
        obsRadar.stats.highestSequence > startSequences.radar &&
        operator.stats.highestSequence > startSequences.operator,
      '至少一个本地消费者未收到本地图的最新快照',
    );

    matchReports.push({
      match: match.id,
      map: match.map,
      regulationRounds: 24,
      finalScore: '13:11',
      generatedGsiInputs: 72,
      elapsedMs,
      runtimeMapEpoch,
      delivery: deliveryMetrics(runtime.deliveryHealth),
      publications: {
        programFrames: obsProgram.stats.frames - startFrames.program,
        radarFrames: obsRadar.stats.frames - startFrames.radar,
        operatorFrames: operator.stats.frames - startFrames.operator,
        highestProgramSequence: obsProgram.stats.highestSequence,
        sequenceGaps: {
          program: obsProgram.stats.sequenceGaps - startSequenceGaps.program,
          radar: obsRadar.stats.sequenceGaps - startSequenceGaps.radar,
          operator: operator.stats.sequenceGaps - startSequenceGaps.operator,
        },
        nonMonotonicSequences: {
          program: obsProgram.stats.nonMonotonicSequences - startNonMonotonicSequences.program,
          radar: obsRadar.stats.nonMonotonicSequences - startNonMonotonicSequences.radar,
          operator: operator.stats.nonMonotonicSequences - startNonMonotonicSequences.operator,
        },
      },
    });

    if (match.id === 'A') {
      await closeChannel(operator);
      operator = connectChannel('/local/v1/operator', 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36');
      allClients.push(operator);
      await operator.opened;
      await waitFor(() => operator.stats.baselineSeen, '浏览器重连没有获得当前基线');
    }
  }

  const finalRuntime = await jsonAt('/debug/runtime');
  const finalHosts = await waitForJson(
    '/debug/hosts',
    (value) => value.totals.disconnected >= 1,
    'Operator 重连后的断开事件未记录',
  );
  const processEnd = powershellProcessMetrics(runtimeState.pid);
  const osVersion = powershell('[System.Environment]::OSVersion.VersionString');
  assert.equal(osVersion.status, 0, '无法读取 Windows 版本');
  const report = {
    schemaVersion: 1,
    classification: '3-map-exact-artifact-synthetic-lifecycle-soak',
    classificationDescription:
      '三地图 exact-artifact 合成生命周期 soak（合成测试，非真实 CS2/OBS 环境验收）',
    sourceFixture: {
      captureId: sourceFixture.captureId,
      scenario: sourceFixture.scenario,
      frameCount: sourceFixture.frameCount,
      framesSha256: sourceFixture.framesSha256,
      lifecycleCoverage: sourceFixture.provenance?.lifecycleCoverage ?? 'unspecified',
    },
    syntheticScenario: {
      maps: matches,
      totalMaps: matchReports.length,
      regulationRoundsPerMap: 24,
      generatedGsiInputs: totalInputs,
      path: 'sanitized fixture observation shape → authenticated /gsi → production telemetry adapter → Companion runtime/projections',
    },
    artifact: {
      gitSha: artifact.gitSha,
      artifactSha256: artifact.artifactSha256,
      productSchemaVersion: artifact.productSchemaVersion,
      packagedNodeVersion: version.stdout.trim(),
    },
    host: {
      platform: process.platform,
      osVersion: osVersion.stdout.trim(),
      cpuModel: cpus()[0]?.model ?? 'unavailable',
    },
    runtime: {
      instanceIdStable: finalRuntime.producerInstanceId === matchStartRuntimeId,
      producerInstanceId: finalRuntime.producerInstanceId,
      finalFreshness: finalRuntime.freshness,
      finalMap: finalRuntime.runtime.current?.map ?? null,
      recorder: finalRuntime.recorderHealth,
      delivery: deliveryMetrics(finalRuntime.deliveryHealth),
    },
    websocket: {
      active: finalHosts.active,
      totals: finalHosts.totals,
      recentEvents: finalHosts.recentEvents,
    },
    processMetrics: {
      pid: runtimeState.pid,
      companionWorkingSetStartBytes: processStart.workingSetBytes,
      companionWorkingSetEndBytes: processEnd.workingSetBytes,
      companionCpuStartSeconds: processStart.cpuSeconds,
      companionCpuEndSeconds: processEnd.cpuSeconds,
      companionCpuDeltaSeconds: Math.max(0, processEnd.cpuSeconds - processStart.cpuSeconds),
    },
    matches: matchReports,
    realEnvironmentAcceptance: 'not-run',
    startedAt,
    finishedAt: new Date().toISOString(),
    harnessNodeVersion: process.version,
  };

  assert.equal(report.runtime.instanceIdStable, true);
  assert.equal(report.runtime.finalFreshness, 'fresh');
  assert.equal(finalHosts.active.obs, 2);
  assert.equal(finalHosts.active.browser, 1);
  assert.equal(finalHosts.totals.connected, 4);
  assert.equal(finalHosts.totals.disconnected, 1);
  assert.equal(finalHosts.totals.connectionLimitRejected, 0);
  assert.equal(finalHosts.totals.slowConsumerTerminated, 0);
  assert.equal(finalHosts.totals.snapshotOversize, 0);
  assert.equal(finalHosts.totals.heartbeatTerminated, 0);
  assert.equal(finalHosts.totals.sendFailed, 0);
  for (const match of matchReports) {
    assert.ok(match.publications.programFrames > 0);
    assert.ok(match.publications.radarFrames > 0);
    assert.ok(match.publications.operatorFrames > 0);
    assert.equal(match.publications.nonMonotonicSequences.program, 0);
    assert.equal(match.publications.nonMonotonicSequences.radar, 0);
    assert.equal(match.publications.nonMonotonicSequences.operator, 0);
  }
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(
    `3-map exact-artifact synthetic lifecycle soak completed: 3 × 24-round maps, ${totalInputs} authenticated GSI updates; this is synthetic lifecycle soak, not real CS2/OBS acceptance.`,
  );
} finally {
  await Promise.all(allClients.map(closeChannel));
  if (launcher) {
    const stop = command(
      exe,
      ['--stop', '--no-browser'],
      { ...process.env, MIZAR_STATE_ROOT: stateRoot },
      45000,
    );
    const code = await stop.completion.catch(() => -1);
    if (code !== 0) launcher.child.kill();
    await launcher.completion.catch(() => undefined);
  }
}
