import { useState } from 'react';
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
  if (!response.ok) throw new Error('本地比赛保存失败，请检查填写内容。');
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

export function LocalTournamentEditor({
  document,
  view,
  refresh,
  action,
  section = 'details',
  scope = 'match',
}: {
  readonly scope?: 'match' | 'resources';
  readonly document: MatchDocumentV1;
  readonly section?: 'details' | 'roster' | 'maps';
  readonly view: LocalTournamentView | null;
  readonly refresh: () => Promise<void>;
  readonly action: (run: () => Promise<unknown>) => Promise<void>;
}) {
  const selected = document;
  const event = view?.events.find((item) => item.eventId === selected?.competition?.competitionId);
  const [draft, setDraft] = useState<MatchDocumentV1 | null>(selected ?? null);
  const [eventName, setEventName] = useState(event?.name ?? '');
  const [eventLogo, setEventLogo] = useState<string | null>(event?.logoUrl ?? null);
  const [eventPool, setEventPool] = useState<readonly string[]>(event?.mapPool ?? []);
  const [eventBo3Rules, setEventBo3Rules] = useState(event?.bo3Rules ?? DEFAULT_BO3_BP_RULES);
  const [savedMessage, setSavedMessage] = useState('');
  if (
    view === null ||
    draft === null ||
    event === undefined ||
    (scope === 'match' && view?.activeLocalMatchId !== draft.matchId)
  )
    return null;

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
      {scope === 'match' && section !== 'maps' ? (
        <form
          onSubmit={(submit) => {
            submit.preventDefault();
            setSavedMessage('');
            void action(async () => {
              await command('/operator/local-match/save', {
                expectedContextRevision: view.contextRevision,
                document: draft,
              });
              await refresh();
              setSavedMessage('比赛资料已保存。');
            });
          }}
        >
          {section === 'details' ? (
            <>
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
            </>
          ) : null}
          {section === 'roster'
            ? (['a', 'b'] as const).map((side) => (
                <fieldset key={side}>
                  <legend>队伍 {side.toUpperCase()}</legend>
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
          <Button type="submit">保存比赛资料</Button>
        </form>
      ) : null}
      {scope === 'resources' && section !== 'roster' ? (
        <form
          onSubmit={(submit) => {
            submit.preventDefault();
            setSavedMessage('');
            void action(async () => {
              await command('/operator/local-event/save', {
                eventId: event.eventId,
                name: eventName,
                logoUrl: eventLogo,
                themeColor: event.themeColor,
                mapPool: eventPool,
                bo3Rules: eventBo3Rules,
              });
              await refresh();
              setSavedMessage('赛事资料已保存。');
            });
          }}
        >
          {section === 'details' ? (
            <>
              <label>
                赛事名称{' '}
                <input value={eventName} onChange={(change) => setEventName(change.target.value)} />
              </label>
              <label>
                赛事 Logo{' '}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(change) => {
                    const file = change.target.files?.[0];
                    if (!file) return;
                    void action(async () => setEventLogo(await uploadImage(file)));
                  }}
                />
              </label>
              {eventLogo ? <img src={eventLogo} alt={`${eventName} Logo`} /> : null}
            </>
          ) : null}
          {section === 'maps' ? (
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
          <Button type="submit">保存赛事资料</Button>
        </form>
      ) : null}
      {scope === 'resources' && section === 'details' && event.matchIds.length > 1 ? (
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
                  disabled={index === 0}
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
                  disabled={index === event.matchIds.length - 1}
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
