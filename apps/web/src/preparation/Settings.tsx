import { useEffect, useState } from 'react';
import { Button, Field, Panel, StatusBanner, StatusPill } from '../ui';
import { desktopInvoke } from '../workspace/client';
import { obsCommand, useObsStatus } from '../workspace/obs-client';
import { RivalHubPreparationPanel } from '../operator/RivalHubPreparationPanel';
import { openTool, useLocalRead } from './client';
import { Cs2LaunchSettings } from './Cs2LaunchSettings';
import { SteamAvatarSettings } from './SteamAvatarSettings';
import { UpdateSettings } from './UpdateSettings';

export function Settings({ tab }: { tab: string }) {
  const obs = useObsStatus();
  const [portOverride, setPortOverride] = useState<number | null>(null);
  const port = portOverride ?? obs?.port ?? 4455;
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
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
  const [cs2, setCs2] = useState<{ found: boolean; managed: boolean } | null>(null);
  const product = useLocalRead<{
    product?: { appVersion?: string; gitSha?: string; artifactSha256?: string };
  }>('/health', 60_000);
  const refreshGsi = async () => {
    if (window.__TAURI_INTERNALS__) {
      setGsi(await desktopInvoke('gsi_status'));
      setCs2(await desktopInvoke('cs2_host_status'));
    }
  };
  useEffect(() => {
    let active = true;
    async function load() {
      if (!window.__TAURI_INTERNALS__) return;
      try {
        const [nextGsi, nextCs2] = await Promise.all([
          desktopInvoke<NonNullable<typeof gsi>>('gsi_status'),
          desktopInvoke<NonNullable<typeof cs2>>('cs2_host_status'),
        ]);
        if (active) {
          setGsi(nextGsi);
          setCs2(nextCs2);
        }
      } catch {
        if (active) setMessage('无法读取 CS2 安装状态，请重新检测。');
      }
    }
    void load();
    const reload = () => void load();
    window.addEventListener('mizar:gsi-configured', reload);
    return () => {
      window.removeEventListener('mizar:gsi-configured', reload);
      active = false;
    };
  }, []);
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
  return (
    <>
      {tab === 'rivalhub' ? (
        <RivalHubPreparationPanel mode="settings" />
      ) : tab === 'advanced' ? (
        <div className="settings-grid">
          <UpdateSettings />
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
            <StatusPill tone={obs?.connection === 'connected' ? 'success' : 'warning'}>
              {obs?.connection === 'connected'
                ? '已连接'
                : obs?.connection === 'invalid_password'
                  ? '密码无效'
                  : obs?.connection === 'password_required'
                    ? '需要密码'
                    : '未连接'}
            </StatusPill>
          </header>
          <div className="obs-setup__cards">
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
              {window.__TAURI_INTERNALS__ ? (
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
              ) : null}
            </Panel>
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
              </Panel>
            </details>
            <Panel>
              <h3>检查画面</h3>
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
              <Button
                disabled={busy || obs?.connection !== 'connected' || obs.streaming || obs.recording}
                onClick={() =>
                  void action(async () => {
                    const result = (await obsCommand('repair')) as {
                      findings: { message: string }[];
                    };
                    setMessage(
                      result.findings.map((item) => item.message).join('；') ||
                        'Mizar 场景已修复，配置检查通过。',
                    );
                  })
                }
              >
                修复 Mizar 场景
              </Button>
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
          {obs?.findings.map((finding) => (
            <StatusBanner key={finding.code} tone="warning">
              {finding.message}
            </StatusBanner>
          ))}
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
                  gsi?.readFailed || gsi?.conflict ? 'warning' : gsi?.installed ? 'success' : 'info'
                }
              >
                {gsi?.readFailed
                  ? '无法检查'
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
              {cs2?.found
                ? cs2.managed
                  ? 'CS2 窗口已就绪'
                  : '已检测到 CS2，打开工作台后安排窗口'
                : '等待 CS2 窗口'}
            </p>
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
                <Button disabled={busy} onClick={() => void action(refreshGsi)}>
                  重新检查 CS2 与 GSI
                </Button>
                <Button
                  disabled={busy}
                  variant={gsi?.installed ? 'secondary' : 'primary'}
                  onClick={() =>
                    void action(async () => {
                      try {
                        await desktopInvoke('configure_gsi', { restore: false, choose: false });
                        window.dispatchEvent(new Event('mizar:gsi-configured'));
                        const next = await desktopInvoke<NonNullable<typeof gsi>>('gsi_status');
                        setGsi(next);
                        setMessage(
                          next.installed && !next.conflict && !next.readFailed
                            ? 'GSI 文件已配置，请重新启动 CS2 以加载配置。'
                            : '已执行安装检查，请处理上方列出的问题后重新检查。',
                        );
                      } finally {
                        await refreshGsi();
                      }
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
              <p className="settings-conflict-files">{gsi?.cfgPath ?? '尚未发现配置目录'}</p>
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
