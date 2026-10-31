import { PresetVisualPreview } from './PresetVisualPreview';
import { exportFailure } from './export-error';
import { useEffect, useRef, useState } from 'react';
import { useLocalRead } from '../preparation/client';
import { Button, Checkbox, Field, Panel, Select, StatusBanner } from '../ui';

type Kind = 'hud' | 'program' | 'music' | 'camera';
type Module = { id: string; kind: Kind; name: string; revision: string; value?: unknown };
type Binding = { kind: Kind; mode: 'off' } | { kind: Kind; mode: 'use'; moduleId: string };
type Preset = { id: string; name: string; revision: string; bindings: Binding[] };
type View = {
  modules: Module[];
  presets: Preset[];
  active: {
    revision: string;
    sourcePreset: { id: string; revision: string } | null;
    sourceModuleIds?: Partial<Record<Kind, string | null>>;
    sourceModuleRevisions?: Partial<Record<Kind, string | null>>;
    adjusted: boolean;
  };
};
const labels: Record<Kind, string> = {
  hud: 'HUD',
  program: '节目画面',
  music: '音乐',
  camera: '运镜',
};

function BindingEditor({
  preset,
  modules,
  busy,
  save,
}: {
  preset: Preset;
  modules: Module[];
  busy: boolean;
  save: (preset: Preset, bindings: Binding[]) => void;
}) {
  const initial = Object.fromEntries(
    preset.bindings.map((binding) => [
      binding.kind,
      binding.mode === 'use' ? binding.moduleId : '',
    ]),
  ) as Record<Kind, string>;
  const [selection, setSelection] = useState(initial);
  const kinds: Kind[] = ['hud', 'program', 'music', 'camera'];
  const changed = kinds.some((kind) => selection[kind] !== initial[kind]);
  return (
    <div className="resource-library__preset-music">
      {kinds.map((kind) => (
        <Select
          key={kind}
          label={labels[kind]}
          value={selection[kind] ?? ''}
          disabled={busy}
          onChange={(event) => {
            const selected = event.currentTarget.value;
            setSelection((value) => ({ ...value, [kind]: selected }));
          }}
        >
          {kind === 'music' || kind === 'camera' ? <option value="">关闭</option> : null}
          {modules
            .filter((module) => module.kind === kind)
            .map((module) => (
              <option key={module.id} value={module.id}>
                {module.name}
              </option>
            ))}
        </Select>
      ))}
      <Button
        disabled={busy || !changed || !selection.hud || !selection.program}
        onClick={() =>
          save(
            preset,
            kinds.map((kind): Binding =>
              selection[kind]
                ? { kind, mode: 'use', moduleId: selection[kind] }
                : { kind, mode: 'off' },
            ),
          )
        }
      >
        保存方案
      </Button>
    </div>
  );
}

function CreatePreset({
  modules,
  busy,
  create,
}: {
  modules: Module[];
  busy: boolean;
  create: (name: string, bindings: Binding[]) => void;
}) {
  const [name, setName] = useState('');
  const [selection, setSelection] = useState<Record<Kind, string>>({
    hud: '',
    program: '',
    music: '',
    camera: '',
  });
  const kinds: Kind[] = ['hud', 'program', 'music', 'camera'];
  return (
    <details>
      <summary>创建方案</summary>
      <p>选择资源并保存，使用方案时才切换播出。</p>
      <Field
        label="方案名称"
        value={name}
        maxLength={120}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      {kinds.map((kind) => (
        <Select
          key={kind}
          label={labels[kind]}
          value={selection[kind]}
          onChange={(event) => {
            const selected = event.currentTarget.value;
            setSelection((value) => ({ ...value, [kind]: selected }));
          }}
        >
          <option value="">{kind === 'hud' || kind === 'program' ? '请选择' : '关闭'}</option>
          {modules
            .filter((module) => module.kind === kind)
            .map((module) => (
              <option key={module.id} value={module.id}>
                {module.name}
              </option>
            ))}
        </Select>
      ))}
      <Button
        disabled={busy || !name.trim() || !selection.hud || !selection.program}
        onClick={() =>
          create(
            name.trim(),
            kinds.map((kind): Binding =>
              selection[kind]
                ? { kind, mode: 'use', moduleId: selection[kind] }
                : { kind, mode: 'off' },
            ),
          )
        }
      >
        保存新方案
      </Button>
    </details>
  );
}

export function BroadcastPresets({
  query,
  focusPreset,
  sharedSnapshot,
  onRefresh,
}: {
  query: string;
  focusPreset?: { id: string; request: number } | null;
  sharedSnapshot?: View | null;
  onRefresh?: () => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const localView = useLocalRead<View>(
    sharedSnapshot === undefined ? '/local/v1/broadcast-presets' : null,
    2000,
    refresh,
  );
  const view = sharedSnapshot === undefined ? localView : sharedSnapshot;
  const refreshAll = () => {
    setRefresh((value) => value + 1);
    onRefresh?.();
  };
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState<{ id: string; name: string; kind: Kind }[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<{
    tone: 'success' | 'danger' | 'warning';
    message: string;
  } | null>(null);
  const focusedPreset = useRef<string | null>(null);
  useEffect(() => {
    if (!focusPreset) {
      focusedPreset.current = null;
      return;
    }
    const token = `${focusPreset.id}:${focusPreset.request}`;
    if (
      focusedPreset.current === token ||
      !view?.presets.some((preset) => preset.id === focusPreset.id)
    )
      return;
    focusedPreset.current = token;
    setExpanded((previous) => new Set(previous).add(focusPreset.id));
    document.getElementById(`preset-${focusPreset.id}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [focusPreset, view]);
  async function createPreset(name: string, bindings: Binding[]) {
    if (!view || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const id = crypto.randomUUID();
      const response = await fetch('/operator/broadcast-presets/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preset: {
            schemaVersion: 1,
            id,
            revision: crypto.randomUUID(),
            name,
            origin: null,
            bindings,
            opaqueModules: [],
          },
          expectedPresetRevision: null,
          modules: [],
        }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 409 ? '配置已变化，请刷新后重试。' : '方案未保存，请检查选择后重试。',
        );
      setExpanded((previous) => new Set(previous).add(id));
      setNotice({ tone: 'success', message: `已保存「${name}」，尚未使用。` });
    } catch (error) {
      setNotice({
        tone: 'danger',
        message: error instanceof Error ? error.message : '方案未保存，请重试。',
      });
    } finally {
      setBusy(false);
      refreshAll();
    }
  }
  async function saveBindings(preset: Preset, bindings: Binding[]) {
    if (!view || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/operator/broadcast-presets/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preset: { ...preset, bindings },
          expectedPresetRevision: preset.revision,
          modules: [],
        }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 409 ? '方案已变化，请刷新后重试。' : '方案未保存，请检查配置后重试。',
        );
      setNotice({ tone: 'success', message: '方案已保存，使用方案后生效。' });
      refreshAll();
    } catch (error) {
      setNotice({
        tone: 'danger',
        message: error instanceof Error ? error.message : '方案未保存，请重试。',
      });
    } finally {
      setBusy(false);
    }
  }
  function moduleRevisions(preset: Preset): Partial<Record<Kind, string>> | null {
    if (!view) return null;
    const revisions: Partial<Record<Kind, string>> = {};
    for (const binding of preset.bindings)
      if (binding.mode === 'use') {
        const module = view.modules.find(
          (item) => item.id === binding.moduleId && item.kind === binding.kind,
        );
        if (!module) {
          setNotice({
            tone: 'danger',
            message: `方案缺少${labels[binding.kind]}，请在方案配置中选择可用资源。`,
          });
          return null;
        }
        revisions[binding.kind] = module.revision;
      }
    return revisions;
  }
  async function exportFile(preset: Preset) {
    if (!view || busy) return;
    const revisions = moduleRevisions(preset);
    if (!revisions) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/operator/resource-library/export-pack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modules: [],
          presets: [
            {
              presetId: preset.id,
              expectedRevision: preset.revision,
              expectedModuleRevisions: revisions,
            },
          ],
        }),
      });
      if (!response.ok) throw new Error(await exportFailure(response, view.modules, view.presets));
      const url = URL.createObjectURL(await response.blob());
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = `${[...preset.name.trim()].map((c) => (c.charCodeAt(0) < 32 || '/\\:*?"<>|'.includes(c) ? '_' : c)).join('') || '播出方案'}.mizarpack`;
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (error) {
      setNotice({
        tone: 'danger',
        message: error instanceof Error ? error.message : '分享失败，请重试。',
      });
    } finally {
      setBusy(false);
    }
  }
  async function exportSelected() {
    if (!view || busy || !selected.length) return;
    const chosen = selected.map((id) => view.presets.find((preset) => preset.id === id));
    if (chosen.some((preset) => !preset)) {
      setNotice({ tone: 'danger', message: '方案已变化，请刷新后重新选择。' });
      return;
    }
    const requests = [];
    for (const preset of chosen) {
      if (!preset) return;
      const revisions = moduleRevisions(preset);
      if (!revisions) return;
      requests.push({
        presetId: preset.id,
        expectedRevision: preset.revision,
        expectedModuleRevisions: revisions,
      });
    }
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/operator/resource-library/export-pack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modules: [], presets: requests }),
      });
      if (!response.ok) throw new Error(await exportFailure(response, view.modules, view.presets));
      const url = URL.createObjectURL(await response.blob());
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = '播出方案.mizarpack';
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (error) {
      setNotice({
        tone: 'danger',
        message: error instanceof Error ? error.message : '分享失败，请重试。',
      });
    } finally {
      setBusy(false);
    }
  }
  async function clonePreset(preset: Preset) {
    if (!view || busy) return;
    const revisions = moduleRevisions(preset);
    if (!revisions) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/operator/broadcast-presets/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceId: preset.id,
          expectedRevision: preset.revision,
          expectedModuleRevisions: revisions,
          name: `${preset.name.slice(0, 117)} 副本`,
        }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 409 ? '配置已变化，请刷新后重试。' : '复制失败，请重试。',
        );
      setNotice({ tone: 'success', message: `已复制「${preset.name}」，可编辑后使用。` });
      refreshAll();
    } catch (error) {
      setNotice({
        tone: 'danger',
        message: error instanceof Error ? error.message : '复制失败，请重试。',
      });
    } finally {
      setBusy(false);
    }
  }
  async function deletePreset(preset: Preset) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/operator/broadcast-presets/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presetId: preset.id, expectedRevision: preset.revision }),
      });
      if (!response.ok) throw new Error('方案正在使用或已变化，请刷新后重试。');
      setNotice({ tone: 'success', message: '方案已删除，资源保留。' });
    } catch (error) {
      setNotice({ tone: 'danger', message: error instanceof Error ? error.message : '删除失败。' });
    } finally {
      setBusy(false);
      refreshAll();
    }
  }
  async function applyPreset(preset: Preset) {
    if (!view || busy) return;
    const revisions = moduleRevisions(preset);
    if (!revisions) return;
    setBusy(true);
    setNotice(null);
    setMissing([]);
    try {
      const response = await fetch('/operator/broadcast-presets/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          presetId: preset.id,
          expectedRevision: preset.revision,
          expectedModuleRevisions: revisions,
          expectedActiveRevision: view.active.revision,
          requestId: crypto.randomUUID(),
        }),
      });
      if (!response.ok) {
        if (response.status !== 409) {
          const directoryResponse = await fetch('/local/v1/broadcast-modules', {
            cache: 'no-store',
          });
          if (directoryResponse.ok) {
            const directory = (await directoryResponse.json()) as {
              modules: { module: Module; availability?: { state: string } }[];
            };
            setMissing(
              preset.bindings.flatMap((binding) => {
                if (binding.mode !== 'use') return [];
                const entry = directory.modules.find(
                  (item) =>
                    item.module.id === binding.moduleId &&
                    item.module.revision === revisions[binding.kind],
                );
                return entry?.availability?.state === 'dependency_missing'
                  ? [{ id: entry.module.id, name: entry.module.name, kind: binding.kind }]
                  : [];
              }),
            );
          }
        }
        throw new Error(
          response.status === 409
            ? '配置已变化或当前无法切换，请刷新后重试。'
            : '部分配置可能已应用。请检查各模块状态和资源后重试。',
        );
      }
      const result = (await response.json()) as { failedModules?: Kind[] };
      if (result.failedModules?.length) {
        setNotice({
          tone: 'warning',
          message: `「${preset.name}」已部分应用；${result.failedModules.map((kind) => labels[kind] ?? kind).join('、')}保留原配置，请检查资源后重试。`,
        });
      } else setNotice({ tone: 'success', message: `已使用「${preset.name}」。` });
    } catch (error) {
      setNotice({
        tone: 'danger',
        message: error instanceof Error ? error.message : '方案暂时无法使用，请重试。',
      });
    } finally {
      setBusy(false);
      refreshAll();
    }
  }
  const presets = (view?.presets ?? []).filter((item) =>
    item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <section className="resource-library__music" aria-label="播出方案">
      <div className="resource-library__music-heading">
        <div>
          <h2>播出方案</h2>
          <p>查看配置，并在准备阶段使用方案。</p>
        </div>
        <div className="resource-library__preset-actions">
          <Button
            disabled={!view || busy}
            onClick={() => {
              setSelecting((value) => !value);
              setSelected([]);
            }}
          >
            {selecting ? '取消选择' : '选择多个方案'}
          </Button>
          {selecting ? (
            <Button disabled={busy || !selected.length} onClick={() => void exportSelected()}>
              分享所选（{selected.length}）
            </Button>
          ) : null}
        </div>
      </div>
      {view && (
        <CreatePreset
          modules={view.modules}
          busy={busy}
          create={(name, bindings) => void createPreset(name, bindings)}
        />
      )}
      {notice ? <StatusBanner tone={notice.tone}>{notice.message}</StatusBanner> : null}
      {missing.length > 0 && (
        <ul>
          {missing.map((item) => (
            <li key={item.id}>
              {labels[item.kind]}：
              <a href={`/packages?resource=${encodeURIComponent(item.id)}`}>{item.name}</a>{' '}
              所需资源不可用
            </li>
          ))}
        </ul>
      )}
      {!view ? (
        <StatusBanner tone="warning">播出方案暂不可用，请检查本地制播服务。</StatusBanner>
      ) : null}
      {view && presets.length === 0 ? <p>没有找到匹配的播出方案。</p> : null}
      {presets.map((preset) => {
        const active = view?.active;
        const current = active?.sourcePreset?.id === preset.id;
        const known = active?.sourceModuleIds && active.sourceModuleRevisions;
        const changed =
          current &&
          known &&
          (active.sourcePreset!.revision !== preset.revision ||
            preset.bindings.some((binding) => {
              const id = binding.mode === 'use' ? binding.moduleId : null;
              const revision =
                binding.mode === 'use'
                  ? view?.modules.find((item) => item.id === id && item.kind === binding.kind)
                      ?.revision
                  : null;
              return (
                active.sourceModuleIds?.[binding.kind] !== id ||
                active.sourceModuleRevisions?.[binding.kind] !== revision
              );
            }));
        return (
          <Panel
            className="resource-library__item resource-library__preset"
            key={preset.id}
            id={`preset-${preset.id}`}
          >
            <div>
              {selecting ? (
                <Checkbox
                  label={`选择 ${preset.name}`}
                  disabled={busy || (!selected.includes(preset.id) && selected.length >= 32)}
                  checked={selected.includes(preset.id)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setSelected((items) =>
                      checked ? [...items, preset.id] : items.filter((id) => id !== preset.id),
                    );
                  }}
                />
              ) : null}
              <span className="resource-library__kind">播出方案</span>
              <h2>{preset.name}</h2>
              <p>
                {!current
                  ? '已保存'
                  : !known
                    ? '状态待确认'
                    : changed
                      ? '已修改，尚未使用'
                      : active.adjusted
                        ? '当前方案，已调整'
                        : '当前使用'}
              </p>
            </div>
            <details
              open={expanded.has(preset.id)}
              onToggle={(event) => {
                const open = event.currentTarget.open;
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (open) next.add(preset.id);
                  else next.delete(preset.id);
                  return next;
                });
              }}
            >
              <summary>查看配置</summary>
              <dl>
                {preset.bindings.map((binding) => (
                  <div key={binding.kind}>
                    <dt>{labels[binding.kind]}</dt>
                    <dd>
                      {binding.mode === 'off'
                        ? '关闭'
                        : (view?.modules.find(
                            (item) => item.id === binding.moduleId && item.kind === binding.kind,
                          )?.name ?? '配置不可用')}
                    </dd>
                  </div>
                ))}
              </dl>
              {view && expanded.has(preset.id) ? (
                <PresetVisualPreview bindings={preset.bindings} modules={view.modules} />
              ) : null}
              {view ? (
                <BindingEditor
                  key={`${preset.id}:${preset.revision}`}
                  preset={preset}
                  modules={view.modules}
                  busy={busy}
                  save={(item, bindings) => void saveBindings(item, bindings)}
                />
              ) : null}
            </details>
            <div className="resource-library__preset-actions">
              <details>
                <summary>删除方案</summary>
                <p>删除方案不会删除关联资源。</p>
                <Button disabled={busy || current} onClick={() => void deletePreset(preset)}>
                  确认删除
                </Button>
                {current && <p>请先使用其他方案。</p>}
              </details>
              <Button disabled={busy} onClick={() => void clonePreset(preset)}>
                复制
              </Button>
              <Button disabled={busy} onClick={() => void exportFile(preset)}>
                分享
              </Button>
              <Button disabled={busy} onClick={() => void applyPreset(preset)}>
                使用方案
              </Button>
            </div>
          </Panel>
        );
      })}
    </section>
  );
}
