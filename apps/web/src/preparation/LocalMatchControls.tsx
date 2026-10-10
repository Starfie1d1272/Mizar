import { useState } from 'react';
import { Button, Dialog, Field, Select, StatusBanner } from '../ui';
import { command } from './client';
import { useLocalTournament } from './tournament';

export function LocalMatchControls({
  action,
}: {
  readonly action: (run: () => Promise<unknown>) => Promise<void>;
}) {
  const { view, refresh } = useLocalTournament();
  const [a, setA] = useState({ name: '', id: '' });
  const [b, setB] = useState({ name: '', id: '' });
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
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action(async () => {
            await command('/operator/local-match/create', {
              teamA: a.name,
              teamB: b.name,
              ...(a.id ? { teamAId: a.id } : {}),
              ...(b.id ? { teamBId: b.id } : {}),
              format,
            });
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
        <Button
          type="submit"
          variant="primary"
          disabled={!a.name.trim() || !b.name.trim() || (!!a.id && a.id === b.id)}
        >
          创建本地比赛
        </Button>
      </form>
      <details>
        <summary>管理本地比赛</summary>
        <p>
          正在使用的比赛需先结束制作并切换比赛。尚未使用游戏数据的准备比赛可确认后解除选择并回收。
        </p>
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
      {view?.matches.length ? (
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
