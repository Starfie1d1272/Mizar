import { useCallback, useRef, useState } from 'react';
import { Button, Panel, Select, useConfirmation } from '../ui';
import {
  LocalTournamentEditor,
  type LocalTournamentView,
} from '../workspace/LocalTournamentEditor';
import { LibraryWorkspace } from '../patterns/LibraryWorkspace';
import { LibraryMatchDetails, libraryMatchTime } from './LibraryMatchDetails';
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
  const confirmation = useConfirmation();
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
  const canChange = async () =>
    !dirty.current || (await confirmation.confirm('赛事资料有未保存修改，放弃后切换资源？'));
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
    <LibraryWorkspace
      status={
        <>
          <span>本地资料 · {matches.length} 场</span>
          <span>浏览不会切换本场</span>
        </>
      }
      items={matches.map((item) => ({
        id: item.matchId,
        title: `${item.entrants.a.name} vs ${item.entrants.b.name}`,
        summary: `${libraryMatchTime(item.scheduledAt)} · ${item.format.toUpperCase()}${item.stageLabel ? ` · ${item.stageLabel}` : ''}`,
        status: item.matchId === view?.activeLocalMatchId ? '当前本场' : '候选，尚未载入',
      }))}
      selectedId={match?.matchId}
      emptyMessage="本分组暂无比赛，可创建第一场。"
      onSelect={async (id) => {
        if (!(await canChange())) return;
        setMatchId(id);
        setEditing(false);
        setCreating(false);
        setEditingMatch(false);
        const url = new URL(window.location.href);
        url.searchParams.set('resource', id);
        window.history.replaceState(null, '', url);
      }}
      browserHeader={
        <>
          <Select
            label="浏览赛事"
            value={eventId}
            onChange={async (change) => {
              const selectedEvent = change.target.value;
              if (!(await canChange())) return;
              const url = new URL(window.location.href);
              url.searchParams.set('event', selectedEvent);
              url.searchParams.delete('resource');
              window.history.replaceState(null, '', url);
              setEventId(selectedEvent);
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
        </>
      }
      browserActions={
        <>
          {event ? (
            <Button
              aria-expanded={editing}
              onClick={async () => {
                if (!(await canChange())) return;
                setEditing((value) => !value);
                setCreating(false);
                setEditingMatch(false);
              }}
            >
              编辑赛事品牌与默认规则
            </Button>
          ) : null}
          <Button
            onClick={async () => {
              if (!(await canChange())) return;
              setCreating((value) => !value);
              setEditing(false);
              setEditingMatch(false);
            }}
          >
            {event ? '在此赛事追加下一场' : '创建本地比赛'}
          </Button>
        </>
      }
      header={
        !creating && !editing && match ? (
          <>
            <span>{match.matchId === view?.activeLocalMatchId ? '当前本场' : '候选比赛'}</span>
            {!editingMatch ? (
              <Button
                disabled={!canWrite}
                onClick={async () => {
                  if (!(await canChange())) return;
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
          </>
        ) : null
      }
      footer={
        !creating && !editing && !editingMatch && match ? (
          <>
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
                onClick={async () => {
                  if (
                    !(await canChange()) ||
                    !(await confirmation.confirm(
                      `将本场切换为 ${match.entrants.a.name} vs ${match.entrants.b.name}？`,
                    ))
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
          </>
        ) : null
      }
    >
      {confirmation.dialog}
      {creating ? (
        <Panel>
          <h2>创建本地比赛</h2>
          <LocalMatchControls
            key={eventId}
            mode="create"
            initialEventId={event?.eventId ?? ''}
            onCancel={() => setCreating(false)}
            beforeApply={async () => canWrite && (await canChange())}
            action={action}
            onSelected={() => window.location.assign('/?tab=match')}
          />
        </Panel>
      ) : !editing && match ? (
        <>
          {!editingMatch ? <LibraryMatchDetails document={match} /> : null}
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
          ) : null}
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
    </LibraryWorkspace>
  );
}
