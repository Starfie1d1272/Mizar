import { useRef, useState } from 'react';
import { useLocalRead } from '../preparation/client';
import { Button, Panel, StatusBanner } from '../ui';

type MusicModule = { id: string; revision: string; name: string; kind: 'music' };
type BroadcastView = { modules: { id: string; revision: string; name: string; kind: string }[] };

export function MusicPackages({ query }: { query: string }) {
  const [refresh, setRefresh] = useState(0);
  const view = useLocalRead<BroadcastView>('/local/v1/broadcast-presets', 2000, refresh);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; message: string } | null>(
    null,
  );
  const modules = (view?.modules ?? []).filter(
    (item): item is MusicModule =>
      item.kind === 'music' &&
      item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  async function importFile(file: File) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/operator/resource-library/import-music-pack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-mizarpack' },
        body: file,
      });
      if (!response.ok) {
        if (response.status === 409) throw new Error('同一版本的内容不同，请检查文件。');
        throw new Error('导入失败，请检查音乐分享包后重试。');
      }
      const result = (await response.json()) as { reused: boolean };
      setNotice({
        tone: 'success',
        message: result.reused ? '此音乐配置已导入。' : '音乐配置已保存。',
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
  async function exportFile(module: MusicModule) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/operator/resource-library/export-music-pack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moduleId: module.id, expectedRevision: module.revision }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? '配置已变化，请刷新后重试。'
            : '分享文件未生成，请检查音乐素材后重试。',
        );
      const url = URL.createObjectURL(await response.blob());
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = `${[...module.name.trim()].map((c) => (c.charCodeAt(0) < 32 || '/\\:*?"<>|'.includes(c) ? '_' : c)).join('') || '音乐配置'}.mizarpack`;
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
  return (
    <section className="resource-library__music" aria-label="音乐配置">
      <div className="resource-library__music-heading">
        <div>
          <h2>音乐配置</h2>
          <p>保存和分享音乐选段与播放设置。</p>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".mizarpack"
          aria-label="选择音乐分享包"
          hidden
          disabled={busy || !view}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void importFile(file);
          }}
        />
        <Button disabled={!view} loading={busy} onClick={() => fileInput.current?.click()}>
          导入音乐配置
        </Button>
      </div>
      {notice ? <StatusBanner tone={notice.tone}>{notice.message}</StatusBanner> : null}
      {!view ? (
        <StatusBanner tone="warning">音乐配置暂不可用，请检查本地制播服务。</StatusBanner>
      ) : null}
      {view && modules.length === 0 ? <p>没有找到匹配的音乐配置。</p> : null}
      {modules.map((module) => (
        <Panel key={module.id} className="resource-library__item">
          <div>
            <span className="resource-library__kind">音乐配置</span>
            <h2>{module.name}</h2>
            <p>音乐选段与播放设置</p>
          </div>
          <div />
          <Button disabled={busy} onClick={() => void exportFile(module)}>
            分享
          </Button>
        </Panel>
      ))}
    </section>
  );
}
