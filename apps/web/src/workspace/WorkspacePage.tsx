import { useEffect, useState, useSyncExternalStore } from 'react';
import { PROGRAM_SCENES } from '@mizar/protocol/program-scenes';
import type { OperatorPayload } from '@mizar/protocol/operator';
import type { ProgramPayload } from '@mizar/protocol/program';
import { getRadarArtwork } from '@mizar-hud/radar-view';
import { useLocalChannelClient } from '../realtime';
import { Radar } from '../program/widgets/radar/Radar';
import { hasRadarViewFrame } from '../program/widgets/radar/adapter';
import { desktopInvoke, selectProgramScene, useProgramScenes } from './client';
import { workspaceCurrentPov, workspaceIssues, workspaceMatchScore } from './model';
import { useObsStatus } from './obs-client';
import {
  useLocalRead,
  useLocalReadWithTime,
  openTool,
  productionAction,
  type Production,
  command,
} from '../preparation/client';
import { Button, StatusPill, Dialog } from '../ui';
import { ProductionStatus } from './ProductionStatus';
import { SpectatorHudCommands } from '../preparation/SpectatorHudCommands';
import { LocalOverlayControls } from '../preparation/LocalOverlayControls';
import { RecoveryPanel } from './RecoveryPanel';
import './workspace.css';

async function openPreparation(path: string) {
  if (window.__TAURI_INTERNALS__) await desktopInvoke('open_main', { path });
  else window.open(path, 'mizar-preparation');
}

function ContextPanel({
  operator,
  program,
}: {
  readonly operator: OperatorPayload | null;
  readonly program: ProgramPayload | null;
}) {
  const match = operator?.matchContext.summary;
  const score = workspaceMatchScore(program);
  const pov = workspaceCurrentPov(program);
  const issues = workspaceIssues(operator);
  return (
    <section className="workspace-context" aria-label="当前比赛与制作状态">
      <div className="workspace-section-heading">
        <small title={match?.competitionName}>
          {match ? `${match.competitionName} · ${match.format.toUpperCase()}` : '当前比赛 · 待选择'}
        </small>
        <Button onClick={() => void openPreparation('/matches')}>比赛资料</Button>
      </div>
      <div className="workspace-match-score">
        <strong title={score?.teamA.name ?? match?.entryAName}>
          {score?.teamA.name ?? match?.entryAName ?? '队伍 A'}
        </strong>
        <b aria-label="当前图回合比分">
          {score?.teamA.mapScore ?? '–'} : {score?.teamB.mapScore ?? '–'}
        </b>
        <strong title={score?.teamB.name ?? match?.entryBName}>
          {score?.teamB.name ?? match?.entryBName ?? '队伍 B'}
        </strong>
      </div>
      {score === null ? null : (
        <small className="workspace-score-detail">
          当前图 · {score.currentMapName ?? '等待比赛数据'}
          {score.seriesScoreText ? ` · 系列 ${score.seriesScoreText}` : ''}
        </small>
      )}
      <p className="workspace-pov">当前视角 · {pov ?? '等待观战数据'}</p>
      {issues.length > 0 ? (
        <div className="workspace-attention">
          <span role="status">有 {issues.length} 项需要处理</span>
          <Button onClick={() => void openTool('diagnostics')}>查看问题</Button>
          {operator?.identity.state === 'mismatch' ? (
            <Button onClick={() => void openPreparation('/matches?tab=roster')}>核对名单</Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function ObsConfidence() {
  const { value: result, updatedAt } = useLocalReadWithTime<{
    preview: { scene: string; image: string } | null;
  }>('/local/v1/obs/confidence', 2000);
  return (
    <section className="workspace-confidence" aria-label="OBS 画面确认">
      {result?.preview ? (
        <>
          <img src={result.preview.image} alt={`OBS 画面确认：${result.preview.scene}`} />
          <small className="workspace-confidence__time">
            缩略图 · 无声音 ·{' '}
            {updatedAt
              ? new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false })
              : '更新中'}
          </small>
        </>
      ) : (
        <div className="workspace-confidence__empty">
          <span>OBS 画面暂不可用 · 缩略图无声音</span>
          <Button onClick={() => void openPreparation('/settings?tab=obs')}>检查连接</Button>
        </div>
      )}
    </section>
  );
}

export function WorkspaceLeft() {
  const [recovering, setRecovering] = useState(false);
  useEffect(() => {
    const channel = new BroadcastChannel('mizar-workspace-ui');
    channel.onmessage = (event) => {
      if (event.data === 'recovery') setRecovering(true);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRecovering(false);
    };
    window.addEventListener('keydown', escape);
    return () => {
      channel.close();
      window.removeEventListener('keydown', escape);
    };
  }, []);
  const radar = useLocalChannelClient('radar');
  const operator = useLocalChannelClient('operator');
  const program = useLocalChannelClient('program');
  const state = useSyncExternalStore(
    operator.subscribe,
    operator.getSnapshot,
    operator.getSnapshot,
  );
  const programState = useSyncExternalStore(
    program.subscribe,
    program.getSnapshot,
    program.getSnapshot,
  );
  const radarState = useSyncExternalStore(radar.subscribe, radar.getSnapshot, radar.getSnapshot);
  const payload = state.state === 'live' ? (state.current?.payload ?? null) : null;
  const liveRadar = hasRadarViewFrame(radarState.state === 'live' ? radarState.current : null);
  const plannedMap =
    payload?.seriesProgress?.maps.find((map) => map.status === 'current') ??
    payload?.seriesProgress?.maps.find((map) => map.status === 'pending');
  const map = payload?.runtime.mapName ?? plannedMap?.mapName;
  const artwork = map ? getRadarArtwork(map)?.artwork.overview : null;
  return (
    <main className="workspace-left mizar-surface" aria-label="现场工作区">
      <div className="workspace-left__top">
        <header className="workspace-section-heading workspace-brand">
          <div className="workspace-brand__name">
            <img src="/brand/mizar-mark.svg" alt="" />
            <strong>MIZAR</strong>
          </div>
          <StatusPill tone={liveRadar ? 'success' : 'warning'}>
            {liveRadar ? '比赛数据正常' : '等待比赛数据'}
          </StatusPill>
        </header>
        <section className="workspace-radar" aria-label="比赛雷达">
          {recovering ? (
            <RecoveryPanel onClose={() => setRecovering(false)} />
          ) : (
            <>
              <header className="workspace-section-heading">
                <small>比赛雷达</small>
                <span>{map?.replace(/^de_/, '').toUpperCase() ?? '地图待确认'}</span>
              </header>
              <div className="workspace-radar__picture">
                {liveRadar ? (
                  <Radar client={radar} zoomMode="full-map" />
                ) : (
                  <div className="workspace-radar-placeholder" data-artwork={Boolean(artwork)}>
                    {artwork ? (
                      <img src={artwork} alt={`${map} 地图底图，无实时选手标记`} />
                    ) : (
                      <div className="workspace-radar-grid" aria-hidden="true">
                        <i />
                        <i />
                      </div>
                    )}
                    <div className="workspace-empty">
                      <strong>
                        {payload?.identity.state === 'mismatch'
                          ? '等待核对比赛名单'
                          : '等待 GSI 数据'}
                      </strong>
                      <p>
                        {artwork
                          ? '地图底图 · 实时位置尚不可用'
                          : '进入 CS2 观战后显示地图与选手位置'}
                      </p>
                      <Button onClick={() => void openPreparation('/settings?tab=gsi')}>
                        检查游戏连接
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
        <ContextPanel
          operator={payload}
          program={programState.state === 'live' ? (programState.current?.payload ?? null) : null}
        />
        <ProductionStatus compact matchId={payload?.matchContext.summary?.matchId ?? null} />
      </div>
      <ObsConfidence />
    </main>
  );
}

export function WorkspaceDock() {
  const scenes = useProgramScenes();
  const obs = useObsStatus();
  const production = useLocalRead<Production>('/local/v1/production');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [finishOpen, setFinishOpen] = useState(false);
  const [tools, setTools] = useState<'tools' | 'spectator'>('tools');
  useEffect(() => {
    const hide = () => {
      void fetch('/local/v1/production', { cache: 'no-store' })
        .then((response) => response.json() as Promise<Production>)
        .then((current) =>
          command('/operator/production', { action: 'hide', expectedRevision: current.revision }),
        )
        .catch(() => setError('工作区已隐藏，制作状态暂未同步。'));
    };
    window.addEventListener('mizar-hide', hide);
    return () => window.removeEventListener('mizar-hide', hide);
  }, []);
  async function action(run: () => Promise<unknown>, focus = false) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await run();
      if (focus && window.__TAURI_INTERNALS__) await desktopInvoke('restore_cs2_focus');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作未完成。');
    } finally {
      setBusy(false);
    }
  }
  function recover() {
    const channel = new BroadcastChannel('mizar-workspace-ui');
    channel.postMessage('recovery');
    channel.close();
  }
  const mode = scenes?.director?.mode;
  const next = PROGRAM_SCENES.find((scene) => scene.id === scenes?.director?.next);
  return (
    <main className="workspace-dock mizar-surface" aria-label="现场控制底栏">
      <section className="workspace-direction" aria-label="正式节目控制">
        <header className="workspace-section-heading">
          <strong>
            已确认 ·{' '}
            {PROGRAM_SCENES.find((scene) => scene.id === scenes?.active)?.title ?? '等待同步'}
          </strong>
          <StatusPill tone={mode === 'blocked' ? 'warning' : 'info'}>
            {mode === 'auto'
              ? '自动编排'
              : mode === 'manual'
                ? '手动保持'
                : mode === 'blocked'
                  ? '自动暂停'
                  : '准备中'}
          </StatusPill>
          <Button
            disabled={busy || !scenes || (mode !== 'manual' && mode !== 'blocked')}
            onClick={() =>
              scenes &&
              void action(() =>
                command('/operator/program-director', {
                  action: 'resume',
                  expectedRevision: scenes.revision,
                }),
              )
            }
          >
            恢复自动
          </Button>
        </header>
        <div className="workspace-scene-buttons" aria-label="手动切换场景">
          {PROGRAM_SCENES.map((scene) => (
            <Button
              key={scene.id}
              disabled={busy || !scenes?.available.includes(scene.id)}
              aria-pressed={scenes?.active === scene.id}
              title={scenes?.blocked[scene.id] ?? `正式切换到${scene.title}`}
              onClick={() =>
                scenes &&
                void action(
                  () => selectProgramScene(scene.id, scenes.revision),
                  scene.id === 'gameplay' || scene.id === 'bp',
                )
              }
            >
              {scene.title}
            </Button>
          ))}
        </div>
        <p className="workspace-next-summary">
          预计下一节目 ·{' '}
          {next?.title ?? (scenes?.director?.nextStatus === 'complete' ? '本场结束' : '待确认')} ·
          预告尚未执行
        </p>
      </section>
      <section className="workspace-production" aria-label="现场工具与观战">
        <div className="workspace-section-heading">
          <Button aria-pressed={tools === 'tools'} onClick={() => setTools('tools')}>
            工具
          </Button>
          <Button aria-pressed={tools === 'spectator'} onClick={() => setTools('spectator')}>
            观战 / 本机 HUD
          </Button>
          <span>
            OBS ·{' '}
            {obs?.connection === 'connected' ? (obs.streaming ? '推流中' : '已连接') : '无法确认'}
          </span>
        </div>
        {tools === 'spectator' ? (
          <>
            <SpectatorHudCommands compact onMessage={setMessage} />
            <p className="workspace-command-help">复制后在 CS2 控制台执行</p>
            <LocalOverlayControls onMessage={setMessage} />
          </>
        ) : (
          <div className="workspace-tools">
            <Button disabled={busy} onClick={() => void action(() => openTool('bp'))}>
              正式 BP
            </Button>
            <Button disabled={busy} onClick={() => void action(() => openTool('hud'))}>
              HUD 编辑器
            </Button>
            <Button disabled={busy} onClick={() => void action(() => openPreparation('/'))}>
              本场资料
            </Button>
            <Button
              disabled={busy || !production}
              onClick={() => production && void action(() => productionAction('hide', production))}
            >
              隐藏工作区
            </Button>
          </div>
        )}
      </section>
      <footer className="workspace-message">
        <span
          title={error || message || scenes?.director?.reason || ''}
          role={error ? 'alert' : 'status'}
        >
          {error || message || scenes?.director?.reason || '正式切场后保持手动；网站数据源独立控制'}
        </span>
        <Button onClick={recover}>现场恢复</Button>
        <Button
          className="workspace-exit"
          disabled={busy || !production}
          onClick={() => setFinishOpen(true)}
        >
          结束制播
        </Button>
      </footer>
      <Dialog open={finishOpen} title="结束本场制播" onClose={() => setFinishOpen(false)}>
        <p>
          收起节目、释放本机网站数据源、关闭受管理 CS2 并恢复配置。OBS 推流 /
          录制不会自动停止；不会提交网站官方结果。
        </p>
        <Button
          disabled={busy || !production}
          onClick={() =>
            production &&
            void action(async () => {
              await productionAction('finish', production, setMessage);
              setFinishOpen(false);
            })
          }
        >
          确认结束并恢复配置
        </Button>
        <Button onClick={() => setFinishOpen(false)}>继续制作</Button>
        {error ? <p role="alert">{error}</p> : null}
      </Dialog>
    </main>
  );
}

export function WorkspacePreview() {
  return (
    <div className="workspace-preview">
      <WorkspaceLeft />
      <div className="workspace-preview__game">CS2 游戏画面</div>
      <WorkspaceDock />
    </div>
  );
}
