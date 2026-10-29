import { useState } from 'react';
import { useLocalRead } from '../preparation/client';
import { Button, Panel, StatusBanner } from '../ui';

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

export function BroadcastPresets({ query }: { query: string }) {
  const [refresh, setRefresh] = useState(0);
  const view = useLocalRead<View>('/local/v1/broadcast-presets', 2000, refresh);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; message: string } | null>(
    null,
  );
  async function applyPreset(preset: Preset) {
    if (!view || busy) return;
    const revisions: Partial<Record<Kind, string>> = {};
    for (const binding of preset.bindings)
      if (binding.mode === 'use') {
        const module = view.modules.find(
          (item) => item.id === binding.moduleId && item.kind === binding.kind,
        );
        if (!module) {
          setNotice({ tone: 'danger', message: '方案配置不完整，请刷新后检查。' });
          return;
        }
        revisions[binding.kind] = module.revision;
      }
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
            </details>
            <Button disabled={busy} onClick={() => void applyPreset(preset)}>
              使用方案
            </Button>
          </Panel>
        );
      })}
    </section>
  );
}
