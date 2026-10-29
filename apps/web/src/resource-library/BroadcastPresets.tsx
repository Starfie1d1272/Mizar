import { useRef, useState } from 'react';
import { useLocalRead } from '../preparation/client';
import { Button, Panel, Select, StatusBanner } from '../ui';

type Kind = 'hud' | 'program' | 'music' | 'camera';
type Module = { id: string; kind: Kind; name: string; revision: string };
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

function MusicBindingEditor({
  preset,
  modules,
  busy,
  save,
}: {
  preset: Preset;
  modules: Module[];
  busy: boolean;
  save: (preset: Preset, moduleId: string) => void;
}) {
  const binding = preset.bindings.find((item) => item.kind === 'music');
  const initial = binding?.mode === 'use' ? binding.moduleId : '';
  const [selection, setSelection] = useState(initial);
  return (
    <div className="resource-library__preset-music">
      <Select
        label="音乐配置"
        value={selection}
        disabled={busy}
        onChange={(event) => setSelection(event.currentTarget.value)}
      >
        <option value="">关闭音乐</option>
        {modules
          .filter((module) => module.kind === 'music')
          .map((module) => (
            <option key={module.id} value={module.id}>
              {module.name}
            </option>
          ))}
      </Select>
      <Button disabled={busy || selection === initial} onClick={() => save(preset, selection)}>
        保存音乐选择
      </Button>
    </div>
  );
}

export function BroadcastPresets({ query }: { query: string }) {
  const [refresh, setRefresh] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const view = useLocalRead<View>('/local/v1/broadcast-presets', 2000, refresh);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; message: string } | null>(
    null,
  );
  async function saveMusic(preset: Preset, moduleId: string) {
    if (!view || busy) return;
    const bindings = preset.bindings.map((binding) =>
      binding.kind !== 'music'
        ? binding
        : moduleId
          ? { kind: 'music', mode: 'use', moduleId }
          : { kind: 'music', mode: 'off' },
    );
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
          response.status === 409
            ? '方案已变化，请刷新后重试。'
            : '音乐选择未保存，请检查方案后重试。',
        );
      setNotice({ tone: 'success', message: '音乐选择已保存，使用方案后生效。' });
      setRefresh((value) => value + 1);
    } catch (error) {
      setNotice({
        tone: 'danger',
        message: error instanceof Error ? error.message : '音乐选择未保存，请重试。',
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
          setNotice({ tone: 'danger', message: '方案配置不完整，请刷新后检查。' });
          return null;
        }
        revisions[binding.kind] = module.revision;
      }
    return revisions;
  }
  async function importFile(file: File) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/operator/resource-library/import-preset-pack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-mizarpack' },
        body: file,
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? '同一版本的内容不同，请检查文件。'
            : '导入失败，请检查播出方案文件后重试。',
        );
      const result = (await response.json()) as { reused: boolean };
      setNotice({
        tone: 'success',
        message: result.reused ? '此播出方案已导入。' : '播出方案已保存，可查看配置后使用。',
      });
      setRefresh((value) => value + 1);
    } catch (error) {
      setNotice({
        tone: 'danger',
        message: error instanceof Error ? error.message : '导入失败，请重试。',
      });
    } finally {
      setBusy(false);
    }
  }
  async function exportFile(preset: Preset) {
    if (!view || busy) return;
    const revisions = moduleRevisions(preset);
    if (!revisions) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/operator/resource-library/export-preset-pack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          presetId: preset.id,
          expectedRevision: preset.revision,
          expectedModuleRevisions: revisions,
        }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? '配置已变化，请刷新后重试。'
            : '方案暂时无法分享，请检查所需素材和运镜来源。',
        );
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
  async function applyPreset(preset: Preset) {
    if (!view || busy) return;
    const revisions = moduleRevisions(preset);
    if (!revisions) return;
    setBusy(true);
    setNotice(null);
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
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? '配置已变化或当前无法切换，请刷新后重试。'
            : '方案暂时无法使用，请检查所需素材和设备。',
        );
      setNotice({ tone: 'success', message: `已使用「${preset.name}」。` });
      setRefresh((value) => value + 1);
    } catch (error) {
      setNotice({
        tone: 'danger',
        message: error instanceof Error ? error.message : '方案暂时无法使用，请重试。',
      });
    } finally {
      setBusy(false);
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
        <input
          ref={fileInput}
          type="file"
          accept=".mizarpack"
          aria-label="选择播出方案文件"
          hidden
          disabled={busy || !view}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void importFile(file);
          }}
        />
        <Button disabled={!view} loading={busy} onClick={() => fileInput.current?.click()}>
          导入方案
        </Button>
      </div>
      {notice ? <StatusBanner tone={notice.tone}>{notice.message}</StatusBanner> : null}
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
          <Panel className="resource-library__item resource-library__preset" key={preset.id}>
            <div>
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
            <details>
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
              {view ? (
                <MusicBindingEditor
                  key={`${preset.id}:${preset.revision}`}
                  preset={preset}
                  modules={view.modules}
                  busy={busy}
                  save={(item, moduleId) => void saveMusic(item, moduleId)}
                />
              ) : null}
            </details>
            <div className="resource-library__preset-actions">
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
