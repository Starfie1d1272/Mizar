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
  canWrite,
}: {
  canWrite: boolean;
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
  const [editingMatch, setEditingMatch] = useState(false);
  const [editingMatchScope, setEditingMatchScope] = useState<'match' | 'candidate'>('candidate');
  const dirty = useRef(false);
  const canChange = () =>
    !dirty.current || window.confirm('赛事资料有未保存修改，放弃后切换资源？');
  const markDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const event = view?.events.find((item) => item.eventId === eventId);
  const matches =
    eventId === 'independent'
      ? (view?.matches.filter((match) => !match.competition) ?? [])
      : (event?.matchIds.flatMap((id) => {
          const match = view?.matches.find((item) => item.matchId === id);
          return match ? [match] : [];
        }) ?? []);
  const match = matches.find((item) => item.matchId === matchId) ?? matches[0];
  return (
    <div className="event-match-workspace">
      <section className="event-match-browser">
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
            setEditingMatch(false);
            setEditing(false);
          }}
        >
          {view?.events.map((item) => (
            <option key={item.eventId} value={item.eventId}>
              {item.name} · {item.matchIds.length} 场
            </option>
          ))}
          <option value="independent">独立比赛（无关联赛事）</option>
        </Select>
        {event ? (
          <Button
            aria-expanded={editing}
            onClick={() => {
              if (!canChange()) return;
              setEditing((value) => !value);
              setCreating(false);
              setEditingMatch(false);
            }}
          >
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
                  if (!canChange()) return;
                  setMatchId(item.matchId);
                  setEditing(false);
                  setCreating(false);
                  setEditingMatch(false);
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
        <Button
          onClick={() => {
            if (!canChange()) return;
            setCreating((value) => !value);
            setEditing(false);
            setEditingMatch(false);
          }}
        >
          {event ? '在此赛事追加下一场' : '创建本地 BO 比赛'}
        </Button>
      </section>
      <section className="event-match-detail">
        {creating ? (
          <Panel>
            <h2>{event ? `追加到 ${event.name}` : '快速建立本地比赛'}</h2>
            <LocalMatchControls
              key={eventId}
              mode="create"
              initialEventId={event?.eventId ?? ''}
              onCancel={() => setCreating(false)}
              beforeApply={() => canWrite && canChange()}
              action={action}
              onSelected={() => window.location.assign('/?tab=match')}
            />
          </Panel>
        ) : !editing && match ? (
          <>
            <header className="library-detail-heading">
              <span>{match.matchId === view?.activeLocalMatchId ? '当前本场' : '候选比赛'}</span>
              {!editingMatch ? (
                <Button
                  disabled={!canWrite}
                  onClick={() => {
                    if (!canChange()) return;
                    setEditingMatchScope(
                      match.matchId === view?.activeLocalMatchId ? 'match' : 'candidate',
                    );
                    setEditingMatch(true);
                  }}
                >
                  编辑比赛
                </Button>
              ) : (
                <span>正在编辑比赛</span>
              )}
            </header>
            <div className="library-detail-body" hidden={editingMatch}>
              <MatchDocumentView document={match} section="details" />
              <MatchDocumentView document={match} section="roster" />
              <details>
                <summary>地图与禁选资料</summary>
                <MatchDocumentView document={match} section="maps" />
              </details>
            </div>
            {editingMatch ? (
              <LocalTournamentEditor
                key={match.matchId}
                document={match}
                view={view}
                refresh={refresh}
                action={action}
                canSave={canWrite}
                scope={editingMatchScope}
                section="overview"
                onDirtyChange={markDirty}
                onCancel={() => setEditingMatch(false)}
              />
            ) : (
              <footer className="library-detail-actions">
                <small>
                  {match.matchId === view?.activeLocalMatchId ? '本场已载入' : '浏览不会切换本场'}
                </small>
                {match.matchId === view?.activeLocalMatchId ? (
                  <Button variant="primary" onClick={() => window.location.assign('/?tab=match')}>
                    前往本场准备
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    disabled={!canWrite}
                    onClick={() => {
                      if (
                        !canChange() ||
                        !window.confirm(
                          `将本场切换为 ${match.entrants.a.name} vs ${match.entrants.b.name}？`,
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
                )}
              </footer>
            )}
          </>
        ) : !editing ? (
          <Panel>
            <h2>比赛详情</h2>
            <p>选择赛程中的一场查看双方、名单与地图；浏览不会自动载入。</p>
          </Panel>
        ) : null}
        {event && editing && !creating ? (
          <div className="event-inline-edit" key={eventId}>
            <h2>赛事品牌与默认规则 · {event.name}</h2>
            <LocalTournamentEditor
              eventId={eventId}
              view={view}
              refresh={refresh}
              action={action}
              scope="resources"
              canSave={canWrite}
              onCancel={() => setEditing(false)}
              section="overview"
              onDirtyChange={markDirty}
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}
