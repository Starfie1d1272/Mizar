import { useCallback, useRef, useState } from 'react';
import { Button, Panel, Select } from '../ui';
import {
  LocalTournamentEditor,
  type LocalTournamentView,
} from '../workspace/LocalTournamentEditor';
import { MatchDocumentView } from './MatchDocumentView';
import { LocalMatchControls } from './LocalMatchControls';
import { command } from './client';

/** One explicit event / schedule / candidate context, separate from the active production. */
export function EventMatchWorkspace({
  view,
  refresh,
  action,
}: {
  view: LocalTournamentView | null;
  refresh: () => Promise<void>;
  action: (run: () => Promise<unknown>) => Promise<void>;
}) {
  const query = new URLSearchParams(window.location.search);
  const initial = view?.matches.find((match) => match.matchId === query.get('resource'));
  const [eventId, setEventId] = useState(
    initial?.competition?.competitionId ??
      (query.get('event') === 'independent' ||
      view?.events.some((item) => item.eventId === query.get('event'))
        ? query.get('event')!
        : (view?.events[0]?.eventId ?? 'independent')),
  );
  const [matchId, setMatchId] = useState(initial?.matchId ?? '');
  const [editing, setEditing] = useState(query.get('tab') === 'event');
  const [creating, setCreating] = useState(false);
  const dirty = useRef(false);
  const canChange = () =>
    !dirty.current || window.confirm('赛事资料有未保存修改，放弃后切换资源？');
  const markDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const matches =
    view?.matches.filter((match) =>
      eventId === 'independent' ? !match.competition : match.competition?.competitionId === eventId,
    ) ?? [];
  const event = view?.events.find((item) => item.eventId === eventId);
  const match = matches.find((item) => item.matchId === matchId) ?? matches[0];
  return (
    <div className="event-match-workspace">
      <Panel className="event-match-browser">
        <h2>赛事与比赛</h2>
        <Select
          label="浏览赛事"
          value={eventId}
          onChange={(change) => {
            if (!canChange()) return;
            const url = new URL(window.location.href);
            url.searchParams.set('event', change.target.value);
            url.searchParams.delete('resource');
            window.history.replaceState(null, '', url);
            setEventId(change.target.value);
            setMatchId('');
            setCreating(false);
          }}
        >
          {view?.events.map((item) => (
            <option key={item.eventId} value={item.eventId}>
              {item.name} · {item.matchIds.length} 场
            </option>
          ))}
          <option value="independent">独立比赛（无关联赛事）</option>
        </Select>
        <p>{event ? `${event.name} · 品牌与默认规则可复用` : '独立比赛不依赖赛事资料。'}</p>
        {event ? (
          <Button aria-expanded={editing} onClick={() => setEditing((value) => !value)}>
            编辑赛事品牌与默认规则
          </Button>
        ) : null}
        <div className="event-match-list" aria-label="本赛事赛程">
          {matches.length ? (
            matches.map((item) => (
              <Button
                key={item.matchId}
                aria-pressed={match?.matchId === item.matchId}
                onClick={() => {
                  setMatchId(item.matchId);
                  const url = new URL(window.location.href);
                  url.searchParams.set('resource', item.matchId);
                  window.history.replaceState(null, '', url);
                }}
              >
                <span>
                  {item.entrants.a.name} vs {item.entrants.b.name}
                </span>
                <small>
                  {item.format.toUpperCase()} ·{' '}
                  {item.matchId === view?.activeLocalMatchId ? '当前本场' : '候选，尚未载入'}
                </small>
              </Button>
            ))
          ) : (
            <p>本分组暂无比赛，可创建第一场。</p>
          )}
        </div>
        <Button onClick={() => setCreating((value) => !value)}>
          {event ? '在此赛事追加下一场' : '创建本地 BO 比赛'}
        </Button>
      </Panel>
      <div className="event-match-detail">
        {creating ? (
          <Panel>
            <h2>{event ? `追加到 ${event.name}` : '快速建立本地比赛'}</h2>
            <LocalMatchControls
              key={eventId}
              mode="create"
              initialEventId={event?.eventId ?? ''}
              action={action}
              onSelected={() => window.location.assign('/?tab=match')}
            />
          </Panel>
        ) : match ? (
          <>
            <MatchDocumentView document={match} section="details" />
            <div className="preparation-actions">
              <Button
                variant="primary"
                onClick={() => {
                  if (
                    !canChange() ||
                    !window.confirm(
                      `将本场切换为 ${match.entrants.a.name} vs ${match.entrants.b.name}？资源浏览本身不改变播出。`,
                    )
                  )
                    return;
                  void action(async () => {
                    await command('/operator/local-match/select', { matchId: match.matchId });
                    window.location.assign('/?tab=match');
                  });
                }}
              >
                确认载入为本场
              </Button>
              <small>
                {match.matchId === view?.activeLocalMatchId
                  ? '正在制播的本地比赛'
                  : '浏览资源 · 当前本场保持不变'}
              </small>
            </div>
            <MatchDocumentView document={match} section="roster" />
            <details>
              <summary>地图与禁选资料</summary>
              <MatchDocumentView document={match} section="maps" />
            </details>
          </>
        ) : (
          <Panel>
            <h2>比赛详情</h2>
            <p>选择赛程中的一场查看双方、名单与地图；浏览不会自动载入。</p>
          </Panel>
        )}
        {event ? (
          <div hidden={!editing} className="event-inline-edit" key={eventId}>
            <h2>赛事品牌与默认规则 · {event.name}</h2>
            <LocalTournamentEditor
              eventId={eventId}
              view={view}
              refresh={refresh}
              action={action}
              scope="resources"
              section="overview"
              onDirtyChange={markDirty}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
