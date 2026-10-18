import { CameraSettings } from '../orchestration/CameraSettings';
import { Cs2ConsoleSettings } from '../debug/Cs2ConsoleSettings';
import { DiagnosticDeliverySettings } from '../debug/DiagnosticDeliverySettings';
import { MusicSettings } from '../music/MusicSettings';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ObsCaptureGuidance } from '../workspace/ObsCaptureGuidance';
import { Button, Field, Panel, StatusBanner, StatusPill } from '../ui';
import { desktopInvoke } from '../workspace/client';
import { beginObsConfiguration, obsCommand, useObsStatus } from '../workspace/obs-client';
import { RivalHubPreparationPanel } from '../operator/RivalHubPreparationPanel';
import { openTool, useLocalRead } from './client';
import { Cs2LaunchSettings } from './Cs2LaunchSettings';
import { SteamAvatarSettings } from './SteamAvatarSettings';
import { UpdateSettings } from './UpdateSettings';
import { ResourceSettings } from './ResourceSettings';
import type { ProgramSceneState } from '@mizar/protocol/program-scenes';

type ReadPhase = 'unknown' | 'checking' | 'ready' | 'failed';

// Native diagnostics retain details. Show only the known tool phase here, never raw IPC errors.
function statusReadReason(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const phase = message.match(/失败（(启动工具|读取输出|等待工具|解析输出编码|解析结果)）/)?.[1];
  if (phase) return `检测工具失败（${phase}）。`;
  return error instanceof Error && error.name === 'TimeoutError'
    ? '桌面检测请求超时。'
    : '桌面检测请求失败。';
}

export function Settings({ tab }: { tab: string }) {
  const [automationTab, setAutomationTab] = useState<'music' | 'camera'>(() =>
    new URLSearchParams(window.location.search).get('section') === 'camera' ? 'camera' : 'music',
  );
  const obs = useObsStatus();
  const program = useLocalRead<ProgramSceneState>('/local/v1/program-scenes', 3000);
  const evidence = obs?.programEvidence;
  const programIssue =
    obs?.captureDiagnostic?.state === 'needs_attention' ||
    obs?.sceneAligned === false ||
    (evidence?.state === 'measured' && evidence.capture?.targetAvailable === false);
  const signal = (value: boolean | null | undefined) =>
    value === true ? '是' : value === false ? '否' : '待确认';
  const sceneRepairNeeded = obs?.findings.some((item) =>
    [
      'collection_missing',
      'scene_missing',
      'source_missing',
      'url_drift',
      'capture_drift',
      'transform_drift',
      'order_drift',
      'source_disabled',
    ].includes(item.code),
  );
  const sceneRepairBlocked = obs?.findings.some((item) =>
    ['collection_inactive', 'source_kind_conflict'].includes(item.code),
  );
  const [portOverride, setPortOverride] = useState<number | null>(null);
  const port = portOverride ?? obs?.port ?? 4455;
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const configuration = useRef<ReturnType<typeof beginObsConfiguration> | null>(null);
  const latestConfiguration = useRef<ReturnType<typeof beginObsConfiguration> | null>(null);
  useEffect(() => {
    if (tab !== 'obs' || !window.__TAURI_INTERNALS__) return;
    let active = true;
    let opened = false;
    const session = beginObsConfiguration();
    configuration.current = session;
    latestConfiguration.current = session;
    void session.ready
      .then(() => {
        opened = true;
      })
      .catch((error: unknown) => {
        if (active) setMessage(error instanceof Error ? error.message : 'OBS 程序未能打开。');
      });
    return () => {
      active = false;
      const notify = configuration.current === session;
      if (notify) configuration.current = null;
      void session
        .finish()
        .then((result) => {
          if (
            notify &&
            result.message &&
            configuration.current === null &&
            latestConfiguration.current === session
          )
            window.dispatchEvent(
              new CustomEvent('mizar:obs-configuration-finished', { detail: result.message }),
            );
        })
        .catch(() => {
          if (
            notify &&
            opened &&
            configuration.current === null &&
            latestConfiguration.current === session
          )
            window.dispatchEvent(
              new CustomEvent('mizar:obs-configuration-finished', {
                detail:
                  'OBS 配置已结束，但实例状态未能确认。请在 OBS 中核对推流与录制，再手动关闭。',
              }),
            );
        });
    };
  }, [tab]);
  const [gsi, setGsi] = useState<{
    detected: boolean;
    installed: boolean;
    conflict: boolean;
    fileConflict: boolean;
    endpointConflict: boolean;
    cfgPath: string | null;
    readFailed: boolean;
    candidateCount: number;
    issues: readonly { code: string; message: string }[];
    conflictFiles: readonly string[];
    lastOperation: { code: string; stage: string } | null;
  } | null>(null);
  const [cs2, setCs2] = useState<{
    found: boolean;
    managed: boolean;
    message?: string | null;
  } | null>(null);
  const [gsiPhase, setGsiPhase] = useState<ReadPhase>(
    window.__TAURI_INTERNALS__ ? 'checking' : 'unknown',
  );
  const [cs2Phase, setCs2Phase] = useState<ReadPhase>(
    window.__TAURI_INTERNALS__ ? 'checking' : 'unknown',
  );
  const [gsiError, setGsiError] = useState('');
  const [cs2Error, setCs2Error] = useState('');
  const statusRequest = useRef(0);
  // Installation reads its final status directly; only external notifications trigger another read.
  const ownConfiguredEvent = useRef<Event | null>(null);
  const product = useLocalRead<{
    product?: { appVersion?: string; gitSha?: string; artifactSha256?: string };
  }>('/health', 60_000);
  const readStatus = useCallback(async () => {
    if (!window.__TAURI_INTERNALS__) return null;
    const request = ++statusRequest.current;
    const [nextGsi] = await Promise.all([
      desktopInvoke<NonNullable<typeof gsi>>('gsi_status')
        .then((next) => {
          if (!next || typeof next.installed !== 'boolean') throw new Error('Invalid GSI status');
          if (request !== statusRequest.current) return null;
          setGsi(next);
          setGsiPhase('ready');
          return next;
        })
        .catch((error: unknown) => {
          if (request === statusRequest.current) {
            setGsiPhase('failed');
            setGsiError(statusReadReason(error));
          }
          return null;
        }),
      desktopInvoke<NonNullable<typeof cs2>>('cs2_host_status')
        .then((next) => {
          if (!next || typeof next.found !== 'boolean') throw new Error('Invalid CS2 status');
          if (request !== statusRequest.current) return;
          setCs2(next);
          setCs2Phase('ready');
        })
        .catch((error: unknown) => {
          if (request === statusRequest.current) {
            setCs2Phase('failed');
            setCs2Error(statusReadReason(error));
          }
        }),
    ]);
    return request === statusRequest.current ? nextGsi : null;
  }, []);
  const refreshGsi = useCallback(() => {
    setGsiPhase('checking');
    setCs2Phase('checking');
    setGsiError('');
    setCs2Error('');
    setGsi(null);
    setCs2(null);
    return readStatus();
  }, [readStatus]);
  useEffect(() => {
    const requests = statusRequest;
    void readStatus();
    const reload = (event: Event) => {
      if (event !== ownConfiguredEvent.current) void refreshGsi();
    };
    window.addEventListener('mizar:gsi-configured', reload);
    return () => {
      requests.current++;
      window.removeEventListener('mizar:gsi-configured', reload);
    };
  }, [readStatus, refreshGsi]);
  async function action(run: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await run();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作未完成。');
      if (tab === 'gsi') await refreshGsi().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  const obsPathControl = window.__TAURI_INTERNALS__ ? (
    <details>
      <summary>OBS 路径</summary>
      <Button
        disabled={busy}
        onClick={() =>
          void action(async () => {
            const path = await desktopInvoke<string | null>('select_obs_executable');
            if (path) await obsCommand('configure', { executablePath: path });
          })
        }
      >
        更改 OBS 路径
      </Button>
    </details>
  ) : null;
  if (tab === 'music')
    return (
      <>
        <nav className="preparation-tabs" aria-label="自动制播配置">
          <Button
            aria-pressed={automationTab === 'music'}
            onClick={() => setAutomationTab('music')}
          >
            音乐
          </Button>
          <Button
            aria-pressed={automationTab === 'camera'}
            onClick={() => setAutomationTab('camera')}
          >
            运镜
          </Button>
        </nav>
        <div hidden={automationTab !== 'music'}>
          <MusicSettings />
        </div>
        <div hidden={automationTab !== 'camera'}>
          <CameraSettings />
        </div>
      </>
    );

  return (
    <>
      {tab === 'rivalhub' ? (
        <RivalHubPreparationPanel mode="settings" />
      ) : tab === 'advanced' ? (
        <div className="settings-grid">
          <UpdateSettings />
          <ResourceSettings />
          <Panel className="settings-card">
            <h2>运行信息</h2>
            <p>核对当前安装的 Mizar 版本与构建来源。</p>
            <dl className="settings-identity">
              <div>
                <dt>版本号</dt>
                <dd>
                  {product?.product?.appVersion
                    ? `v${product.product.appVersion}`
                    : '开发环境或版本信息不可用'}
                </dd>
              </div>
              <div>
                <dt>Commit</dt>
                <dd>
                  <code title={product?.product?.gitSha}>
                    {product?.product?.gitSha?.slice(0, 12) ?? '不可用'}
                  </code>
                </dd>
              </div>
            </dl>
            {product?.product?.artifactSha256 ? (
              <details className="settings-details">
                <summary>产品包校验信息</summary>
                <code>{product.product.artifactSha256}</code>
              </details>
            ) : null}
          </Panel>
          <Panel className="settings-card">
            <h2>诊断与支持</h2>
            <DiagnosticDeliverySettings />
            <Cs2ConsoleSettings />
            <p>导出版本、运行状态和最近启动记录，便于定位问题。</p>
            <div className="preparation-actions">
              <Button onClick={() => void action(() => openTool('diagnostics'))}>
                运行诊断 / 导出诊断包
              </Button>
            </div>
          </Panel>
        </div>
      ) : tab === 'obs' ? (
        <div className="obs-setup">
          <header className="obs-setup__heading">
            <h2>
              {new URLSearchParams(window.location.search).has('prepare')
                ? '启动游戏前，连接并检查 OBS'
                : 'OBS 连接与配置'}
            </h2>
            <div className="preparation-actions">
              {window.__TAURI_INTERNALS__ ? (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const session = configuration.current;
                      if (!session) return;
                      const result = await session.finish();
                      if (configuration.current === session) configuration.current = null;
                      setMessage(result.message || 'OBS 配置已结束，现有实例已保留。');
                    })
                  }
                >
                  完成 OBS 配置
                </Button>
              ) : null}
              <StatusPill tone={obs?.connection === 'connected' ? 'success' : 'warning'}>
                {obs?.connection === 'connected'
                  ? '已连接'
                  : obs?.connection === 'invalid_password'
                    ? '密码无效'
                    : obs?.connection === 'password_required'
                      ? '需要密码'
                      : '未连接'}
              </StatusPill>
              {obs?.connection === 'connected' ? (
                <Button disabled={busy} onClick={() => void action(() => obsCommand('open'))}>
                  打开 OBS
                </Button>
              ) : null}
            </div>
          </header>
          {obs && obs.connection !== 'connected' ? (
            <StatusBanner tone="warning">
              {obs.connection === 'invalid_password' || obs.connection === 'password_required'
                ? '尚未连接 OBS。请在 OBS 的 WebSocket 服务器设置中重新复制密码，粘贴后保存并测试连接；连接成功后再检查场景。'
                : obs.connectionFailure === 'refused'
                  ? 'OBS 拒绝连接。请打开 OBS，启用 WebSocket 服务器并核对端口，再保存并测试连接。场景配置尚未确认。'
                  : obs.connectionFailure === 'timeout'
                    ? '等待 OBS 响应超时。请确认 OBS 正常响应，再保存并测试连接。场景配置尚未确认。'
                    : 'OBS 连接状态和具体原因尚未确认。请检查 WebSocket 设置并查看诊断；连接成功后再检查场景。'}
            </StatusBanner>
          ) : null}
          <div className="obs-setup__cards" data-connected={obs?.connection === 'connected'}>
            {obs?.connection !== 'connected' ? (
              <Panel>
                <h3>打开 OBS</h3>
                <p>在 OBS「工具 → WebSocket 服务器设置」中启用服务器。</p>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void action(() => obsCommand('open'))}
                >
                  打开 OBS
                </Button>
                {obsPathControl}
              </Panel>
            ) : null}
            <details open={obs?.connection !== 'connected'}>
              <summary>WebSocket 连接设置</summary>
              <Panel>
                <h3>连接控制</h3>
                <p>填写 OBS 提供的端口与密码。</p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action(async () => {
                      await obsCommand('configure', {
                        port,
                        ...(password.length > 0 ? { password } : {}),
                      });
                      setPassword('');
                      await obsCommand('check');
                      setMessage(
                        password.length > 0
                          ? '已保存新密码并测试连接。'
                          : '已保存端口并测试连接，原密码保持不变。',
                      );
                    });
                  }}
                >
                  <Field
                    label="WebSocket 端口"
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(e) => setPortOverride(Number(e.target.value))}
                  />
                  <Field
                    label="WebSocket 密码"
                    type="password"
                    autoComplete="off"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    {...(obs?.passwordConfigured ? { message: '已保存密码，留空保持不变' } : {})}
                  />
                  <Button type="submit" variant="primary" loading={busy}>
                    保存并测试
                  </Button>
                </form>
                {obs?.passwordConfigured ? (
                  <details>
                    <summary>已保存密码</summary>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await obsCommand('configure', { port, password: '' });
                          await obsCommand('check');
                          setMessage('已清除 Mizar 保存的 OBS 密码。');
                        })
                      }
                    >
                      清除已保存密码
                    </Button>
                  </details>
                ) : null}
                {obs?.connection === 'connected' ? obsPathControl : null}
              </Panel>
            </details>
            <Panel role="region" aria-labelledby="obs-configuration-title">
              <h3 id="obs-configuration-title">检查画面</h3>
              <div className="obs-setup__signals">
                <strong>{obs?.currentScene ?? '等待节目场景'}</strong>
                <span>
                  推流 ·{' '}
                  {obs?.connection !== 'connected'
                    ? '无法确认'
                    : obs.streaming
                      ? '进行中'
                      : '未启动'}
                </span>
                <span>
                  录制 ·{' '}
                  {obs?.connection !== 'connected'
                    ? '无法确认'
                    : obs.recording
                      ? '进行中'
                      : '未启动'}
                </span>
              </div>
              {obs?.connection === 'connected' ? (
                <>
                  <ObsCaptureGuidance
                    diagnostic={obs.captureDiagnostic}
                    busy={busy}
                    onCheck={() =>
                      void action(async () => {
                        await obsCommand('check');
                        setMessage('已重新检测，请核对当前提示与 OBS 实际画面。');
                      })
                    }
                  />
                  {obs.sceneAligned === false ? (
                    <StatusBanner tone="warning">
                      OBS 当前节目与 Mizar 选择不一致。请在工作台重新点击要播出的场景。
                    </StatusBanner>
                  ) : evidence?.state === 'measured' &&
                    evidence.capture?.targetAvailable === false ? (
                    <StatusBanner tone="warning">
                      捕获目标已不可选。请确认 CS2 已打开，再在 OBS 核对目标窗口。
                    </StatusBanner>
                  ) : null}
                  <details className="obs-setup__help">
                    <summary>节目与捕获诊断</summary>
                    <p>
                      Mizar 选择 · {obs.expectedScene ?? '待确认'}；编排 ·{' '}
                      {program?.director
                        ? {
                            auto: '自动',
                            manual: '手动保持',
                            blocked: '已暂停',
                            preparation: '准备中',
                          }[program.director.mode]
                        : '待确认'}
                      {program?.director?.reason ? ` · ${program.director.reason}` : ''}
                    </p>
                    <p>
                      场景集合 ·{' '}
                      {evidence ? (evidence.collection === 'mizar' ? 'Mizar' : '其他') : '待确认'}
                    </p>
                    {!evidence || evidence.state !== 'measured' ? (
                      <p>
                        {evidence?.state === 'changed'
                          ? '场景正在变化，等待复查。'
                          : '来源状态待确认，失败原因见诊断包。'}
                      </p>
                    ) : evidence.composition === 'full_screen_graphic' ? (
                      <p>当前节目为全屏包装，不使用游戏采集。</p>
                    ) : null}
                    {evidence?.state === 'measured'
                      ? evidence.sources.map((source) => (
                          <p key={source.role}>
                            {source.role === 'capture' ? '游戏采集' : '播出网页'} · 已添加{' '}
                            {signal(source.present)} · 已启用 {signal(source.enabled)}
                          </p>
                        ))
                      : null}
                    {evidence?.state === 'measured' && evidence.capture ? (
                      <>
                        <p>
                          捕获类型 ·{' '}
                          {
                            { game_capture: '游戏捕获', other: '其他来源', missing: '来源缺失' }[
                              evidence.capture.kind
                            ]
                          }
                          ；目标程序 · {evidence.capture.target ?? '待确认'}；目标可选 ·{' '}
                          {signal(evidence.capture.targetAvailable)}；CS2 可选窗口 ·{' '}
                          {evidence.capture.cs2WindowCount}
                        </p>
                        <p>
                          OBS 报告节目活动 · {signal(evidence.capture.videoActive)}；界面显示 ·{' '}
                          {signal(evidence.capture.videoShowing)}；来源尺寸 ·{' '}
                          {evidence.capture.width ?? '?'} × {evidence.capture.height ?? '?'}
                        </p>
                        <p>状态用于定位来源，实际画面与捕获进程请在 OBS 核对。</p>
                        <a
                          href="https://obsproject.com/kb/game-capture-troubleshooting"
                          target="_blank"
                          rel="noreferrer"
                        >
                          OBS 游戏捕获排查说明
                        </a>
                      </>
                    ) : null}
                  </details>
                  {programIssue &&
                  !obs.findings.length &&
                  !obs.streaming &&
                  !obs.recording ? null : (
                    <StatusBanner tone={obs.findings.length ? 'warning' : 'success'}>
                      {obs.streaming || obs.recording
                        ? 'OBS 正在输出。停止推流与录制后再处理配置。'
                        : obs.findings.some((item) => item.code === 'collection_inactive')
                          ? '请在 OBS「场景集合」中选择 Mizar，再返回继续检查。'
                          : obs.findings.some((item) => item.code === 'source_kind_conflict')
                            ? 'Mizar 来源名称与自定义来源冲突，请先在 OBS 重命名冲突来源。'
                            : sceneRepairNeeded
                              ? 'Mizar 场景配置待恢复，一次修复后自动复查。'
                              : obs.findings.some((item) => item.code === 'video_settings')
                                ? '请在 OBS「设置 → 视频」将画布和输出设为 1920×1080，常用 FPS 设为 60。返回后自动检查。'
                                : obs.findings.some((item) => item.code === 'transition_missing')
                                  ? '请在 OBS「场景转场」中添加淡化和直接切换。'
                                  : obs.findings.length
                                    ? '请在 OBS 检查音频设备、静音和输出音轨，录制试听；具体问题见技术详情。'
                                    : 'Mizar 配置检查通过，请核对实际音画。'}
                    </StatusBanner>
                  )}
                  {sceneRepairNeeded && !sceneRepairBlocked ? (
                    <Button
                      variant="primary"
                      loading={busy}
                      disabled={busy || obs.streaming || obs.recording}
                      onClick={() =>
                        void action(async () => {
                          await obsCommand('repair');
                          await obsCommand('check');
                          setMessage('修复已执行，已重新检查；剩余步骤见当前提示。');
                        })
                      }
                    >
                      {obs.findings.some((item) => item.code === 'collection_missing')
                        ? '创建并启用 Mizar 场景集合'
                        : '一键修复 Mizar 场景'}
                    </Button>
                  ) : null}
                  {obs.findings.length ? (
                    <details className="obs-setup__help">
                      <summary>技术详情 · {obs.findings.length} 项</summary>
                      {obs.findings.map((finding, index) => (
                        <p key={`${finding.code}-${index}`}>{finding.message}</p>
                      ))}
                    </details>
                  ) : null}
                </>
              ) : null}
              <p>
                修复前停止推流与录制。检查通过后，在 OBS
                中核对游戏画面、音频电平和直播输出音轨，并录制试听。
              </p>
              <Button
                disabled={busy || obs?.connection !== 'connected' || obs.streaming || obs.recording}
                onClick={() =>
                  void action(async () => {
                    await obsCommand('audio-setup');
                    await obsCommand('check');
                    setMessage(
                      '已添加系统默认桌面音频与麦克风。请在 OBS 选择实际设备，检查静音、直播音轨并录制试听。',
                    );
                  })
                }
              >
                添加默认桌面音频与麦克风
              </Button>
              <small>
                此操作会在 Mizar 场景中采集系统声音和默认麦克风；自定义设备在 OBS 来源属性中选择。
              </small>
              {obs?.video ? (
                <small>
                  画布 {obs.video.canvas} · 输出 {obs.video.output} · {obs.video.fps.toFixed(0)} fps
                </small>
              ) : null}
            </Panel>
          </div>
          <details className="obs-setup__help">
            <summary>游戏捕获说明</summary>
            <p>
              Mizar 会先建立场景，无需等待 CS2 启动；启动游戏后按 cs2.exe 核实窗口，并在 OBS
              中检查游戏画面。
            </p>
            <p>
              若游戏捕获黑屏，检查 Steam 启动选项 -allow_third_party_software 。由 Mizar
              启动时已临时添加该选项；它可能影响信任系数。
            </p>
          </details>
        </div>
      ) : (
        <div className="settings-grid">
          <Panel className="settings-card settings-card--wide">
            <div className="preparation-check-heading">
              <h2>游戏连接</h2>
              <StatusPill
                tone={
                  gsiPhase === 'failed' || gsi?.readFailed || gsi?.conflict
                    ? 'warning'
                    : gsiPhase === 'ready' && gsi?.installed
                      ? 'success'
                      : 'info'
                }
              >
                {gsiPhase === 'unknown'
                  ? '尚未检测 GSI'
                  : gsiPhase === 'checking'
                    ? '正在检测 GSI'
                    : gsiPhase === 'failed' || gsi?.readFailed
                      ? '无法检查 GSI'
                      : gsi?.conflict
                        ? '需检查'
                        : gsi?.installed
                          ? 'GSI 文件已配置'
                          : '待安装 GSI'}
              </StatusPill>
            </div>
            <p>
              新写入的 GSI 将在下次启动 CS2
              时加载；若游戏已运行，请重启。收到实际数据后，总览会更新游戏数据状态。
            </p>
            <p>
              {cs2Phase === 'unknown'
                ? 'CS2 窗口状态待确认'
                : cs2Phase === 'checking'
                  ? '正在检测 CS2 窗口'
                  : cs2Phase === 'failed'
                    ? '无法读取 CS2 窗口状态'
                    : cs2?.found
                      ? cs2.managed
                        ? 'CS2 窗口已就绪'
                        : '已检测到 CS2，打开工作台后安排窗口'
                      : '等待 CS2 窗口'}
            </p>
            {cs2?.message ? <p role="alert">{cs2.message}</p> : null}
            {gsiError ? (
              <StatusBanner tone="warning">
                GSI 读取失败：{gsiError} 点击「重新检查 CS2 与
                GSI」重查；详细原因见高级设置中的诊断与支持。
              </StatusBanner>
            ) : null}
            {cs2Error ? (
              <StatusBanner tone="warning">
                CS2 窗口读取失败：{cs2Error} 点击「重新检查 CS2 与
                GSI」重查；详细原因见高级设置中的诊断与支持。
              </StatusBanner>
            ) : null}
            {gsi?.issues?.map((issue) => (
              <StatusBanner key={issue.code} tone={gsi.readFailed ? 'danger' : 'warning'}>
                {issue.message}
              </StatusBanner>
            ))}
            {gsi?.endpointConflict ? (
              <>
                <ul className="settings-conflict-files">
                  {gsi.conflictFiles.map((path) => (
                    <li key={path}>
                      <code>{path}</code>
                    </li>
                  ))}
                </ul>
                <p>
                  点击「一键安装 / 修复 GSI」，自动备份并停用这些重复配置；可通过「恢复原 GSI
                  配置」撤销。其他接收地址的配置会保留。
                </p>
              </>
            ) : null}
            {!window.__TAURI_INTERNALS__ ? (
              <p>请在 Mizar 桌面应用中检测并安装 GSI。</p>
            ) : (
              <div className="preparation-actions">
                <Button
                  variant={
                    gsiPhase !== 'ready' || gsi?.readFailed || cs2Phase === 'failed'
                      ? 'primary'
                      : 'secondary'
                  }
                  disabled={busy}
                  onClick={() => void action(refreshGsi)}
                >
                  重新检查 CS2 与 GSI
                </Button>
                <Button
                  disabled={busy}
                  variant={
                    gsiPhase === 'ready' && !gsi?.readFailed && (!gsi?.installed || gsi?.conflict)
                      ? 'primary'
                      : 'secondary'
                  }
                  onClick={() =>
                    void action(async () => {
                      await desktopInvoke('configure_gsi', { restore: false, choose: false });
                      const event = new Event('mizar:gsi-configured');
                      ownConfiguredEvent.current = event;
                      window.dispatchEvent(event);
                      ownConfiguredEvent.current = null;
                      const next = await refreshGsi();
                      setMessage(
                        next?.installed && !next.conflict && !next.readFailed
                          ? 'GSI 文件已配置，请重新启动 CS2 以加载配置。'
                          : '已执行安装检查，请处理上方列出的问题后重新检查。',
                      );
                    })
                  }
                >
                  一键安装 / 修复 GSI
                </Button>
                <Button
                  disabled={busy || (!gsi?.installed && !gsi?.conflict)}
                  onClick={() =>
                    void action(async () => {
                      await desktopInvoke('configure_gsi', { restore: true, choose: false });
                      await refreshGsi();
                      setMessage('原 GSI 配置已恢复，请重新启动 CS2 以加载配置。');
                    })
                  }
                >
                  恢复原 GSI 配置
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const selected = await desktopInvoke<boolean>('select_cs2_installation', {
                        executable: false,
                      });
                      if (selected) {
                        await refreshGsi();
                        setMessage(
                          '已保存 CS2 安装位置，游戏启动与 GSI 安装共用此位置。请安装或检查 GSI。',
                        );
                      }
                    })
                  }
                >
                  选择 CS2 安装目录
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const selected = await desktopInvoke<boolean>('select_cs2_installation', {
                        executable: true,
                      });
                      if (selected) {
                        await refreshGsi();
                        setMessage(
                          '已保存 CS2 安装位置，游戏启动与 GSI 安装共用此位置。请安装或检查 GSI。',
                        );
                      }
                    })
                  }
                >
                  选择 cs2.exe
                </Button>
                <Button
                  disabled={busy || !gsi?.cfgPath}
                  onClick={() => void action(() => desktopInvoke('open_cs2_config_directory'))}
                >
                  打开配置文件夹
                </Button>
              </div>
            )}
            <details>
              <summary>详细信息</summary>
              <p>
                支持选择 CS2 安装根目录、game\bin\win64 文件夹或
                cs2.exe。更换安装位置前，请先恢复当前 GSI 配置；受管理游戏退出并恢复设置后才能更换。
              </p>
              <p className="settings-conflict-files">
                {gsi?.cfgPath ??
                  (gsiPhase === 'ready' && !gsi?.readFailed
                    ? '尚未发现配置目录'
                    : '配置目录待确认')}
              </p>
              {gsi ? <p>安装候选数量：{gsi.candidateCount ?? 0}</p> : null}
            </details>
          </Panel>
          <Cs2LaunchSettings />
          <SteamAvatarSettings />
        </div>
      )}
      {message ? <StatusBanner tone="info">{message}</StatusBanner> : null}
    </>
  );
}
