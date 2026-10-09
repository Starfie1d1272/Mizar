import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, StatusBanner, Select } from '../ui';
import { LOCAL_BP_MAP_CATALOG, DEFAULT_BO3_BP_RULES } from '@mizar/core/projection';
import type { Bo3BpRules } from '@mizar/core/projection';
import type { MatchDocumentV1 } from '@mizar/protocol/context';

export interface LocalTournamentView {
  readonly teams: readonly { readonly teamId: string; readonly name: string }[];
  readonly events: readonly {
    readonly eventId: string;
    readonly name: string;
    readonly logoUrl: string | null;
    readonly themeColor: string | null;
    readonly mapPool: readonly string[];
    readonly bo3Rules?: Bo3BpRules;
    readonly matchIds: readonly string[];
  }[];
  readonly matches: readonly MatchDocumentV1[];
  readonly selectedMatchId: string | null;
  readonly activeLocalMatchId: string | null;
  readonly contextRevision: string;
  readonly neighborhood: {
    readonly previous: {
      readonly entrants: {
        readonly a: { readonly name: string };
        readonly b: { readonly name: string };
      };
      readonly scoreA: number | null;
      readonly scoreB: number | null;
    } | null;
    readonly next: {
      readonly entrants: {
        readonly a: { readonly name: string };
        readonly b: { readonly name: string };
      };
      readonly scheduledAt: string | null;
    } | null;
  };
}

async function command(path: string, payload: unknown): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok)
    throw new Error(
      response.status === 409
        ? '本场已变化，请核对后重新保存；当前草稿保留。'
        : '本地比赛保存失败，请检查填写内容。',
    );
}

async function uploadImage(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 512_000)
    throw new Error('请选择不超过 500 KB 的 PNG、JPEG 或 WebP 图片。');
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === 'string' ? (reader.result.split(',', 2)[1] ?? '') : '');
    reader.onerror = () => reject(new Error('图片读取失败。'));
    reader.readAsDataURL(file);
  });
  const response = await fetch('/operator/local-asset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mimeType: file.type, base64 }),
  });
  if (!response.ok) throw new Error('图片保存失败。');
  return ((await response.json()) as { url: string }).url;
}

function localInputTime(value: string | null): string {
  if (value === null) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function editableMatch(document: MatchDocumentV1 | null | undefined) {
  return document
    ? {
        format: document.format,
        stageLabel: document.stageLabel,
        roundLabel: document.roundLabel,
        scheduledAt: document.scheduledAt,
        entrants: document.entrants,
      }
    : null;
}

export function LocalTournamentEditor({
  document,
  view,
  refresh,
  action,
  section = 'details',
  scope = 'match',
  eventId,
  onDirtyChange,
  canSave = true,
}: {
  readonly canSave?: boolean;
  readonly scope?: 'match' | 'resources';
  readonly document?: MatchDocumentV1 | null;
  readonly eventId?: string;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly section?: 'details' | 'roster' | 'maps' | 'overview';
  readonly view: LocalTournamentView | null;
  readonly refresh: () => Promise<void>;
  readonly action: (run: () => Promise<unknown>) => Promise<void>;
}) {
  const selected = document;
  const event = view?.events.find(
    (item) => item.eventId === (eventId ?? selected?.competition?.competitionId),
  );
  const [draft, setDraft] = useState<MatchDocumentV1 | null>(selected ?? null);
  const [eventName, setEventName] = useState(event?.name ?? '');
  const [eventLogo, setEventLogo] = useState<string | null>(event?.logoUrl ?? null);
  const [eventTheme, setEventTheme] = useState<string | null>(event?.themeColor ?? null);
  const [eventPool, setEventPool] = useState<readonly string[]>(event?.mapPool ?? []);
  const [eventBo3Rules, setEventBo3Rules] = useState(event?.bo3Rules ?? DEFAULT_BO3_BP_RULES);
  const [savedMessage, setSavedMessage] = useState('');
  const previousDocument = useRef(selected);
  useEffect(() => {
    const previous = previousDocument.current;
    previousDocument.current = selected;
    if (scope !== 'match' || !selected) return;
    setDraft((current) =>
      JSON.stringify(editableMatch(current)) === JSON.stringify(editableMatch(previous))
        ? selected
        : current,
    );
  }, [selected, scope]);
  const dirty =
    scope === 'match'
      ? draft !== null &&
        JSON.stringify(editableMatch(draft)) !== JSON.stringify(editableMatch(selected))
      : event !== undefined &&
        (eventName !== event.name ||
          eventLogo !== event.logoUrl ||
          eventTheme !== event.themeColor ||
          JSON.stringify(eventPool) !== JSON.stringify(event.mapPool) ||
          JSON.stringify(eventBo3Rules) !== JSON.stringify(event.bo3Rules ?? DEFAULT_BO3_BP_RULES));
  useEffect(() => {
    onDirtyChange?.(dirty);
    const protect = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', protect);
    return () => {
      window.removeEventListener('beforeunload', protect);
      onDirtyChange?.(false);
    };
  }, [dirty, onDirtyChange]);
  if (
    view === null ||
    (scope === 'match' && draft === null) ||
    (scope === 'resources' && event === undefined) ||
    (scope === 'match' && view?.activeLocalMatchId !== draft?.matchId)
  )
    return null;

  const contextReady =
    canSave &&
    (scope !== 'match' ||
      JSON.stringify(view.matches.find((item) => item.matchId === selected?.matchId)) ===
        JSON.stringify(selected));
  const updateEntrant = (side: 'a' | 'b', patch: Partial<MatchDocumentV1['entrants']['a']>) =>
    setDraft((current) =>
      current === null
        ? null
        : {
            ...current,
            entrants: {
              ...current.entrants,
              [side]: { ...current.entrants[side], ...patch },
            },
          },
    );
  return (
    <div className="preparation-editor" data-section={section}>
      {savedMessage ? <StatusBanner tone="info">{savedMessage}</StatusBanner> : null}
      {scope === 'match' && draft !== null && section !== 'maps' ? (
        <form
          onSubmit={(submit) => {
            submit.preventDefault();
            if (!contextReady) return;
            if (
              !window.confirm(
                '保存将更新本场资料，并同步队伍库中的队名、队标与名单，影响今后复用。当前节目可能刷新，确认保存？',
              )
            )
              return;
            setSavedMessage('');
            void action(async () => {
              await command('/operator/local-match/save', {
                expectedContextRevision: view.contextRevision,
                document: { ...selected, ...editableMatch(draft) },
              });
              await refresh();
              setSavedMessage('比赛资料已保存。');
            });
          }}
        >
          {section === 'details' || section === 'overview' ? (
            <details open={section === 'details'} className="match-meta-edit">
              <summary>
                场次信息 · {draft.format.toUpperCase()} · {draft.stageLabel || '阶段待填写'}
              </summary>
              <div className="match-meta-fields">
                <label>
                  赛制{' '}
                  <select
                    value={draft.format}
                    onChange={(change) =>
                      setDraft({ ...draft, format: change.target.value as typeof draft.format })
                    }
                  >
                    {['bo1', 'bo3', 'bo5'].map((bo) => (
                      <option value={bo} key={bo}>
                        {bo.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  阶段名称{' '}
                  <input
                    value={draft.stageLabel}
                    onChange={(change) => setDraft({ ...draft, stageLabel: change.target.value })}
                  />
                </label>
                <label>
                  轮次（选填）{' '}
                  <input
                    value={draft.roundLabel ?? ''}
                    onChange={(change) =>
                      setDraft({ ...draft, roundLabel: change.target.value || null })
                    }
                  />
                </label>
                <label>
                  计划开始{' '}
                  <input
                    type="datetime-local"
                    value={localInputTime(draft.scheduledAt)}
                    onChange={(change) =>
                      setDraft({
                        ...draft,
                        scheduledAt: change.target.value
                          ? new Date(change.target.value).toISOString()
                          : null,
                      })
                    }
                  />
                </label>
              </div>
            </details>
          ) : null}
          {section === 'roster' || section === 'overview'
            ? (['a', 'b'] as const).map((side) => (
                <fieldset key={side}>
                  <legend>{draft.entrants[side].name || `队伍 ${side.toUpperCase()}`}</legend>
                  <details open={section === 'roster'}>
                    <summary>编辑队伍资料</summary>
                    <label>
                      队名{' '}
                      <input
                        value={draft.entrants[side].name}
                        onChange={(change) => updateEntrant(side, { name: change.target.value })}
                      />
                    </label>
                    <label>
                      队标图片{' '}
                      <input
                        type="file"
                        disabled={!canSave}
                        accept="image/png,image/jpeg,image/webp"
                        onChange={(change) => {
                          const file = change.target.files?.[0];
                          if (!file) return;
                          void action(async () =>
                            updateEntrant(side, { logoUrl: await uploadImage(file) }),
                          );
                        }}
                      />
                    </label>
                    {draft.entrants[side].logoUrl ? (
                      <img
                        src={draft.entrants[side].logoUrl}
                        alt={`${draft.entrants[side].name} 队标`}
                      />
                    ) : null}
                  </details>
                  <ul>
                    {draft.entrants[side].players.map((player) => (
                      <li key={player.playerId}>
                        {player.displayName ?? '未命名选手'} · {player.isStarter ? '首发' : '替补'}
                      </li>
                    ))}
                  </ul>
                  <details>
                    <summary>手动编辑名单</summary>
                    {draft.entrants[side].players.map((player, index) => (
                      <div key={player.playerId} className="workspace-roster-row">
                        <input
                          aria-label="选手名称"
                          placeholder="选手名称"
                          value={player.displayName ?? ''}
                          onChange={(change) =>
                            updateEntrant(side, {
                              players: draft.entrants[side].players.map((item, i) =>
                                i === index
                                  ? { ...item, displayName: change.target.value || null }
                                  : item,
                              ),
                            })
                          }
                        />
                        <input
                          aria-label="Steam64"
                          placeholder="Steam64"
                          value={player.steam64 ?? ''}
                          onChange={(change) =>
                            updateEntrant(side, {
                              players: draft.entrants[side].players.map((item, i) =>
                                i === index
                                  ? { ...item, steam64: change.target.value || null }
                                  : item,
                              ),
                            })
                          }
                        />
                        <label>
                          首发{' '}
                          <input
                            type="checkbox"
                            checked={player.isStarter}
                            onChange={(change) =>
                              updateEntrant(side, {
                                players: draft.entrants[side].players.map((item, i) =>
                                  i === index
                                    ? { ...item, isStarter: change.target.checked }
                                    : item,
                                ),
                              })
                            }
                          />
                        </label>
                        <Button
                          type="button"
                          onClick={() =>
                            updateEntrant(side, {
                              players: draft.entrants[side].players.filter((_, i) => i !== index),
                            })
                          }
                        >
                          移除
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      onClick={() =>
                        updateEntrant(side, {
                          players: [
                            ...draft.entrants[side].players,
                            {
                              playerId: crypto.randomUUID(),
                              steam64: null,
                              displayName: null,
                              avatarUrl: null,
                              isStarter: draft.entrants[side].players.length < 5,
                            },
                          ],
                        })
                      }
                    >
                      添加选手
                    </Button>
                  </details>
                </fieldset>
              ))
            : null}
          <p>
            保存本场同时同步队伍库的队名、队标与名单；已有其他比赛快照不改写，今后复用使用更新后的队伍。
          </p>
          {!contextReady ? <p role="status">正在核对本场连接与保存版本；资料草稿保留。</p> : null}
          <Button type="submit" disabled={!contextReady}>
            保存比赛资料
          </Button>
        </form>
      ) : null}
      {scope === 'resources' && event !== undefined && section !== 'roster' ? (
        <form
          onSubmit={(submit) => {
            submit.preventDefault();
            if (!canSave) return;
            const affectsCurrent = event.matchIds.includes(view.activeLocalMatchId ?? '');
            if (
              affectsCurrent &&
              !window.confirm(
                '保存将传播赛事品牌至所有同赛事比赛；仍沿用旧默认的地图池同步更新。包含当前本场，节目可能立即刷新。确认保存？',
              )
            )
              return;
            setSavedMessage('');
            void action(async () => {
              await command('/operator/local-event/save', {
                eventId: event.eventId,
                name: eventName,
                logoUrl: eventLogo,
                themeColor: eventTheme,
                mapPool: eventPool,
                bo3Rules: eventBo3Rules,
              });
              await refresh();
              setSavedMessage('赛事资料已保存。');
            });
          }}
        >
          <p>
            保存会传播赛事名称、Logo 与品牌色至同赛事所有比赛；仅仍沿用旧默认的比赛同步地图池。BO3
            默认规则供 BP 准备使用；已保存禁选步骤不改写。包含当前本场时可能立即刷新节目。
          </p>
          {section === 'details' || section === 'overview' ? (
            <>
              <label>
                赛事名称{' '}
                <input value={eventName} onChange={(change) => setEventName(change.target.value)} />
              </label>
              <label>
                赛事 Logo{' '}
                <input
                  type="file"
                  disabled={!canSave}
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(change) => {
                    const file = change.target.files?.[0];
                    if (!file) return;
                    void action(async () => setEventLogo(await uploadImage(file)));
                  }}
                />
              </label>
              {eventLogo ? <img src={eventLogo} alt={`${eventName} Logo`} /> : null}
              <label>
                赛事品牌色（选填）{' '}
                <input
                  value={eventTheme ?? ''}
                  placeholder="#RRGGBB"
                  pattern="#[0-9a-fA-F]{6}"
                  onChange={(change) => setEventTheme(change.target.value || null)}
                />
              </label>
            </>
          ) : null}
          {section === 'maps' || section === 'overview' ? (
            <>
              <fieldset className="preparation-map-pool">
                <legend>赛事地图池</legend>
                <div className="preparation-map-pool__choices">
                  {LOCAL_BP_MAP_CATALOG.map(({ mapName, label }) => (
                    <Checkbox
                      key={mapName}
                      label={label}
                      checked={eventPool.includes(mapName)}
                      onChange={(change) =>
                        setEventPool(
                          change.target.checked
                            ? [...eventPool, mapName]
                            : eventPool.filter((name) => name !== mapName),
                        )
                      }
                    />
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>赛事 BO3 禁选规则</legend>
                <Select
                  label="BO3 最后两次禁图"
                  value={eventBo3Rules.finalBanOrder}
                  onChange={(change) => {
                    const finalBanOrder = change.currentTarget.value as Bo3BpRules['finalBanOrder'];
                    setEventBo3Rules((current) => ({ ...current, finalBanOrder }));
                  }}
                  message="先禁图方先选择第一张地图；选图由对手选边。"
                >
                  <option value="veto_b_first">后禁方先禁，再由先禁方禁图</option>
                  <option value="veto_a_first">先禁方先禁，再由后禁方禁图</option>
                </Select>
                <Select
                  label="BO3 决胜图起始阵营"
                  value={eventBo3Rules.deciderSideChoice}
                  onChange={(change) => {
                    const deciderSideChoice = change.currentTarget
                      .value as Bo3BpRules['deciderSideChoice'];
                    setEventBo3Rules((current) => ({ ...current, deciderSideChoice }));
                  }}
                  message="游戏内决定时不预填 CT / T，例如通过拼刀决定。"
                >
                  <option value="veto_b">由后禁方选择</option>
                  <option value="veto_a">由先禁方选择</option>
                  <option value="in_game">游戏内决定（如拼刀）</option>
                </Select>
                <p>用于本赛事新填写的 BO3；保存规则不会改写已经录入的 BP。</p>
              </fieldset>
            </>
          ) : null}
          <Button type="submit" disabled={!canSave}>
            保存赛事资料
          </Button>
        </form>
      ) : null}
      {scope === 'resources' &&
      event !== undefined &&
      (section === 'details' || section === 'overview') &&
      event.matchIds.length > 1 ? (
        <div className="workspace-local-schedule">
          <strong>比赛顺序</strong>
          {event.matchIds.map((id, index) => {
            const match = view.matches.find((item) => item.matchId === id);
            return (
              <div key={id}>
                <span>
                  {match?.entrants.a.name} vs {match?.entrants.b.name}
                </span>
                <Button
                  type="button"
                  disabled={!canSave || index === 0}
                  onClick={() =>
                    void action(async () => {
                      const ids = [...event.matchIds];
                      [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!];
                      await command('/operator/local-schedule/reorder', {
                        eventId: event.eventId,
                        matchIds: ids,
                      });
                      await refresh();
                    })
                  }
                >
                  上移
                </Button>
                <Button
                  type="button"
                  disabled={!canSave || index === event.matchIds.length - 1}
                  onClick={() =>
                    void action(async () => {
                      const ids = [...event.matchIds];
                      [ids[index + 1], ids[index]] = [ids[index]!, ids[index + 1]!];
                      await command('/operator/local-schedule/reorder', {
                        eventId: event.eventId,
                        matchIds: ids,
                      });
                      await refresh();
                    })
                  }
                >
                  下移
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
