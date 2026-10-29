import { useEffect, useRef, useState } from 'react';
import {
  parseModuleRecord,
  type CameraSourceRef,
  type ModuleRecord,
} from '@mizar/broadcast-config';
import { useLocalRead } from '../preparation/client';
import { Button, Checkbox, Field, Panel, Select, StatusBanner } from '../ui';
import { PresetVisualPreview } from './PresetVisualPreview';
import { pulseTokenStyle } from '../program/broadcast-display';
import { exportFailure } from './export-error';
import { MusicModuleEditor } from './MusicModuleEditor';
import { CameraModuleEditor } from './CameraModuleEditor';

type Kind = ModuleRecord['kind'];
export type Snapshot = {
  modules: ModuleRecord[];
  presets: {
    id: string;
    name: string;
    revision: string;
    bindings: ({ kind: Kind; mode: 'use'; moduleId: string } | { kind: Kind; mode: 'off' })[];
  }[];
  active: {
    revision: string;
    sourcePreset: { id: string; revision: string } | null;
    adjusted: boolean;
    sourceModuleIds?: Partial<Record<Kind, string | null>>;
    sourceModuleRevisions?: Partial<Record<Kind, string | null>>;
  };
};
type PackEntry = {
  entryId: string;
  type: 'module' | 'preset';
  kind?: Kind;
  name?: string;
  status: 'ready' | 'dependency_missing' | 'unsupported' | 'invalid' | 'existing' | 'removed';
  reason?: string;
  copies?: { id: string; state: 'existing' | 'removed'; owner?: string | null }[];
};
type PackInspection = {
  file: File;
  name: string;
  source: { digest: string };
  entries: PackEntry[];
};
const entryKey = (entry: Pick<PackEntry, 'type' | 'entryId'>) => `${entry.type}:${entry.entryId}`;
const entryStatus: Record<PackEntry['status'], string> = {
  ready: '可导入',
  dependency_missing: '所需来源暂不可用，可先保存',
  unsupported: '暂不支持',
  invalid: '内容无效',
  existing: '已存在',
  removed: '曾删除，可重新导入',
};
const labels: Record<Kind, string> = { hud: 'HUD', program: '场景', music: '音乐', camera: '运镜' };
type ImportResult = {
  entryId: string;
  type: 'module' | 'preset';
  result: 'imported' | 'existing' | 'unavailable' | 'not_selected';
  status?: PackEntry['status'];
  reason?: string;
  targetId?: string;
};
function entryName(entry: PackEntry, index: number): string {
  const kind = entry.type === 'preset' ? '方案' : (entry.kind && labels[entry.kind]) || '资源';
  return entry.name?.trim() || `${kind} ${index + 1}`;
}
function resultDescription(entry: PackEntry, result: ImportResult | undefined): string {
  if (result?.result === 'imported')
    return (result.status ?? entry.status) === 'dependency_missing'
      ? '已导入，使用前请检查所需来源'
      : '已导入';
  if (result?.result === 'existing') return '已存在，保留现有内容';
  const status = result?.status ?? entry.status;
  if (status === 'invalid') return '未导入：内容无效';
  if (status === 'unsupported') return '未导入：暂不支持此内容';
  if (result?.result === 'unavailable')
    return status === 'dependency_missing' ? '未导入：所需来源不可用' : '未导入：内容暂不可用';
  if (result?.result === 'not_selected') return '未导入：未选择';
  return '未导入：结果未确认';
}

const sceneColors = [
  ['pulse.white', '文字'],
  ['pulse.blue', '蓝色'],
  ['pulse.gold', '金色'],
  ['pulse.muted', '次要文字'],
  ['pulse.canvas', '画布'],
  ['pulse.shell', '面板'],
] as const;

function SceneEditor({
  module,
  modules,
  busy,
  save,
}: {
  module: Extract<ModuleRecord, { kind: 'program' }>;
  modules: ModuleRecord[];
  busy: boolean;
  save: (value: ModuleRecord) => Promise<boolean>;
}) {
  const [value, setValue] = useState(module.value);
  const [open, setOpen] = useState(false);
  const backgrounds = modules.flatMap((item) =>
    item.kind === 'program' && item.value.assets['pulse.background']
      ? [{ name: item.name, asset: item.value.assets['pulse.background'] }]
      : [],
  );
  const selected = backgrounds.findIndex(
    ({ asset }) => JSON.stringify(asset) === JSON.stringify(value.assets['pulse.background']),
  );
  const supported = pulseTokenStyle(value) !== null;
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>编辑场景</summary>
      <p>保存为草稿，不会改变当前播出。背景可选择已导入场景中的图片。</p>
      {sceneColors.map(([key, label]) => (
        <Field
          key={key}
          label={label}
          value={String(value.tokens[key] ?? '')}
          placeholder="#RRGGBB 或 #RRGGBBAA"
          onChange={(event) => {
            const tokens = { ...value.tokens };
            const color = event.target.value.trim();
            if (color) tokens[key] = color;
            else delete tokens[key];
            setValue({ ...value, tokens });
          }}
        />
      ))}
      <Select
        label="背景图片"
        value={selected < 0 ? '' : String(selected)}
        onChange={(event) => {
          const assets = { ...value.assets };
          const index = Number(event.target.value);
          if (event.target.value && backgrounds[index])
            assets['pulse.background'] = backgrounds[index].asset;
          else delete assets['pulse.background'];
          setValue({ ...value, assets });
        }}
      >
        <option value="">默认背景</option>
        {backgrounds.map((item, index) => (
          <option key={index} value={String(index)}>
            {item.name}
          </option>
        ))}
      </Select>
      {!supported && <p>颜色须使用 #RRGGBB 或 #RRGGBBAA；不支持的场景字段需先修复。</p>}
      <Button disabled={busy || !supported} onClick={() => void save({ ...module, value })}>
        保存草稿
      </Button>
    </details>
  );
}

function ModuleDraftEditor({
  module,
  modules,
  busy,
  save,
  cancel,
}: {
  module: ModuleRecord<'music'> | ModuleRecord<'camera'>;
  modules: ModuleRecord[];
  busy: boolean;
  save: (value: ModuleRecord, revision: string) => Promise<boolean>;
  cancel: () => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(module));
  const finish = async () => {
    if (await save(draft, draft.revision)) cancel();
  };
  return (
    <div>
      {draft.kind === 'music' ? (
        <MusicModuleEditor
          value={draft.value}
          busy={busy}
          onChange={(value) => setDraft({ ...draft, value })}
          onSave={() => void finish()}
        />
      ) : (
        <CameraModuleEditor
          value={draft.value}
          busy={busy}
          sources={[
            ...modules.flatMap((item) =>
              item.kind === 'camera' ? item.value.maps.map((map) => map.source) : [],
            ),
          ]}
          onChange={(value) => setDraft({ ...draft, value })}
          onSave={() => void finish()}
        />
      )}
      <Button disabled={busy} onClick={cancel}>
        取消编辑
      </Button>
    </div>
  );
}

function programUnsupported(entry: ModuleRecord): boolean {
  try {
    const parsed = parseModuleRecord(entry);
    return parsed.kind !== 'program' || pulseTokenStyle(parsed.value) === null;
  } catch {
    return true;
  }
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = [...name]
    .map((character) =>
      character.charCodeAt(0) < 32 || '/\\:*?"<>|'.includes(character) ? '_' : character,
    )
    .join('');
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
export function ResourceModules({
  query,
  category,
  onImported,
  sharedSnapshot,
  onRefresh,
}: {
  query: string;
  category: string;
  onImported: (presetId?: string) => void;
  sharedSnapshot?: Snapshot | null;
  onRefresh?: () => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const localSnapshot = useLocalRead<Snapshot>(
    sharedSnapshot === undefined ? '/local/v1/broadcast-presets' : null,
    2000,
    refresh,
  );
  const snapshot = sharedSnapshot === undefined ? localSnapshot : sharedSnapshot;
  const refreshAll = () => {
    setRefresh((value) => value + 1);
    onRefresh?.();
  };
  const metadata = useLocalRead<{
    modules: {
      id: string;
      revision: string;
      builtin: boolean;
      availability?: { state: 'ready' | 'dependency_missing'; reason?: string };
    }[];
  }>('/local/v1/broadcast-modules?view=metadata', 2000, refresh);
  const directory =
    snapshot && metadata
      ? {
          modules: snapshot.modules.flatMap((module) => {
            const item = metadata.modules.find(
              (entry) => entry.id === module.id && entry.revision === module.revision,
            );
            return item ? [{ module, builtin: item.builtin, availability: item.availability }] : [];
          }),
        }
      : null;
  const migration = useLocalRead<{ state: string; reason?: string }>(
    '/local/v1/broadcast-config/migration',
    2000,
    refresh,
  );
  const pendingCamera = useLocalRead<{
    pending: {
      catalog: { presets: { id: string; preset: { name: string } }[] };
      automaticEnabled: boolean;
    } | null;
  }>('/local/v1/broadcast-config/pending-camera', 2000, refresh);
  const [selected, setSelected] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('resource'),
  );
  const [replacement, setReplacement] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    tone: 'success' | 'danger' | 'warning';
    message: string;
  } | null>(null);
  const [inspection, setInspection] = useState<PackInspection | null>(null);
  const [inspectionOpen, setInspectionOpen] = useState(false);
  const [importResults, setImportResults] = useState<ImportResult[] | null>(null);
  const [importTargets, setImportTargets] = useState<
    Record<string, { type: 'module' | 'preset'; id: string }>
  >({});
  const [selectedEntries, setSelectedEntries] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const scrollToSelection = useRef(false);
  const selectionEpoch = useRef(0);
  const showList = category === 'all' || ['hud', 'program', 'music', 'camera'].includes(category);
  const entries =
    directory?.modules.filter(
      ({ module }) =>
        (category === 'all' || category === module.kind) &&
        module.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    ) ?? [];
  useEffect(() => {
    if (!scrollToSelection.current || !selected || !showList) return;
    const target = document.getElementById(`resource-${selected}`);
    if (target) {
      scrollToSelection.current = false;
      target.scrollIntoView?.({ block: 'nearest' });
    }
  }, [selected, showList, directory]);
  const item = directory?.modules.find(({ module }) => module.id === selected);
  const module = item?.module;
  const referencesReady = !!module && !!snapshot;
  const references =
    module && snapshot
      ? snapshot.presets.filter((preset) =>
          preset.bindings.some(
            (binding) => binding.mode === 'use' && binding.moduleId === module.id,
          ),
        )
      : [];
  const referenceView = {
    active:
      !!module &&
      !!snapshot &&
      (Object.values(snapshot.active.sourceModuleIds ?? {}).includes(module.id) ||
        (snapshot.active.sourceModuleIds?.[module.kind] === undefined &&
          references.some((preset) => preset.id === snapshot.active.sourcePreset?.id))),
  };
  async function perform(path: string, body: unknown, message: string, filename?: string) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        if (path === '/operator/resource-library/export-pack')
          throw new Error(
            await exportFailure(response, snapshot?.modules ?? [], snapshot?.presets ?? []),
          );
        const result = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(
          result.error?.message ??
            (response.status === 409
              ? '配置已变化，请刷新后重试。'
              : '操作未完成，请检查资源后重试。'),
        );
      }
      if (filename) download(await response.blob(), filename);
      setNotice({ tone: 'success', message });
      refreshAll();
      return true;
    } catch (error) {
      setNotice({
        tone: 'danger',
        message: error instanceof Error ? error.message : '操作未完成。',
      });
      refreshAll();
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function handlePendingCamera(action: 'restore' | 'delete') {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/operator/broadcast-config/pending-camera/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? '保留的运镜配置已变化，请刷新后重试。'
            : action === 'restore'
              ? '暂时无法恢复。请先准备原配置所需的 MulNX 镜头内容，再重试；原配置仍会保留。'
              : '暂时无法删除保留的运镜配置，请检查本地制播服务后重试。',
        );
      if (action === 'restore') {
        const result = (await response.json()) as { restored: { moduleId: string }[] };
        if (result.restored[0]) {
          setSelected(result.restored[0].moduleId);
          onImported();
        }
      }
      setNotice({
        tone: 'success',
        message:
          action === 'restore' ? '运镜配置已恢复为草稿，尚未使用。' : '保留的运镜配置已删除。',
      });
    } catch (error) {
      setNotice({
        tone: 'danger',
        message: error instanceof Error ? error.message : '操作未完成，请重试。',
      });
    } finally {
      setBusy(false);
      refreshAll();
    }
  }
  function navigateImportTarget(target: { type: 'module' | 'preset'; id: string }) {
    selectionEpoch.current++;
    if (target.type === 'preset') {
      setSelected(null);
      onImported(target.id);
    } else {
      scrollToSelection.current = true;
      setSelected(target.id);
      onImported();
    }
  }
  async function inspectFile(file: File) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/operator/resource-library/check-pack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-mizarpack' },
        body: file,
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? '同一版本的内容不同，请检查文件。'
            : '无法检查资源包，请检查文件后重试。',
        );
      const result = (await response.json()) as Omit<PackInspection, 'file'>;
      setInspection({ ...result, file });
      setImportResults(null);
      setImportTargets({});
      setSelectedEntries(
        result.entries
          .filter((entry) => ['ready', 'existing', 'dependency_missing'].includes(entry.status))
          .map(entryKey),
      );
      setInspectionOpen(true);
    } catch (error) {
      setNotice({
        tone: 'danger',
        message: error instanceof Error ? error.message : '无法检查资源包。',
      });
    } finally {
      setBusy(false);
    }
  }
  async function importFile() {
    if (!inspection || busy || !selectedEntries.length) return;
    const selection = {
      modules: inspection.entries
        .filter((entry) => entry.type === 'module' && selectedEntries.includes(entryKey(entry)))
        .map((entry) => entry.entryId),
      presets: inspection.entries
        .filter((entry) => entry.type === 'preset' && selectedEntries.includes(entryKey(entry)))
        .map((entry) => entry.entryId),
    };

    const startingEpoch = selectionEpoch.current;
    setBusy(true);
    setNotice(null);
    try {
      const query = new URLSearchParams({
        selection: JSON.stringify(selection),
        digest: inspection.source.digest,
      });
      const response = await fetch(`/operator/resource-library/import-pack?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-mizarpack' },
        body: inspection.file,
      });
      if (!response.ok)
        throw new Error(
          response.status === 409 ? '同一版本的内容不同，请检查文件。' : '导入失败，请检查资源包。',
        );
      const result = (await response.json()) as {
        mapping: {
          moduleEntries: Record<string, string[]>;
          presetEntries?: Record<string, string>;
          moduleOwners?: Record<string, string | null>;
        };
        reused: boolean;
        entries: ImportResult[];
      };
      const accepted = result.entries.filter(
        (entry) => entry.result === 'imported' || entry.result === 'existing',
      );
      const failed = selectedEntries.some((key) => {
        const outcome = result.entries.find((entry) => entryKey(entry) === key);
        return !outcome || outcome.result === 'unavailable' || outcome.result === 'not_selected';
      });
      const targets: Record<string, { type: 'module' | 'preset'; id: string }> = {};
      for (const entry of inspection.entries) {
        const key = entryKey(entry);
        const outcome = result.entries.find((item) => entryKey(item) === key);
        if (
          !selectedEntries.includes(key) ||
          !outcome ||
          !['imported', 'existing'].includes(outcome.result)
        )
          continue;
        if (outcome.targetId) targets[key] = { type: entry.type, id: outcome.targetId };
      }
      setImportTargets(targets);
      if (selectedEntries.length === 1 && selectionEpoch.current === startingEpoch) {
        const target = targets[selectedEntries[0]!];
        if (target) navigateImportTarget(target);
      }
      setImportResults(result.entries);
      setNotice({
        tone: failed ? (accepted.length ? 'warning' : 'danger') : 'success',
        message: failed
          ? accepted.length
            ? '部分所选内容已保存，其他内容未导入；请查看逐项结果。'
            : '没有内容导入；请查看逐项结果。'
          : '所选内容已保存，尚未使用。',
      });
      setInspectionOpen(false);
      refreshAll();
    } catch (error) {
      setNotice({ tone: 'danger', message: error instanceof Error ? error.message : '导入失败。' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="resource-library__music" aria-label="资源">
      <div className="resource-library__music-heading">
        <div>
          <h2>资源</h2>
          <p>查看已保存的资源；使用后才会改变播出配置。</p>
        </div>
        <input
          ref={input}
          hidden
          type="file"
          accept=".mizarpack"
          disabled={busy}
          aria-label="选择资源包"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void inspectFile(file);
          }}
        />
        <Button disabled={busy} onClick={() => input.current?.click()}>
          导入资源
        </Button>
      </div>
      {notice && <StatusBanner tone={notice.tone}>{notice.message}</StatusBanner>}
      {inspection && importResults && (
        <Panel className="resource-library__import-results" aria-label="导入结果">
          <h3>导入结果</h3>
          <ul>
            {inspection.entries.map((entry, index) => {
              const kind =
                entry.type === 'preset' ? '方案' : (entry.kind && labels[entry.kind]) || '资源';
              const returned = importResults.find(
                (item) => item.type === entry.type && item.entryId === entry.entryId,
              );
              return (
                <li key={entryKey(entry)}>
                  {entryName(entry, index)} · {kind}：{resultDescription(entry, returned)}
                  {importTargets[entryKey(entry)] && (
                    <Button onClick={() => navigateImportTarget(importTargets[entryKey(entry)]!)}>
                      查看{entryName(entry, index)}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
      {inspection && !inspectionOpen && (
        <Button disabled={busy} onClick={() => setInspectionOpen(true)}>
          继续选择资源
        </Button>
      )}
      {inspection && inspectionOpen && (
        <Panel className="resource-library__import" aria-label="选择导入内容">
          <h3>选择导入内容</h3>
          <p>{inspection.name} · 选择要保存的内容，方案会带入所需资源。导入不会切换播出。</p>
          {inspection.entries.map((entry, index) => {
            const kind =
              entry.type === 'preset' ? '方案' : (entry.kind && labels[entry.kind]) || '资源';
            const name = entryName(entry, index);
            const key = entryKey(entry);
            const disabled = entry.status === 'unsupported' || entry.status === 'invalid';
            return (
              <Checkbox
                key={key}
                label={`${name} · ${kind}`}
                message={entryStatus[entry.status]}
                checked={selectedEntries.includes(key)}
                disabled={busy || disabled}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setSelectedEntries((previous) =>
                    checked ? [...previous, key] : previous.filter((item) => item !== key),
                  );
                }}
              />
            );
          })}
          <div className="resource-library__actions">
            <Button disabled={busy || !selectedEntries.length} onClick={() => void importFile()}>
              导入所选
            </Button>
            <Button disabled={busy} onClick={() => setInspectionOpen(false)}>
              稍后继续
            </Button>
          </div>
        </Panel>
      )}

      {(!snapshot || !directory) && (
        <StatusBanner tone="warning">资源目录暂不可用，请检查本地制播服务。</StatusBanner>
      )}
      {migration?.state === 'pending' && migration.reason === 'program_dependency_unavailable' && (
        <StatusBanner tone="danger">
          <p>
            当前播出场景的背景不可用。请恢复图片后重新使用该场景，或使用其他场景；HUD 可继续使用。
          </p>
          <Button
            onClick={() => {
              selectionEpoch.current++;
              scrollToSelection.current = true;
              setSelected(snapshot?.active.sourceModuleIds?.program ?? null);
              onImported();
            }}
          >
            检查场景资源
          </Button>
        </StatusBanner>
      )}
      {(category === 'all' || category === 'camera') && pendingCamera?.pending && (
        <Panel className="resource-library__item">
          <div>
            <span className="resource-library__kind">运镜 · 待恢复</span>
            <h3>原运镜配置已保留</h3>
            <p>准备原配置所需的 MulNX 镜头内容后，可恢复为草稿。恢复不会切换当前播出。</p>
            {pendingCamera.pending.catalog.presets.length > 0 && (
              <p>
                包含：
                {pendingCamera.pending.catalog.presets.map((entry) => entry.preset.name).join('、')}
              </p>
            )}
          </div>
          <Button disabled={busy} onClick={() => void handlePendingCamera('restore')}>
            恢复运镜配置
          </Button>
          <details>
            <summary>删除保留的配置</summary>
            <p>删除后将无法从此保留记录恢复。</p>
            <Button disabled={busy} onClick={() => void handlePendingCamera('delete')}>
              确认删除保留配置
            </Button>
          </details>
        </Panel>
      )}
      {showList &&
        snapshot &&
        directory &&
        !entries.length &&
        !((category === 'all' || category === 'camera') && pendingCamera?.pending) && (
          <p>没有找到匹配的资源，可导入资源包。</p>
        )}
      {showList &&
        entries.map(({ module: entry, builtin, availability }) => (
          <Panel className="resource-library__item" key={entry.id} id={`resource-${entry.id}`}>
            <div>
              <span className="resource-library__kind">
                {labels[entry.kind]} · {builtin ? '内置' : entry.origin ? '导入' : '自建'}
              </span>
              <h3>{entry.name}</h3>
              <p>
                {snapshot?.active.sourceModuleIds?.[entry.kind] === entry.id
                  ? snapshot.active.sourceModuleRevisions?.[entry.kind] === entry.revision
                    ? '当前使用'
                    : '已修改，尚未使用'
                  : '尚未使用'}
              </p>
            </div>
            <Button
              onClick={() => {
                selectionEpoch.current++;
                setSelected(selected === entry.id ? null : entry.id);
                setReplacement('');
              }}
            >
              {selected === entry.id ? '关闭详情' : '查看详情'}
            </Button>
            {selected === entry.id && (
              <div>
                {availability?.state === 'dependency_missing' && (
                  <StatusBanner tone="warning">
                    {entry.kind === 'camera'
                      ? '运镜来源不可用，请准备对应的 MulNX 镜头内容后重试。'
                      : '所需资源不可用，请重新导入或恢复资源后重试。'}
                  </StatusBanner>
                )}
                {(entry.kind === 'hud' || entry.kind === 'program') && (
                  <PresetVisualPreview
                    key={entry.id}
                    mode={entry.kind}
                    bindings={[{ kind: entry.kind, mode: 'use', moduleId: entry.id }]}
                    modules={[entry]}
                  />
                )}
                {entry.kind === 'music' && (
                  <dl>
                    {Object.entries(entry.value.groups).map(([name, group]) => (
                      <div key={name}>
                        <dt>{name}</dt>
                        <dd>{group.tracks.map((track) => track.name).join('、') || '无曲目'}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {entry.kind === 'camera' && (
                  <dl>
                    {entry.value.maps.map((map, index) => (
                      <div key={index}>
                        <dt>{map.map}</dt>
                        <dd>
                          {map.source.sourceName} · {map.openingSound?.name ?? '无开场音效'}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                {entry.kind === 'program' && !builtin && (
                  <SceneEditor
                    key={`${entry.id}:${entry.revision}`}
                    module={entry}
                    modules={snapshot?.modules ?? []}
                    busy={busy}
                    save={(value) =>
                      perform(
                        '/operator/broadcast-modules/save',
                        { value, expectedRevision: entry.revision },
                        '场景已保存，尚未使用。',
                      )
                    }
                  />
                )}
                {!builtin &&
                  (entry.kind === 'music' || entry.kind === 'camera') &&
                  (editing === entry.id ? (
                    <ModuleDraftEditor
                      key={entry.id}
                      module={entry}
                      modules={snapshot?.modules ?? []}
                      busy={busy}
                      cancel={() => setEditing(null)}
                      save={(value, expectedRevision) =>
                        perform(
                          '/operator/broadcast-modules/save',
                          { value, expectedRevision },
                          '资源已保存，尚未使用。',
                        )
                      }
                    />
                  ) : (
                    <Button disabled={busy} onClick={() => setEditing(entry.id)}>
                      编辑{labels[entry.kind]}
                    </Button>
                  ))}
                <div className="resource-library__preset-actions">
                  <Button
                    disabled={
                      busy || !snapshot || (entry.kind === 'program' && programUnsupported(entry))
                    }
                    onClick={() =>
                      snapshot &&
                      void perform(
                        '/operator/broadcast-modules/apply',
                        {
                          moduleId: entry.id,
                          expectedRevision: entry.revision,
                          expectedActiveRevision: snapshot.active.revision,
                          requestId: crypto.randomUUID(),
                        },
                        `已使用「${entry.name}」。`,
                      )
                    }
                  >
                    使用
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void perform(
                        '/operator/broadcast-modules/clone',
                        {
                          moduleId: entry.id,
                          expectedRevision: entry.revision,
                          name: `${entry.name.slice(0, 117)} 副本`,
                        },
                        '已复制，尚未使用。',
                      )
                    }
                  >
                    复制
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void perform(
                        '/operator/resource-library/export-pack',
                        {
                          modules: [{ moduleId: entry.id, expectedRevision: entry.revision }],
                          presets: [],
                        },
                        '资源包已生成。',
                        `${entry.name}.mizarpack`,
                      )
                    }
                  >
                    导出
                  </Button>
                  {entry.kind === 'hud' && !builtin && 'preset' in entry.value && (
                    <a href={`/operator/hud?preset=${encodeURIComponent(entry.value.preset.id)}`}>
                      编辑 HUD
                    </a>
                  )}
                  {entry.kind === 'hud' && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void perform(
                          '/operator/hud-config/export-lhm',
                          { moduleId: entry.id, moduleRevision: entry.revision },
                          'LHM 文件已生成。',
                          `${entry.name}.zip`,
                        )
                      }
                    >
                      导出为 LHM
                    </Button>
                  )}
                </div>
                {!builtin && (
                  <details>
                    <summary>删除资源</summary>
                    {!referencesReady ? (
                      <p>正在检查方案引用，请等待；若持续不可用，请检查本地制播服务。</p>
                    ) : referenceView.active ? (
                      <p>请先使用同类替代资源，再删除此资源。</p>
                    ) : (
                      <>
                        <p>
                          {references.length
                            ? `以下方案引用此资源：${references.map((preset) => preset.name).join('、')}。请选择替代资源。`
                            : '删除后可重新导入。'}
                        </p>
                        {references.length > 0 && (
                          <Select
                            label="替代资源"
                            value={replacement}
                            onChange={(event) => setReplacement(event.currentTarget.value)}
                          >
                            <option value="">请选择</option>
                            {(entry.kind === 'music' || entry.kind === 'camera') && (
                              <option value="off">关闭</option>
                            )}
                            {directory?.modules
                              .filter(
                                (other) =>
                                  other.module.kind === entry.kind && other.module.id !== entry.id,
                              )
                              .map((other) => (
                                <option key={other.module.id} value={other.module.id}>
                                  {other.module.name}
                                </option>
                              ))}
                          </Select>
                        )}
                        <Button
                          disabled={busy || (references.length > 0 && !replacement)}
                          onClick={() =>
                            void perform(
                              '/operator/broadcast-modules/delete',
                              {
                                moduleId: entry.id,
                                expectedRevision: entry.revision,
                                ...(references.length
                                  ? {
                                      replacement: {
                                        moduleId: replacement === 'off' ? null : replacement,
                                        expectedPresetRevisions: Object.fromEntries(
                                          references.map((preset) => [preset.id, preset.revision]),
                                        ),
                                      },
                                    }
                                  : {}),
                              },
                              '资源已删除。',
                            ).then((ok) => {
                              if (ok) setSelected(null);
                            })
                          }
                        >
                          确认删除
                        </Button>
                      </>
                    )}
                  </details>
                )}
              </div>
            )}
          </Panel>
        ))}
    </section>
  );
}
