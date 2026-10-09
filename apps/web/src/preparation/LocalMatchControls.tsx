import { useState } from 'react';
import { Button, Field, Select } from '../ui';
import { command } from './client';
import { useLocalTournament } from './tournament';

export function LocalMatchControls({
  action,
  onSelected,
}: {
  readonly onSelected?: () => void;
  readonly action: (run: () => Promise<unknown>) => Promise<void>;
}) {
  const { view, refresh } = useLocalTournament();
  const [a, setA] = useState({ name: '', id: '' });
  const [b, setB] = useState({ name: '', id: '' });
  const [format, setFormat] = useState('bo3');
  const [eventId, setEventId] = useState('');
  const currentEvent = view?.events.find((event) =>
    event.matchIds.includes(view.activeLocalMatchId ?? ''),
  );
  return (
    <div className="workspace-local-match">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!window.confirm(`创建 ${a.name} vs ${b.name} 并应用为本场？现有比赛资料会保留。`))
            return;
          void action(async () => {
            await command('/operator/local-match/create', {
              teamA: a.name,
              teamB: b.name,
              ...(a.id ? { teamAId: a.id } : {}),
              ...(b.id ? { teamBId: b.id } : {}),
              format,
              ...(eventId ? { eventId } : {}),
            });
            setA({ name: '', id: '' });
            setB({ name: '', id: '' });
            await refresh();
            onSelected?.();
          });
        }}
      >
        <Select
          label="创建比赛所属赛事"
          value={eventId}
          onChange={(event) => setEventId(event.target.value)}
        >
          <option value="">快速创建新本地赛事</option>
          {view?.events.map((event) => (
            <option key={event.eventId} value={event.eventId}>
              {event.name}
            </option>
          ))}
        </Select>
        {currentEvent ? (
          <Button onClick={() => setEventId(currentEvent.eventId)}>
            沿用当前本地赛事 · {currentEvent.name}
          </Button>
        ) : null}
        <p>沿用赛事品牌、地图池与默认规则；新比赛不复制旧比分、BP 或网站控制权。</p>
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
      {view?.matches.length ? (
        <Select
          label="已保存比赛"
          value={view.activeLocalMatchId ?? ''}
          onChange={(event) => {
            const matchId = event.target.value;
            const match = view.matches.find((item) => item.matchId === matchId);
            if (
              match &&
              window.confirm(`将本场切换为 ${match.entrants.a.name} vs ${match.entrants.b.name}？`)
            )
              void action(async () => {
                await command('/operator/local-match/select', { matchId });
                await refresh();
                onSelected?.();
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
