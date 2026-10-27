import { BpPresentationSettingsPanel } from './BpPresentationSettings';
import { ObserverSettingsPanel, GameAutomationSettingsPanel } from './ObserverSettings';
import { ObsSettings } from './ObsSettings';
import { CameraSettings } from '../orchestration/CameraSettings';
import { Cs2ConsoleSettings } from '../debug/Cs2ConsoleSettings';
import {
  DiagnosticDeliverySettings,
  DiagnosticProblemReport,
} from '../debug/DiagnosticDeliverySettings';
import { SoundSettings } from '../audio/SoundSettings';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Panel, StatusBanner, StatusPill } from '../ui';
import { desktopInvoke } from '../workspace/client';
import { RivalHubPreparationPanel } from '../operator/RivalHubPreparationPanel';
import { openTool, useLocalRead, type Production } from './client';
import { Cs2Recovery } from './Cs2Recovery';
import { Cs2BackupImport } from './Cs2BackupImport';
import { Cs2LaunchSettings } from './Cs2LaunchSettings';
import { SteamAvatarSettings } from './SteamAvatarSettings';
import { UpdateSettings } from './UpdateSettings';
import { ResourceSettings } from './ResourceSettings';

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
  const production = useLocalRead<Production>(
    window.__TAURI_INTERNALS__ ? '/local/v1/production' : null,
  );
  const readiness =
    useLocalRead<{ label: string; ready: boolean; reason: string }[]>('/local/v1/readiness');
  const gameData = readiness?.find((item) => item.label === 'CS2 / GSI');
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
  const gsiInstallButton = (
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
      {gsi?.conflict ? '修复 GSI' : '安装 GSI'}
    </Button>
  );
  if (tab === 'observer') return <ObserverSettingsPanel />;
  if (tab === 'music') return <SoundSettings />;
  if (tab === 'camera') return <CameraSettings />;

  return (
    <>
      {tab === 'rivalhub' ? (
        <RivalHubPreparationPanel mode="settings" />
      ) : tab === 'advanced' ? (
        <div className="settings-grid advanced-settings-layout">
          <div className="advanced-settings-column">
            <UpdateSettings>
              <details className="settings-details">
                <summary>构建详情</summary>
                <dl className="settings-identity">
                  <div>
                    <dt>Commit</dt>
                    <dd>
                      <code>{product?.product?.gitSha ?? '不可用'}</code>
                    </dd>
                  </div>
                  {product?.product?.artifactSha256 ? (
                    <div>
                      <dt>产品包校验信息</dt>
                      <dd>
                        <code>{product.product.artifactSha256}</code>
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </details>
            </UpdateSettings>
            <ResourceSettings />
          </div>
          <Panel className="settings-card advanced-settings-support">
            <h2>诊断与支持</h2>
            <p>遇到问题时，先记录发生时间，再导出诊断包交给维护者。</p>
            <div className="preparation-actions">
              <Button variant="primary" onClick={() => void action(() => openTool('diagnostics'))}>
                导出诊断包
              </Button>
            </div>
            <DiagnosticProblemReport />
            <section className="advanced-settings-section">
              <h3>自动发送诊断</h3>
              <DiagnosticDeliverySettings showProblemReport={false} />
            </section>
            <Cs2ConsoleSettings />
          </Panel>
        </div>
      ) : tab === 'obs' ? (
        <>
          <BpPresentationSettingsPanel />
          <ObsSettings />
        </>
      ) : (
        <div className="game-settings-layout">
          <div className="game-settings-current">
            <Panel className="settings-card game-settings-connection">
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
              <div className="game-settings-signals">
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
                <p role="status">
                  {!gameData
                    ? '游戏数据 · 状态待确认'
                    : gameData.ready
                      ? '游戏数据 · 已收到'
                      : `游戏数据 · ${gameData.reason}`}
                </p>
              </div>
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
                  <p>
                    点击「修复 GSI」，自动备份并停用这些重复配置；可通过「恢复原 GSI
                    配置」撤销。其他接收地址的配置会保留。
                  </p>
                </>
              ) : null}
              {!window.__TAURI_INTERNALS__ ? (
                <p>请在 Mizar 桌面应用中检测并安装 GSI。</p>
              ) : (
                <>
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
                    {!gsi?.installed || gsi?.conflict ? gsiInstallButton : null}
                  </div>
                </>
              )}
              <section aria-label="配置与恢复">
                <Cs2Recovery production={production} />
              </section>
            </Panel>
            <Panel className="settings-card game-settings-maintenance">
              <h2>安装位置与维护</h2>
              <p>安装位置、GSI 配置与游戏设置备份在这里分别管理。</p>
              {window.__TAURI_INTERNALS__ ? (
                <details
                  key={String(Boolean(gsi && !gsi.detected))}
                  open={Boolean(gsi && !gsi.detected)}
                >
                  <summary>安装位置与 GSI 维护</summary>
                  <p>更换安装位置前，先恢复当前 GSI 配置。新写入的配置在下次启动 CS2 时加载。</p>
                  <div className="preparation-actions">
                    {gsi?.installed && !gsi.conflict ? gsiInstallButton : null}
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
                </details>
              ) : (
                <p>请在桌面应用中管理安装位置与配置。</p>
              )}{' '}
              <details>
                <summary>配置详情{gsi?.endpointConflict ? ' · 重复文件' : ''}</summary>
                {gsi?.endpointConflict ? (
                  <ul className="settings-conflict-files">
                    {gsi.conflictFiles.map((path) => (
                      <li key={path}>
                        <code>{path}</code>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p>
                  支持选择 CS2 安装根目录、game\bin\win64 文件夹或
                  cs2.exe。更换安装位置前，请先恢复当前 GSI
                  配置；受管理游戏退出并恢复设置后才能更换。
                </p>
                <p className="settings-conflict-files">
                  {gsi?.cfgPath ??
                    (gsiPhase === 'ready' && !gsi?.readFailed
                      ? '尚未发现配置目录'
                      : '配置目录待确认')}
                </p>
                {gsi ? <p>安装候选数量：{gsi.candidateCount ?? 0}</p> : null}
              </details>
              {window.__TAURI_INTERNALS__ ? (
                <details>
                  <summary>游戏设置备份</summary>
                  <Cs2BackupImport />
                  <p>
                    游戏设置备份用于恢复 Mizar 启动前的画质、帧率与观战设置，与 GSI
                    接收配置不同。需要恢复时，上方游戏连接区域会显示处理入口。
                  </p>
                  <Button
                    disabled={busy}
                    onClick={() => void action(() => desktopInvoke('open_cs2_backup'))}
                  >
                    打开游戏设置备份目录
                  </Button>
                </details>
              ) : null}
            </Panel>
          </div>
          <div className="game-settings-preferences">
            <Cs2LaunchSettings />
            <GameAutomationSettingsPanel />
            <SteamAvatarSettings />
          </div>
        </div>
      )}
      {message ? <StatusBanner tone="info">{message}</StatusBanner> : null}
    </>
  );
}
