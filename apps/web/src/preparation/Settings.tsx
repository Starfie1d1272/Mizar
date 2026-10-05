import { useEffect, useState } from 'react';
import { Button, Field, Panel, StatusBanner } from '../ui';
import { desktopInvoke } from '../workspace/client';
import { obsCommand, useObsStatus } from '../workspace/obs-client';
import { RivalHubPreparationPanel } from '../operator/RivalHubPreparationPanel';
import { openTool, useLocalRead } from './client';

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
        <Panel>
          <h2>OBS</h2>
          <p>
            {obs?.connection === 'connected'
              ? '已连接'
              : obs?.connection === 'password_required'
                ? '需要 WebSocket 密码'
                : obs?.connection === 'invalid_password'
                  ? '密码无效，请重新输入'
                  : '尚未连接 OBS'}
          </p>
          <p>
            {obs?.currentScene ?? '等待节目场景'}
            {obs?.sceneAligned === false ? ' · 场景需要核对' : ''}
          </p>
          <p>
            推流 {obs?.streaming ? '进行中' : '未启动'} · 录制{' '}
            {obs?.recording ? '进行中' : '未启动'}
          </p>
          {obs?.video ? (
            <p>
              画布 {obs.video.canvas} · 输出 {obs.video.output} · {obs.video.fps.toFixed(0)} fps
            </p>
          ) : null}
          <div className="preparation-actions">
            <Button disabled={busy} onClick={() => void action(() => obsCommand('open'))}>
              打开 OBS
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const result = (await obsCommand('check')) as { findings: { message: string }[] };
                  setMessage(
                    result.findings.map((item) => item.message).join('；') || '配置检查通过。',
                  );
                })
              }
            >
              检查配置
            </Button>
            <Button
              disabled={busy}
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
          </div>
          {obs?.findings.map((finding) => (
            <StatusBanner key={finding.code} tone="warning">
              {finding.message}
            </StatusBanner>
          ))}
          <details
            open={obs?.connection === 'password_required' || obs?.connection === 'invalid_password'}
          >
            <summary>高级连接设置</summary>
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
              />
              <Button type="submit" loading={busy}>
                保存并测试
              </Button>
            </form>
            {window.__TAURI_INTERNALS__ ? (
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
            ) : null}
            {obs?.passwordConfigured ? (
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
            ) : null}
          </details>
        </Panel>
      ) : (
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
      )}
      {message ? <StatusBanner tone="info">{message}</StatusBanner> : null}
    </>
  );
}
