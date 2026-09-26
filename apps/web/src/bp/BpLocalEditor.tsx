import { useState } from 'react';
import { localBpSequence } from '@rivalhub-broadcast/core/projection';
import type { BpWorkspace, LocalBpDraft } from '@rivalhub-broadcast/protocol/bp';
import { saveLocalBp } from './client';

function emptyDraft(workspace: BpWorkspace): LocalBpDraft {
  return {
    competitionName: '',
    stage: '',
    format: 'bo3',
    entrants: {
      a: { name: '', logoUrl: null },
      b: { name: '', logoUrl: null },
    },
    vetoA: 'a',
    mapPool: [...workspace.defaultMapPool],
    bans: Array(4).fill('') as string[],
    picks: Array.from({ length: 2 }, () => ({ mapName: '', side: null })),
    deciderSide: null,
  };
}

function draftProblems(draft: LocalBpDraft, workspace: BpWorkspace): string[] {
  const issues: string[] = [];
  if (!draft.entrants.a.name.trim() || !draft.entrants.b.name.trim())
    issues.push('请填写两支队伍的名称。');
  if (draft.mapPool.length !== 7) issues.push('地图池需要正好选择 7 张。');
  const banCount = draft.format === 'bo1' ? 6 : draft.format === 'bo3' ? 4 : 2;
  const pickCount = draft.format === 'bo1' ? 0 : draft.format === 'bo3' ? 2 : 4;
  if (draft.bans.length !== banCount || draft.bans.some((name) => !name))
    issues.push('请完成所有禁用地图。');
  if (draft.picks.length !== pickCount || draft.picks.some((pick) => !pick.mapName))
    issues.push('请完成所有选择地图。');
  if (draft.picks.some((pick) => pick.side === null)) issues.push('请填写每张已选地图的 CT / T。');
  if (draft.format !== 'bo5' && draft.deciderSide === null) issues.push('请填写决胜图的 CT / T。');
  const maps = [...draft.bans, ...draft.picks.map((pick) => pick.mapName)].filter(Boolean);
  if (maps.some((name) => !draft.mapPool.includes(name)) || new Set(maps).size !== maps.length)
    issues.push('地图不能重复，且必须来自当前地图池。');
  const options = new Set(workspace.mapPoolOptions.map((option) => option.mapName));
  if (draft.mapPool.some((name) => !options.has(name))) issues.push('地图池包含不支持的地图。');
  return issues;
}

export function BpLocalEditor({
  workspace,
  onCancel,
  onSaved,
}: {
  readonly workspace: BpWorkspace;
  readonly onCancel: () => void;
  readonly onSaved: (message: string) => void;
}) {
  const [baseContextRevision] = useState(workspace.contextRevision);
  const localSource =
    workspace.source === 'local' || (workspace.source === 'cache' && workspace.localDraft !== null);
  const lockedMatch = workspace.match !== null && !localSource;
  const [initial] = useState(
    () => workspace.localDraft ?? workspace.authoringDraft ?? emptyDraft(workspace),
  );
  const [draft, setDraft] = useState<LocalBpDraft>(() => initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problems = draftProblems(draft, workspace);
  const contextChanged = workspace.contextRevision !== baseContextRevision;
  const actions = localBpSequence(draft.format, draft.vetoA);
  const pool = draft.mapPool;

  function changeFormat(format: LocalBpDraft['format']) {
    setDraft((current) => ({
      ...current,
      format,
      bans: Array(format === 'bo1' ? 6 : format === 'bo3' ? 4 : 2).fill('') as string[],
      picks: Array.from({ length: format === 'bo1' ? 0 : format === 'bo3' ? 2 : 4 }, () => ({
        mapName: '',
        side: null,
      })),
      deciderSide: null,
    }));
  }

  function selectedMaps(except: string): string[] {
    return [...draft.bans, ...draft.picks.map((pick) => pick.mapName)].filter(
      (name) => name && name !== except,
    );
  }

  function mapSelector(value: string, label: string, onChange: (mapName: string) => void) {
    const options = workspace.mapPoolOptions.filter(
      (option) => pool.includes(option.mapName) || option.mapName === value,
    );
    const used = new Set(selectedMaps(value));
    return (
      <label className="bp-editor-field">
        <span>{label}</span>
        <select
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          aria-label={label}
        >
          <option value="">选择地图</option>
          {options.map((option) => (
            <option key={option.mapName} value={option.mapName} disabled={used.has(option.mapName)}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  function sideSelector(
    value: 'CT' | 'T' | null,
    label: string,
    onChange: (side: 'CT' | 'T' | null) => void,
  ) {
    return (
      <label className="bp-editor-field bp-editor-side-field">
        <span>{label}</span>
        <select
          value={value ?? ''}
          onChange={(event) =>
            onChange(
              event.currentTarget.value === '' ? null : (event.currentTarget.value as 'CT' | 'T'),
            )
          }
          aria-label={label}
        >
          <option value="">请选择</option>
          <option value="CT">CT 开</option>
          <option value="T">T 开</option>
        </select>
      </label>
    );
  }

  async function save() {
    if (saving || problems.length > 0 || contextChanged) return;
    setSaving(true);
    setError(null);
    try {
      const message = await saveLocalBp(draft, baseContextRevision);
      onSaved(message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败，当前 BP 保持不变。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="bp-local-editor" aria-labelledby="bp-local-editor-title">
      <div className="bp-editor-heading">
        <div>
          <span className="bp-workspace-eyebrow">LOCAL AUTHORING</span>
          <h2 id="bp-local-editor-title">
            {lockedMatch ? '为当前比赛补录 BP' : localSource ? '编辑本地 BP' : '本地填写 BP'}
          </h2>
          <p>
            {lockedMatch
              ? '赛事、赛制、队伍和名单来自当前比赛并保持锁定；保存只替换本地 BP。'
              : localSource
                ? '本地比赛身份保持稳定；保存只应用你修改的比赛信息和 BP。'
                : '填写独立比赛的基本信息与 BP；保存后收起当前播出。'}{' '}
            编辑内容不会影响当前画面。
          </p>
        </div>
        <span className="bp-editor-count">{lockedMatch ? '当前比赛' : '本地比赛'}</span>
      </div>

      <div className="bp-editor-match-fields">
        <label className="bp-editor-field">
          <span>
            赛事名称 <small>可选</small>
          </span>
          <input
            value={draft.competitionName}
            maxLength={120}
            disabled={lockedMatch}
            onChange={(event) => {
              const competitionName = event.currentTarget.value;
              setDraft((value) => ({ ...value, competitionName }));
            }}
            placeholder="本地赛事"
          />
        </label>
        <label className="bp-editor-field">
          <span>
            阶段 <small>可选</small>
          </span>
          <input
            value={draft.stage}
            maxLength={120}
            disabled={lockedMatch}
            onChange={(event) => {
              const stage = event.currentTarget.value;
              setDraft((value) => ({ ...value, stage }));
            }}
            placeholder="例如：决赛"
          />
        </label>
        <label className="bp-editor-field">
          <span>比赛赛制</span>
          <select
            value={draft.format}
            disabled={lockedMatch}
            onChange={(event) => changeFormat(event.currentTarget.value as LocalBpDraft['format'])}
          >
            <option value="bo1">BO1</option>
            <option value="bo3">BO3</option>
            <option value="bo5">BO5</option>
          </select>
        </label>
        <label className="bp-editor-field">
          <span>Veto A</span>
          <select
            value={draft.vetoA}
            onChange={(event) => {
              const vetoA = event.currentTarget.value as 'a' | 'b';
              setDraft((value) => ({ ...value, vetoA }));
            }}
          >
            <option value="a">队伍 A · {draft.entrants.a.name || '待填写'}</option>
            <option value="b">队伍 B · {draft.entrants.b.name || '待填写'}</option>
          </select>
        </label>
      </div>

      <div className="bp-editor-teams">
        {(['a', 'b'] as const).map((key) => (
          <fieldset className="bp-editor-team" key={key} data-entrant={key}>
            <legend>队伍 {key.toUpperCase()}</legend>
            <label className="bp-editor-field">
              <span>队伍名称</span>
              <input
                value={draft.entrants[key].name}
                maxLength={80}
                required
                disabled={lockedMatch}
                onChange={(event) => {
                  const name = event.currentTarget.value;
                  setDraft((value) => ({
                    ...value,
                    entrants: {
                      ...value.entrants,
                      [key]: { ...value.entrants[key], name },
                    },
                  }));
                }}
                placeholder={key === 'a' ? '左侧队伍' : '右侧队伍'}
              />
            </label>
            <label className="bp-editor-field">
              <span>
                队标地址 <small>可选</small>
              </span>
              <input
                value={draft.entrants[key].logoUrl ?? ''}
                maxLength={512}
                disabled={lockedMatch}
                onChange={(event) => {
                  const logoUrl = event.currentTarget.value || null;
                  setDraft((value) => ({
                    ...value,
                    entrants: {
                      ...value.entrants,
                      [key]: { ...value.entrants[key], logoUrl },
                    },
                  }));
                }}
                placeholder="HTTPS 地址或本地路径"
              />
            </label>
          </fieldset>
        ))}
      </div>

      <fieldset className="bp-map-pool">
        <legend>
          地图池 <span>{draft.mapPool.length} / 7</span>
        </legend>
        <div className="bp-map-pool-grid">
          {workspace.mapPoolOptions.map((option) => {
            const checked = pool.includes(option.mapName);
            return (
              <label key={option.mapName}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && pool.length >= 7}
                  onChange={() =>
                    setDraft((value) => ({
                      ...value,
                      mapPool: checked
                        ? value.mapPool.filter((name) => name !== option.mapName)
                        : [...value.mapPool, option.mapName],
                    }))
                  }
                />
                <span>{option.label}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <section className="bp-editor-sequence" aria-labelledby="bp-sequence-title">
        <div className="bp-sequence-heading">
          <div>
            <span className="bp-workspace-eyebrow">CANONICAL VETO ORDER</span>
            <h3 id="bp-sequence-title">BP 顺序</h3>
          </div>
          <p>操作方与步骤由赛制固定</p>
        </div>
        <ol className="bp-sequence-list">
          {actions.map((action, index) => {
            const actorName =
              action.actor === null
                ? '系统'
                : draft.entrants[action.actor].name || `队伍 ${action.actor.toUpperCase()}`;
            if (action.kind === 'ban') {
              const value = draft.bans[action.valueIndex] ?? '';
              return (
                <li className="bp-sequence-step" key={`${action.kind}-${index}`}>
                  <span className="bp-sequence-number">{String(index + 1).padStart(2, '0')}</span>
                  <span className="bp-sequence-actor">{actorName}</span>
                  <span className="bp-sequence-kind">BAN · 禁用</span>
                  {mapSelector(value, `${actorName} 禁用地图`, (mapName) =>
                    setDraft((current) => {
                      const bans = [...current.bans];
                      bans[action.valueIndex] = mapName;
                      return { ...current, bans };
                    }),
                  )}
                </li>
              );
            }
            if (action.kind === 'pick') {
              const value = draft.picks[action.valueIndex]?.mapName ?? '';
              return (
                <li className="bp-sequence-step" key={`${action.kind}-${index}`}>
                  <span className="bp-sequence-number">{String(index + 1).padStart(2, '0')}</span>
                  <span className="bp-sequence-actor">{actorName}</span>
                  <span className="bp-sequence-kind">PICK · 选择</span>
                  {mapSelector(value, `${actorName} 选择地图`, (mapName) =>
                    setDraft((current) => {
                      const picks = [...current.picks];
                      const pick = picks[action.valueIndex];
                      if (pick) picks[action.valueIndex] = { ...pick, mapName };
                      return { ...current, picks };
                    }),
                  )}
                </li>
              );
            }
            if (action.kind === 'side_pick') {
              const targetName =
                action.target === 'decider'
                  ? '决胜地图'
                  : draft.picks[action.targetIndex]?.mapName ||
                    `选择地图 ${action.targetIndex + 1}`;
              const currentSide =
                action.target === 'decider'
                  ? draft.deciderSide
                  : (draft.picks[action.targetIndex]?.side ?? null);
              return (
                <li
                  className="bp-sequence-step bp-sequence-step--side"
                  key={`${action.kind}-${index}`}
                >
                  <span className="bp-sequence-number">{String(index + 1).padStart(2, '0')}</span>
                  <span className="bp-sequence-actor">{actorName}</span>
                  <span className="bp-sequence-kind">SIDE · {targetName}</span>
                  {sideSelector(currentSide, `${actorName} · ${targetName} 起始边`, (side) =>
                    setDraft((current) => {
                      if (action.target === 'decider') return { ...current, deciderSide: side };
                      const picks = [...current.picks];
                      const pick = picks[action.targetIndex];
                      if (pick) picks[action.targetIndex] = { ...pick, side };
                      return { ...current, picks };
                    }),
                  )}
                </li>
              );
            }
            const used = new Set(
              [...draft.bans, ...draft.picks.map((pick) => pick.mapName)].filter(Boolean),
            );
            const decider = pool.find((mapName) => !used.has(mapName));
            return (
              <li
                className="bp-sequence-step bp-sequence-step--decider"
                key={`${action.kind}-${index}`}
              >
                <span className="bp-sequence-number">{String(index + 1).padStart(2, '0')}</span>
                <span className="bp-sequence-actor">系统</span>
                <span className="bp-sequence-kind">DECIDER · 自动剩余</span>
                <strong className="bp-sequence-decider">
                  {workspace.mapPoolOptions.find((option) => option.mapName === decider)?.label ??
                    '等待剩余地图'}
                </strong>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="bp-editor-feedback" aria-live="polite">
        {contextChanged ? (
          <p role="alert">比赛上下文已更新。为保护新数据，请取消编辑后重新打开本地填写。</p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        {!contextChanged && !error && problems.length > 0 ? (
          <p role="status">本地 BP 有未完成字段：{problems[0]}</p>
        ) : null}
      </div>
      <div className="bp-editor-actions">
        <button
          type="button"
          className="bp-button bp-button--quiet"
          onClick={() => setDraft(initial)}
          disabled={saving}
        >
          重置
        </button>
        <button
          type="button"
          className="bp-button bp-button--quiet"
          onClick={onCancel}
          disabled={saving}
        >
          取消编辑
        </button>
        <button
          type="button"
          className="bp-button bp-button--primary"
          onClick={() => void save()}
          disabled={saving || problems.length > 0 || contextChanged}
        >
          {saving ? '正在保存…' : '保存本地 BP'}
        </button>
      </div>
    </section>
  );
}
