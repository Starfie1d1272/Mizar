import { ReviewDialog, isReviewWindow, closeReviewWindow } from './ReviewDialog';
import { useEffect, useState } from 'react';
import type { OperatorPayload } from '@mizar/protocol/operator';
import type { ProgramPayload, ProgramSnapshot } from '@mizar/protocol/program';
import { Button, Select } from '../ui';
import { command } from '../preparation/client';
import { HIDE_SPECTATOR_HUD_COMMAND } from '../preparation/SpectatorHudCommands';
import { desktopInvoke, useProgramScenes } from './client';
import { useObsStatus } from './obs-client';
import { syncHealthText, type SyncHealth } from './SyncHealthAlert';
import type { LiveRosterConnection } from './live-roster-model';
import { workspaceIssues } from './model';
import './preflight-review.css';

export function preflightEvidence(
  operator: OperatorPayload | null,
  program: ProgramPayload | null,
  cursor: ProgramSnapshot['cursor'] | null,
) {
  const current = program?.players.filter((player) => player.lineupEvidence === 'current') ?? [];
  const aligned = Boolean(
    operator &&
    program &&
    cursor &&
    operator.matchContext.summary?.matchId === program.match?.matchId &&
    program.match &&
    cursor.programReceiveSequence === operator.runtime.lastAccepted?.receiveSequence &&
    cursor.mapEpoch === operator.activeLineup.mapEpoch &&
    cursor.programSourceGeneration === operator.activeLineup.sourceGeneration,
  );
  const complete =
    aligned &&
    operator?.runtime.telemetryFreshness === 'fresh' &&
    program?.status.telemetry === 'fresh' &&
    operator.activeLineup.state === 'complete' &&
    operator.activeLineup.retainedCount === 0 &&
    current.length === 10 &&
    new Set(current.map((player) => player.sourcePlayerId)).size === 10 &&
    current.filter((player) => player.side === 'CT').length === 5 &&
    current.filter((player) => player.side === 'T').length === 5;
  return { complete, current, warmup: aligned && program?.map.phase === 'warmup' };
}

const SILENCED_MATCH_KEY = 'mizar.preflight.silenced-match.v1';

type Props = {
  operator: OperatorPayload | null;
  program: ProgramPayload | null;
  cursor: ProgramSnapshot['cursor'] | null;
  connection: (LiveRosterConnection & { syncHealth?: SyncHealth }) | null;
  onOpen: (path: string) => Promise<void>;
};

/** A preflight review shares the focused native review window with live exceptions. */
export function PreflightReview(props: Props) {
  const { operator, cursor } = props;
  if (!operator?.matchContext.summary) return null;
  return (
    <ReviewSession
      key={JSON.stringify([
        operator.matchContext.summary.matchId,
        cursor?.producerInstanceId,
        cursor?.liveSessionId,
        operator.activeLineup.mapEpoch,
      ])}
      {...props}
    />
  );
}

function ReviewSession({ operator, program, cursor, connection, onOpen }: Props) {
  const scenes = useProgramScenes();
  const obs = useObsStatus();
  const [automaticIncident, setAutomaticIncident] = useState('');
  const [opened, setOpened] = useState(false);
  const [dismissed, setDismissed] = useState('');
  const matchId = operator?.matchContext.summary?.matchId ?? '';
  const [silenced, setSilenced] = useState(() => {
    try {
      return localStorage.getItem(SILENCED_MATCH_KEY) === matchId;
    } catch {
      return false;
    }
  });
  const completionKey = `mizar.preflight.v1:${JSON.stringify([operator?.matchContext.summary?.matchId, cursor?.producerInstanceId, cursor?.liveSessionId, operator?.activeLineup.mapEpoch])}`;
  const [acknowledged, setAcknowledged] = useState(() => {
    try {
      return localStorage.getItem(completionKey) ?? '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === SILENCED_MATCH_KEY) {
        setSilenced(event.newValue === matchId);
        if (event.newValue === matchId) setOpened(false);
      }
      if (event.key === completionKey) setAcknowledged(event.newValue ?? '');
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [completionKey, matchId]);
  const [connectionObserved, setConnectionObserved] = useState(false);
  if (connection && !connectionObserved) setConnectionObserved(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { complete, current, warmup } = preflightEvidence(operator, program, cursor);
  const online = operator?.matchContext.rosterAuthority === 'rivalhub';
  const issues = workspaceIssues(operator);
  const identityReady =
    operator?.identity.state === 'matched' &&
    operator.matchContext.freshness === 'fresh' &&
    issues.length === 0;
  const websiteReady =
    !online ||
    Boolean(
      connection?.paired &&
      connection.sourceReady &&
      connection.activeMatchId === operator?.matchContext.summary?.matchId &&
      connection.activeSourceMatchId === connection.activeMatchId &&
      connection.syncHealth?.status !== 'attention' &&
      connection.syncHealth?.status !== 'stopped' &&
      connection.syncHealth?.status !== 'other_device',
    );
  const websiteText = !connection
    ? '网站连接状态暂不可用'
    : !connection.paired
      ? '网站未连接，请重新连接'
      : connection.activeMatchId !== operator?.matchContext.summary?.matchId
        ? '网站绑定的场次与当前比赛不一致'
        : connection.syncHealth?.status === 'attention' ||
            connection.syncHealth?.status === 'other_device' ||
            connection.syncHealth?.status === 'stopped'
          ? syncHealthText(connection.syncHealth)
          : !connection.sourceReady || connection.activeSourceMatchId !== connection.activeMatchId
            ? '本机数据源尚未就绪，请检查网站同步'
            : connection.syncHealth?.status === 'healthy'
              ? '网站正在接收本场数据'
              : '网站与本场已关联 · 等待正式比赛数据';
  const preparation = !['live', 'intermission', 'gameover'].includes(
    program?.map.phase ?? 'unknown',
  );
  const automatic = scenes?.director?.mode === 'auto';
  const ready =
    complete && identityReady && websiteReady && automatic && obs?.connection === 'connected';
  const fingerprint = JSON.stringify([
    program?.map.name,
    current.map((p) => [p.sourcePlayerId, p.side]).sort(),
    complete,
    identityReady,
    websiteReady,
    automatic,
    obs?.connection,
    scenes?.director?.warmupScene,
  ]);
  const finished = ready && acknowledged === fingerprint;
  // Different faults get a new review, but telemetry sequence changes do not reopen it.
  const incident =
    online && connectionObserved && !websiteReady && (warmup || !connection || !connection.paired)
      ? `website:${websiteText}`
      : warmup && complete && !finished
        ? `preflight:${JSON.stringify([program?.map.name, current.map((p) => [p.sourcePlayerId, p.side]).sort(), identityReady, issues.map((issue) => issue.id)])}`
        : '';
  useEffect(() => {
    const timer = setTimeout(
      () => {
        setAutomaticIncident(incident);
        // The two snapshot channels can briefly be unaligned between deliveries.
        // That absence of evidence is not a new incident or a dismissal reset.
        if (!silenced && incident && dismissed !== incident) setOpened(true);
      },
      incident.startsWith('website:') ? 1500 : 0,
    );
    return () => clearTimeout(timer);
  }, [incident, dismissed, silenced]);
  const open =
    isReviewWindow() ||
    (opened &&
      (preparation || (online && connectionObserved && (!connection || !connection.paired)))) ||
    Boolean(!silenced && incident && automaticIncident === incident && dismissed !== incident);
  const close = () => {
    setOpened(false);
    // A queued native close event may arrive while snapshot channels are unaligned.
    if (incident) setDismissed(incident);
    void closeReviewWindow().catch((failure) => setError(String(failure)));
  };
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作未完成，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="preflight-summary" aria-label="赛前核对">
      <Button onClick={() => setOpened(true)}>
        {finished
          ? '赛前核对已完成 · 查看'
          : online && !websiteReady
            ? '网站连接需处理'
            : '赛前核对'}
      </Button>
      {!finished && !complete && warmup ? <small>等待双方十人观战数据</small> : null}
      <ReviewDialog
        kind="preflight"
        open={open}
        modal={false}
        showCloseButton={false}
        title={online && !websiteReady && !warmup ? '网站连接需要处理' : '赛前核对'}
        className="workspace-preflight"
        onClose={close}
      >
        <p className="preflight-intro">
          {operator?.matchContext.summary?.entryAName} 对阵{' '}
          {operator?.matchContext.summary?.entryBName} · {program?.map.name ?? '地图待确认'}
        </p>
        {finished && preparation ? (
          <p role="status">赛前核对已完成。可以到语音频道通知选手在游戏中输入 .r。</p>
        ) : null}
        <section className="preflight-check" data-attention={!complete || !identityReady}>
          <h3>
            本场与首发 <small>{complete && identityReady ? '已匹配 · 10 人' : '需要核对'}</small>
          </h3>
          {!complete ? <p>等待新鲜、完整的双方五人观战数据；旧名单不会作为到齐依据。</p> : null}
          {issues.map((issue) => (
            <div key={issue.id}>
              <p>{issue.summary}</p>
              <small>{issue.detail}</small>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    issue.run === 'refresh-rivalhub'
                      ? command('/operator/rivalhub/refresh')
                      : onOpen(issue.path),
                  )
                }
              >
                {issue.action}
              </Button>
            </div>
          ))}
          {!identityReady && issues.length === 0 ? (
            <p>比赛资料或选手身份尚未确认，请核对本场资料。</p>
          ) : null}
          <details>
            <summary>查看名单与比赛资料</summary>
            <div className="preflight-rosters">
              {(['CT', 'T'] as const).map((side) => (
                <div key={side}>
                  <strong>{side}</strong>
                  <ul>
                    {current
                      .filter((p) => p.side === side)
                      .map((p) => (
                        <li key={p.sourcePlayerId}>{p.displayName ?? p.sourcePlayerId}</li>
                      ))}
                  </ul>
                </div>
              ))}
            </div>
            <Button disabled={busy} onClick={() => void run(() => onOpen('/matches?tab=roster'))}>
              核对比赛资料
            </Button>
          </details>
        </section>
        {online ? (
          <section className="preflight-check" data-attention={!websiteReady}>
            <h3>
              网站同步 <small>{websiteReady ? '就绪' : '待处理'}</small>
            </h3>
            <p>{websiteText}</p>
            {!websiteReady ? (
              <Button
                disabled={busy}
                onClick={() => void run(() => onOpen('/settings?tab=rivalhub'))}
              >
                检查网站连接与数据源
              </Button>
            ) : null}
          </section>
        ) : null}
        {preparation ? (
          <>
            <section className="preflight-check" data-attention={!automatic}>
              <h3>
                节目编排 <small>{automatic ? '自动' : '尚未恢复自动'}</small>
              </h3>
              {!automatic ? (
                <>
                  <p>
                    {scenes?.director?.reason ?? '准备完成后交回自动编排，由比赛进程驱动画面。'}
                  </p>
                  <Button
                    variant="primary"
                    disabled={
                      busy ||
                      !scenes ||
                      !['manual', 'blocked'].includes(scenes.director?.mode ?? '')
                    }
                    onClick={() =>
                      void run(() =>
                        command('/operator/program-director', {
                          action: 'resume',
                          expectedRevision: scenes!.revision,
                        }),
                      )
                    }
                  >
                    恢复自动编排
                  </Button>
                </>
              ) : null}
              <Select
                label="热身时播出"
                value={scenes?.director?.warmupScene ?? 'waiting'}
                disabled={busy || !scenes?.director}
                onChange={(event) => {
                  const scene = event.currentTarget.value;
                  if (scene === 'waiting' || scene === 'gameplay')
                    void run(() =>
                      command('/operator/program-director', {
                        action: 'warmup',
                        scene,
                        expectedRevision: scenes!.revision,
                      }),
                    );
                }}
              >
                <option value="waiting">赛前等待画面</option>
                <option value="gameplay">游戏画面</option>
              </Select>
            </section>
            <section className="preflight-check">
              <h3>画面与声音</h3>
              <p>复制后返回游戏，在控制台粘贴并回车。执行后核对画面，试听游戏声与解说声音。</p>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    try {
                      await navigator.clipboard.writeText(HIDE_SPECTATOR_HUD_COMMAND);
                    } catch {
                      throw new Error(`复制未完成，请手动复制：${HIDE_SPECTATOR_HUD_COMMAND}`);
                    }
                    if (window.__TAURI_INTERNALS__) {
                      const focused = await desktopInvoke<boolean>('restore_cs2_focus');
                      if (!focused)
                        throw new Error(
                          '命令已复制，尚未执行。Windows 未允许切换，请用 Alt-Tab 返回 CS2，粘贴后回车。',
                        );
                    }
                    close();
                  })
                }
              >
                复制隐藏命令并返回游戏
              </Button>
              <small>
                复制后关闭此窗口；不会代替你执行命令。需要继续核对时，从工作台重新打开。
              </small>
              <small>
                {obs?.connection !== 'connected'
                  ? 'OBS 尚未连接，无法确认输出状态'
                  : obs.streaming
                    ? 'OBS 正在直播'
                    : obs.recording
                      ? 'OBS 正在录像 · 尚未直播'
                      : 'OBS 已连接 · 尚未直播或录像'}
              </small>
            </section>
            <p className="preflight-next">
              准备好后，到语音频道通知选手在游戏中输入 <strong>.r</strong>。
              {online ? '正式开始后自动检查网站接收情况。' : ''}
            </p>
          </>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <footer>
          <Button onClick={close}>稍后处理</Button>
          <Button
            onClick={() => {
              const next = !silenced;
              setSilenced(next);
              try {
                if (next) localStorage.setItem(SILENCED_MATCH_KEY, matchId);
                else localStorage.removeItem(SILENCED_MATCH_KEY);
              } catch {
                /* Keep the current window preference when storage is unavailable. */
              }
              if (next) close();
            }}
          >
            {silenced ? '恢复本场自动提醒' : '本场比赛不再自动弹出'}
          </Button>
          {preparation ? (
            <Button
              variant="primary"
              disabled={busy || !ready}
              onClick={() => {
                setAcknowledged(fingerprint);
                try {
                  localStorage.setItem(completionKey, fingerprint);
                } catch {
                  /* In-memory review still works when storage is unavailable. */
                }
                close();
              }}
            >
              完成赛前核对
            </Button>
          ) : null}
        </footer>
      </ReviewDialog>
    </section>
  );
}
