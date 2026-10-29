import { useRef, useState } from 'react';
import type { ModuleRecord } from '@mizar/broadcast-config';
import { useLocalRead } from '../preparation/client';
import { Button, Panel, Select, StatusBanner } from '../ui';
import { PresetVisualPreview } from './PresetVisualPreview';
import { pulseTokenStyle } from '../program/broadcast-display';
import { exportFailure } from './export-error';

type Kind = ModuleRecord['kind'];
type Snapshot = {
  modules: ModuleRecord[];
  presets: {
    id: string;
    name: string;
    revision: string;
    bindings: { kind: Kind; mode: 'use' | 'off'; moduleId?: string }[];
  }[];
  active: {
    revision: string;
    sourceModuleIds?: Partial<Record<Kind, string | null>>;
    sourceModuleRevisions?: Partial<Record<Kind, string | null>>;
  };
};
const labels: Record<Kind, string> = { hud: 'HUD', program: '场景', music: '音乐', camera: '运镜' };
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
export function ResourceModules({
  query,
  category,
  onImported,
}: {
  query: string;
  category: string;
  onImported: () => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const snapshot = useLocalRead<Snapshot>('/local/v1/broadcast-presets', 2000, refresh);
  const directory = useLocalRead<{
    modules: {
      module: ModuleRecord;
      builtin: boolean;
      availability?: { state: 'ready' | 'dependency_missing'; reason?: string };
    }[];
  }>('/local/v1/broadcast-modules', 2000, refresh);
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
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    tone: 'success' | 'danger' | 'warning';
    message: string;
  } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const showList = category === 'all' || ['hud', 'program', 'music', 'camera'].includes(category);
  const entries =
    directory?.modules.filter(
      ({ module }) =>
        (category === 'all' || category === module.kind) &&
        module.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    ) ?? [];
  const item = directory?.modules.find(({ module }) => module.id === selected);
  const module = item?.module;
  const referenceView = useLocalRead<{
    moduleId: string;
    revision: string;
    active: boolean;
    presets: { id: string; name: string; revision: string }[];
  }>(
    selected ? `/local/v1/broadcast-modules/${encodeURIComponent(selected)}/references` : null,
    2000,
    refresh,
  );
  const referencesReady =
    !!module && referenceView?.moduleId === module.id && referenceView.revision === module.revision;
  const references = referencesReady ? referenceView.presets : [];
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
      setRefresh((value) => value + 1);
      return true;
    } catch (error) {
      setNotice({
        tone: 'danger',
        message: error instanceof Error ? error.message : '操作未完成。',
      });
      setRefresh((value) => value + 1);
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
      setRefresh((value) => value + 1);
    }
  }
  async function importFile(file: File) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/operator/resource-library/import-pack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-mizarpack' },
        body: file,
      });
      if (!response.ok)
        throw new Error(
          response.status === 409 ? '同一版本的内容不同，请检查文件。' : '导入失败，请检查资源包。',
        );
      const result = (await response.json()) as {
        mapping: { moduleEntries: Record<string, string[]> };
        reused: boolean;
        entries?: {
          type: 'module' | 'preset';
          kind?: Kind;
          result: 'imported' | 'existing' | 'unavailable' | 'not_selected';
        }[];
      };
      const firstId = Object.values(result.mapping.moduleEntries).flat()[0];
      if (firstId) {
        setSelected(firstId);
        onImported();
      }
      const unavailable = result.entries?.filter((entry) => entry.result === 'unavailable') ?? [];
      const accepted = result.entries?.filter(
        (entry) => entry.result === 'imported' || entry.result === 'existing',
      );
      const unavailableText = unavailable
        .map((entry) => (entry.type === 'preset' ? '方案' : (labels[entry.kind as Kind] ?? '资源')))
        .join('、');
      setNotice(
        unavailable.length
          ? {
              tone: accepted?.length ? 'warning' : 'danger',
              message: accepted?.length
                ? `部分资源已保存，尚未使用；以下内容无法导入：${unavailableText}。`
                : `没有导入资源；以下内容无法导入：${unavailableText}。`,
            }
          : {
              tone: 'success',
              message: result.reused ? '资源已存在，已定位。' : '资源已导入，尚未使用。',
            },
      );
      setRefresh((value) => value + 1);
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
          aria-label="选择资源包"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void importFile(file);
          }}
        />
        <Button disabled={busy} onClick={() => input.current?.click()}>
          导入资源
        </Button>
      </div>
      {notice && <StatusBanner tone={notice.tone}>{notice.message}</StatusBanner>}
      {(!snapshot || !directory) && (
        <StatusBanner tone="warning">资源目录暂不可用，请检查本地制播服务。</StatusBanner>
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
          <Panel className="resource-library__item" key={entry.id}>
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
                <div className="resource-library__preset-actions">
                  <Button
                    disabled={
                      busy ||
                      !snapshot ||
                      (entry.kind === 'program' && pulseTokenStyle(entry.value) === null)
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
