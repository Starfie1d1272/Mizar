import { useState } from 'react';
import { Button, Dialog, Field, Select, StatusBanner } from '../ui';
import { command } from './client';
import { useLocalTournament } from './tournament';
import { desktopInvoke } from '../workspace/client';

export function LocalMatchControls({
  action,
  mode = 'both',
  onSelected,
  onCancel,
  initialEventId = '',
  beforeApply,
}: {
  readonly mode?: 'create' | 'select' | 'both';
  readonly onSelected?: () => void;
  readonly onCancel?: () => void;
  readonly initialEventId?: string;
  readonly beforeApply?: () => boolean;
  readonly action: (run: () => Promise<unknown>) => Promise<void>;
}) {
  const { view, refresh, status } = useLocalTournament();
  const [a, setA] = useState({ name: '', id: '' });
  const [b, setB] = useState({ name: '', id: '' });
  const [eventId, setEventId] = useState(initialEventId);
  const [eventName, setEventName] = useState('');
  const [format, setFormat] = useState('bo3');
  const [confirmation, setConfirmation] = useState<{ matchId: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const mutate = async (operation: 'trash' | 'restore', matchId: string) => {
    setBusy(true);
    setMessage('');
    try {
      await command(`/operator/local-match/${operation}`, {
        matchId,
        confirmed: true,
        ...(operation === 'trash' && matchId === view?.activeLocalMatchId
          ? { releaseCurrent: true }
          : {}),
      });
      setConfirmation(null);
      await refresh();
      setMessage(
        operation === 'trash' ? '比赛已移入回收站，可在下方恢复。' : '比赛已恢复，请按需选择比赛。',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="workspace-local-match">
      {message ? <StatusBanner tone="info">{message}</StatusBanner> : null}
      <Dialog
        open={confirmation !== null}
        title="删除本地比赛"
        onClose={() => setConfirmation(null)}
        canClose={() => !busy}
      >
        <p>{confirmation?.name}</p>
        {confirmation?.matchId === view?.activeLocalMatchId ? (
          <p>同时解除当前本地比赛选择。</p>
        ) : null}
        <p>
          比赛将移入回收站，并从本地赛程移除。可恢复比赛资料、名单、地图与
          BP；共享队伍、HUD、网站比赛及其他比赛保留。
        </p>
        <Button autoFocus disabled={busy} onClick={() => setConfirmation(null)}>
          取消
        </Button>
        <Button
          className="local-match-trash-confirm"
          loading={busy}
          disabled={confirmation?.matchId === view?.inUseMatchId}
          onClick={() => {
            if (confirmation) void action(() => mutate('trash', confirmation.matchId));
          }}
        >
          移入回收站
        </Button>
      </Dialog>
      {mode !== 'select' ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (status !== 'ready' || (beforeApply && !beforeApply())) return;
            void action(async () => {
              await command('/operator/local-match/create', {
                teamA: a.name,
                teamB: b.name,
                ...(a.id ? { teamAId: a.id } : {}),
                ...(b.id ? { teamBId: b.id } : {}),
                format,
                ...(eventId
                  ? { eventId }
                  : eventName.trim()
                    ? { eventName: eventName.trim() }
                    : {}),
              });
              onSelected?.();
              setA({ name: '', id: '' });
              setB({ name: '', id: '' });
              await refresh();
            });
          }}
        >
          {[
            { label: '队伍 A', value: a, set: setA, other: b.id },
            { label: '队伍 B', value: b, set: setB, other: a.id },
          ].map(({ label, value, set, other }) => (
            <div key={label}>
              <Field
                label={label}
                required
                value={value.name}
                onChange={(event) => set({ name: event.target.value, id: '' })}
                placeholder="搜索已有队伍，或输入新队名"
              />
              {value.id ? (
                <p>
                  将复用已保存的队标与名单。
                  <Button onClick={() => set({ ...value, id: '' })}>改为新队伍</Button>
                </p>
              ) : value.name.trim() ? (
                <div className="preparation-team-results">
                  {view?.teams
                    .filter((team) =>
                      team.name.toLocaleLowerCase().includes(value.name.trim().toLocaleLowerCase()),
                    )
                    .slice(0, 8)
                    .map((team) => (
                      <Button
                        key={team.teamId}
                        disabled={team.teamId === other}
                        onClick={() => set({ name: team.name, id: team.teamId })}
                      >
                        复用 {team.name}
                      </Button>
                    ))}
                </div>
              ) : null}
            </div>
          ))}
          <Select label="赛制" value={format} onChange={(event) => setFormat(event.target.value)}>
            {['bo1', 'bo3', 'bo5'].map((bo) => (
              <option key={bo} value={bo}>
                {bo.toUpperCase()}
              </option>
            ))}
          </Select>
          <details>
            <summary>赛事归属（选填）</summary>
            <Select
              label="创建比赛所属赛事"
              value={eventId}
              onChange={(event) => setEventId(event.target.value)}
            >
              <option value="">创建新本地赛事</option>
              {view?.events.map((event) => (
                <option key={event.eventId} value={event.eventId}>
                  {event.name}
                </option>
              ))}
            </Select>
            {!eventId ? (
              <Field
                label="新赛事名称"
                maxLength={128}
                placeholder="例如：秋季校园联赛"
                value={eventName}
                onChange={(event) => setEventName(event.target.value)}
              />
            ) : null}
            <p>填写新名称会自动创建赛事并关联本场；留空使用“本地赛事”。</p>
          </details>
          <p>
            填写双方队名和赛制即可创建。进入工作台，等双方十名选手进服且观战数据就绪后，可从游戏识别首发，核对后保存。队标和替补名单可稍后补充。
          </p>
          <Button
            type="submit"
            variant="primary"
            disabled={
              status !== 'ready' || !a.name.trim() || !b.name.trim() || (!!a.id && a.id === b.id)
            }
          >
            创建本地比赛
          </Button>
          {onCancel ? <Button onClick={onCancel}>取消创建</Button> : null}
        </form>
      ) : null}
      <details>
        <summary>管理本地比赛</summary>
        <p>正在使用的比赛需先结束制作。游戏退出确认后，可解除当前选择并回收，包括最后一场比赛。</p>
        {view?.canConfirmLocalExit &&
        view.activeLocalMatchId === view.inUseMatchId &&
        window.__TAURI_INTERNALS__ ? (
          <Button
            loading={busy}
            onClick={() =>
              void action(async () => {
                setBusy(true);
                try {
                  await desktopInvoke('finish_managed_cs2');
                  await refresh();
                  setMessage('游戏收尾已完成，已刷新比赛的删除状态。');
                } finally {
                  setBusy(false);
                }
              })
            }
          >
            关闭游戏并允许删除
          </Button>
        ) : null}
        {view?.matches.map((match) => (
          <div key={match.matchId}>
            <span>
              {match.entrants.a.name} vs {match.entrants.b.name} · {match.format.toUpperCase()}
            </span>
            <Button
              disabled={busy || match.matchId === view.inUseMatchId}
              onClick={() =>
                setConfirmation({
                  matchId: match.matchId,
                  name: `${match.entrants.a.name} vs ${match.entrants.b.name} · ${match.format.toUpperCase()}`,
                })
              }
            >
              删除本地比赛
            </Button>
          </div>
        ))}
        {!view?.matches.length ? <p>暂无本地比赛。</p> : null}
        <h3>回收站</h3>
        {view?.trashedMatches?.map(({ document }) => (
          <div key={document.matchId}>
            <span>
              {document.entrants.a.name} vs {document.entrants.b.name} ·{' '}
              {document.format.toUpperCase()}
            </span>
            <Button
              disabled={busy}
              onClick={() => void action(() => mutate('restore', document.matchId))}
            >
              恢复比赛
            </Button>
          </div>
        ))}
        {!view?.trashedMatches?.length ? <p>回收站为空。</p> : null}
      </details>
      {mode !== 'create' && view?.matches.length ? (
        <Select
          label="已保存比赛"
          value={view.activeLocalMatchId ?? ''}
          onChange={(event) => {
            if (event.target.value)
              void action(async () => {
                await command('/operator/local-match/select', { matchId: event.target.value });
                await refresh();
              });
          }}
        >
          <option value="">选择比赛</option>
          {[...view.matches].reverse().map((match) => (
            <option key={match.matchId} value={match.matchId}>
              {match.entrants.a.name} vs {match.entrants.b.name} · {match.format.toUpperCase()}
            </option>
          ))}
        </Select>
      ) : null}
    </div>
  );
}
