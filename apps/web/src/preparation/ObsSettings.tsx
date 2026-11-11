import { prepareObs, useObsPreparation } from '../workspace/obs-preparation';
import { useEffect, useRef, useState } from 'react';
import type { ProgramSceneState } from '@mizar/protocol/program-scenes';
import { Button, Field, Panel, StatusBanner, StatusPill } from '../ui';
import { ObsCaptureGuidance } from '../workspace/ObsCaptureGuidance';
import {
  beginObsConfiguration,
  obsCommand,
  obsStreamLabel,
  useObsStatus,
} from '../workspace/obs-client';
import { desktopInvoke } from '../workspace/client';
import { useLocalRead } from './client';

export function ObsSettings() {
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
      'capture_warmup_pending',
      'collection_missing',
      'collection_inactive',
      'scene_missing',
      'source_missing',
      'url_drift',
      'capture_drift',
      'transform_drift',
      'order_drift',
      'source_disabled',
    ].includes(item.code),
  );
  const sceneRepairBlocked = obs?.findings.some((item) => item.code === 'source_kind_conflict');
  const [portOverride, setPortOverride] = useState<number | null>(null);
  const port = portOverride ?? obs?.port ?? 4455;
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const configuration = useRef<ReturnType<typeof beginObsConfiguration> | null>(null);
  const latestConfiguration = useRef<ReturnType<typeof beginObsConfiguration> | null>(null);
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
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
            window.dispatchEvent(new Event('mizar:obs-configuration-finished'));
        })
        .catch(() => {
          if (
            notify &&
            opened &&
            configuration.current === null &&
            latestConfiguration.current === session
          )
            window.dispatchEvent(new Event('mizar:obs-configuration-finished'));
        });
    };
  }, []);

  const preparation = useObsPreparation();
  const preparing = preparation.phase === 'running';
  const connected = obs?.connection === 'connected';
  const authenticationRequired =
    obs?.facts?.authentication === 'required' || obs?.facts?.authentication === 'rejected';
  const executableMissing = obs?.facts?.executable === 'not_found';
  const processStopped = obs?.facts?.process === 'stopped';
  const listenerRefused = obs?.facts?.listener === 'refused';
  const connectionGuidance = executableMissing
    ? '未找到 OBS。请选择已安装的 OBS 程序；尚未安装时请先安装 OBS。'
    : processStopped
      ? 'OBS 尚未运行，请先打开 OBS。'
      : authenticationRequired
        ? 'OBS 已响应，需要核对密码。在「工具 → WebSocket 服务器设置」复制密码后粘贴到下方。'
        : listenerRefused
          ? '此端口尚未监听。请在 OBS「工具 → WebSocket 服务器设置」启用服务器，并核对端口。'
          : obs?.connectionFailure === 'timeout'
            ? '等待 OBS 响应超时。请确认 OBS 能正常操作，再重新检查连接。'
            : '正在确认 OBS 连接。请确认 OBS 已打开，并启用 WebSocket 服务器。';
  async function selectExecutable() {
    const path = await desktopInvoke('select_obs_executable');
    if (path) await obsCommand('configure', { executablePath: path });
  }
  const outputActive = Boolean(connected && (obs.streaming === true || obs.recording === true));
  const outputUnknown = Boolean(
    connected &&
    (typeof obs.streaming !== 'boolean' ||
      typeof obs.recording !== 'boolean' ||
      obs.findings.some((item) => item.code === 'output_query_failed')),
  );
  const outputBlocked = outputActive || outputUnknown;
  async function action(run: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    setMessage('');
    try {
      await run();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : '操作未完成，请重试。');
    } finally {
      setBusy(false);
    }
  }
  const obsPathControl = window.__TAURI_INTERNALS__ ? (
    <details>
      <summary>OBS 路径</summary>
      <Button
        disabled={busy || preparing}
        onClick={() =>
          void action(async () => {
            const path = await desktopInvoke('select_obs_executable');
            if (path) await obsCommand('configure', { executablePath: path });
          })
        }
      >
        更改 OBS 路径
      </Button>
    </details>
  ) : null;

  return (
    <div className="obs-settings">
      <div className="obs-settings-summary">
        <div>
          <StatusPill tone={connected ? 'success' : 'info'}>
            {connected
              ? 'OBS 已连接'
              : obs?.connection === 'invalid_password'
                ? 'OBS 密码无效'
                : 'OBS 未连接'}
          </StatusPill>
          <span>直播 · {obsStreamLabel(obs)}</span>
          <span>
            录制 ·{' '}
            {connected && typeof obs.recording === 'boolean'
              ? obs.recording
                ? '进行中'
                : '未开始'
              : '待确认'}
          </span>
        </div>
        <Button disabled={busy || preparing} onClick={() => void action(() => obsCommand('open'))}>
          打开 OBS
        </Button>
      </div>
      {message &&
      !(
        failed &&
        connected &&
        preparation.phase === 'failed' &&
        message === preparation.message
      ) ? (
        <StatusBanner tone={failed ? 'danger' : 'info'}>{message}</StatusBanner>
      ) : null}
      {preparing ? (
        <StatusBanner tone="info">{preparation.message} 无需逐项点击配置。</StatusBanner>
      ) : null}
      {connected && !preparing && preparation.phase === 'failed' ? (
        <StatusBanner tone="warning">
          {preparation.message}
          <Button disabled={busy || outputBlocked} onClick={() => void action(prepareObs)}>
            重试自动配置
          </Button>
        </StatusBanner>
      ) : null}
      {connected && outputActive && obs.findings.length > 0 ? (
        <StatusBanner tone="info">正在直播或录制，停止输出后可配置 Mizar 场景。</StatusBanner>
      ) : null}
      {outputUnknown && !outputActive ? (
        <StatusBanner tone="info">
          OBS 已连接，但直播或录制状态尚未确认。请在 OBS 核对后重新检查，确认未输出后再配置场景。
          <Button
            disabled={busy || preparing}
            onClick={() => void action(() => obsCommand('check'))}
          >
            重新检查输出状态
          </Button>
        </StatusBanner>
      ) : null}
      <div className="obs-settings-columns">
        <div className="obs-settings-column">
          <Panel className="settings-card">
            <h2>OBS 控制连接</h2>
            <p>连接后，Mizar 可以自动切换节目并读取直播与录制状态。</p>
            {!connected ? (
              <StatusBanner tone={authenticationRequired || executableMissing ? 'warning' : 'info'}>
                {connectionGuidance}
                {executableMissing ? (
                  <a href="https://obsproject.com/download" target="_blank" rel="noreferrer">
                    前往 OBS 官网下载
                  </a>
                ) : null}
                {!authenticationRequired ? (
                  <Button
                    variant="primary"
                    disabled={busy || preparing}
                    onClick={() =>
                      void action(
                        executableMissing && window.__TAURI_INTERNALS__
                          ? selectExecutable
                          : processStopped
                            ? () => obsCommand('open')
                            : () => obsCommand('check'),
                      )
                    }
                  >
                    {executableMissing && window.__TAURI_INTERNALS__
                      ? '选择 OBS 程序'
                      : processStopped
                        ? '打开 OBS'
                        : '重新检查连接'}
                  </Button>
                ) : null}
              </StatusBanner>
            ) : null}

            <details key={String(authenticationRequired)} open={authenticationRequired}>
              <summary>{authenticationRequired ? '填写 OBS 密码' : '端口与密码设置'}</summary>
              <p>使用 OBS「工具 → WebSocket 服务器设置」中显示的端口与密码。</p>
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
                <Button type="submit" variant="primary" loading={busy || preparing}>
                  保存并测试
                </Button>
              </form>
              {obs?.passwordConfigured ? (
                <details>
                  <summary>已保存密码</summary>
                  <Button
                    disabled={busy || preparing}
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
            </details>
            {obsPathControl}
          </Panel>
        </div>
        <Panel className="settings-card" role="region" aria-labelledby="obs-configuration-title">
          <div className="obs-settings-check-heading">
            <h2 id="obs-configuration-title">节目检查</h2>
            <Button
              disabled={busy || preparing || !connected}
              onClick={() =>
                void action(async () => {
                  await obsCommand('check');
                  setMessage('已重新检测，请核对当前提示与 OBS 实际画面。');
                })
              }
            >
              重新检查
            </Button>
          </div>
          {!connected ? (
            <div className="obs-settings-empty">
              <strong>等待连接 OBS</strong>
              <p>连接成功后，自动检查 Mizar 场景与游戏捕获。当前无法确认节目和音频状态。</p>
            </div>
          ) : (
            <>
              <div className="obs-settings-program">
                <span>当前节目</span>
                <strong>{obs.currentScene ?? '待确认'}</strong>
                {obs.video ? (
                  <span>
                    画布 {obs.video.canvas} · 输出 {obs.video.output} · {obs.video.fps.toFixed(0)}{' '}
                    fps
                  </span>
                ) : null}
              </div>
              {obs?.connection === 'connected' ? (
                <>
                  <ObsCaptureGuidance
                    expanded
                    diagnostic={obs.captureDiagnostic}
                    busy={busy || preparing}
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
                  {preparing || outputUnknown || (programIssue && !obs.findings.length) ? null : (
                    <StatusBanner tone={obs.findings.length ? 'warning' : 'success'}>
                      {(obs.streaming || obs.recording) && obs.findings.length > 0
                        ? 'OBS 正在输出，当前配置问题请在停止推流与录制后处理。'
                        : obs.findings.some((item) => item.code === 'collection_inactive')
                          ? '当前使用其他场景集合。可点击下方按钮配置 Mizar 场景。'
                          : obs.findings.some((item) => item.code === 'source_kind_conflict')
                            ? 'Mizar 来源名称与自定义来源冲突，请先在 OBS 重命名冲突来源。'
                            : sceneRepairNeeded
                              ? 'Mizar 场景尚未就绪，可点击下方按钮配置并复查。'
                              : obs.findings.some((item) => item.code === 'video_settings')
                                ? '请在 OBS「设置 → 视频」将画布和输出设为 1920×1080，常用 FPS 设为 60。返回后自动检查。'
                                : obs.findings.some((item) => item.code === 'transition_missing')
                                  ? '请在 OBS「场景转场」中添加淡化和直接切换。'
                                  : obs.findings.some((item) => item.code.startsWith('audio_game_'))
                                    ? obs.findings.find((item) =>
                                        item.code.startsWith('audio_game_'),
                                      )?.message
                                    : obs.findings.some((item) => item.code.includes('audio'))
                                      ? '请到声音设置核对采集设备、静音与音频恢复；在 OBS 核对输出音轨并录制试听。'
                                      : (obs.findings[0]?.message ??
                                        'Mizar 配置检查通过，请核对实际音画。')}
                    </StatusBanner>
                  )}
                  {sceneRepairNeeded && !sceneRepairBlocked && !preparing ? (
                    <Button
                      variant="primary"
                      loading={busy || preparing}
                      disabled={busy || preparing || outputBlocked}
                      onClick={() =>
                        void action(async () => {
                          await prepareObs();
                          setMessage('修复已执行，已重新检查；剩余步骤见当前提示。');
                        })
                      }
                    >
                      配置 Mizar 场景
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

              <p>配置检查不能代替实际音画检查。请在 OBS 核对画面，并录制试听。</p>
            </>
          )}
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
        </Panel>
      </div>
      {window.__TAURI_INTERNALS__ ? (
        <details className="obs-settings-session">
          <summary>OBS 配置窗口管理</summary>
          <p>
            进入本页会建立 OBS 配置会话，离开时自动结束。结束会话不代表音画检查通过，OBS
            窗口是否保留由当前实例与输出状态决定。
          </p>
          <Button
            disabled={busy || preparing}
            onClick={() =>
              void action(async () => {
                const session = configuration.current;
                if (!session) return;
                const result = await session.finish();
                if (configuration.current === session) configuration.current = null;
                setMessage(result.message || 'OBS 配置会话已结束。');
              })
            }
          >
            结束本次配置会话
          </Button>
        </details>
      ) : null}
    </div>
  );
}
