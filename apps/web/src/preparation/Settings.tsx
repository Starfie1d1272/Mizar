import { useEffect, useState } from 'react';
import { Button, Field, Panel, StatusBanner, StatusPill } from '../ui';
import { desktopInvoke } from '../workspace/client';
import { obsCommand, useObsStatus } from '../workspace/obs-client';
import { RivalHubPreparationPanel } from '../operator/RivalHubPreparationPanel';
import { openTool, useLocalRead } from './client';
import { Cs2LaunchSettings } from './Cs2LaunchSettings';

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
  } | null>(null);
  const [cs2, setCs2] = useState<{ found: boolean; managed: boolean } | null>(null);
  const product = useLocalRead<{ product?: { gitSha?: string; artifactSha256?: string } }>(
    '/health',
    60_000,
  );
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
    return () => {
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
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {tab === 'rivalhub' ? (
        <RivalHubPreparationPanel mode="settings" />
      ) : tab === 'advanced' ? (
        <Panel>
          <h2>运行信息</h2>
          <p>
            Mizar 构建 ·{' '}
            {product?.product?.gitSha
              ? product.product.gitSha.slice(0, 12)
              : '开发环境或版本信息不可用'}
          </p>
          {product?.product?.artifactSha256 ? (
            <p>产品包摘要 · {product.product.artifactSha256.slice(0, 12)}</p>
          ) : null}
          <p>遇到异常时，可导出包含版本、运行状态和最近启动记录的诊断包，提交给维护者。</p>
          <Button onClick={() => void action(() => openTool('diagnostics'))}>
            运行诊断 / 导出诊断包
          </Button>
        </Panel>
      ) : tab === 'obs' ? (
        <div className="obs-setup">
          <header className="obs-setup__heading">
            <h2>
              {new URLSearchParams(window.location.search).has('prepare')
                ? '进入现场前，连接并检查 OBS'
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
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const result = (await obsCommand('check')) as {
                      findings: { message: string }[];
                    };
                    setMessage(
                      result.findings.map((item) => item.message).join('；') || '配置检查通过。',
                    );
                  })
                }
              >
                检查配置
              </Button>
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
              <p>修复前停止推流与录制。检查通过后，在 OBS 中核对游戏画面。</p>
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
              先打开 CS2，再检查或修复场景。Mizar 按 cs2.exe 匹配实际窗口；配置检查通过后，仍需核对
              OBS 的游戏画面。
            </p>
            <p>
              若游戏捕获黑屏，检查 Steam 启动选项 -allow_third_party_software
              并重启游戏。该选项可能影响信任系数；Mizar 不会自动修改启动选项。
            </p>
          </details>
        </div>
      ) : (
        <>
          <Cs2LaunchSettings />
          <Panel>
            <h2>CS2 与 GSI</h2>
            <p>
              {cs2?.found
                ? cs2.managed
                  ? 'CS2 窗口已就绪'
                  : '已检测到 CS2，进入现场后安排窗口'
                : '等待 CS2 窗口'}
            </p>
            <p>
              {gsi?.conflict
                ? gsi.fileConflict
                  ? 'Mizar GSI 文件与安装记录不一致，请恢复原配置后重新安装'
                  : '发现其它 GSI 配置也在发送数据，可能产生重复采集'
                : gsi?.installed
                  ? 'GSI 已安装'
                  : 'GSI 尚未安装'}
            </p>
            {!window.__TAURI_INTERNALS__ ? (
              <p>请在 Mizar 桌面应用中检测并安装 GSI。</p>
            ) : (
              <div className="preparation-actions">
                <Button disabled={busy} onClick={() => void action(refreshGsi)}>
                  自动检测 CS2
                </Button>
                <Button
                  disabled={busy}
                  variant="primary"
                  onClick={() =>
                    void action(async () => {
                      await desktopInvoke('configure_gsi', { restore: false, choose: false });
                      await refreshGsi();
                      setMessage('GSI 已安装，请重新启动 CS2 以加载配置。');
                    })
                  }
                >
                  安装 / 修复 GSI
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
                {!gsi?.detected ? (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await desktopInvoke('configure_gsi', { restore: false, choose: true });
                        await refreshGsi();
                      })
                    }
                  >
                    选择 CS2 安装目录
                  </Button>
                ) : null}
              </div>
            )}
            <details>
              <summary>详细信息</summary>
              <p>{gsi?.cfgPath ?? '尚未发现配置目录'}</p>
            </details>
          </Panel>
        </>
      )}
      {message ? <StatusBanner tone="info">{message}</StatusBanner> : null}
    </>
  );
}
