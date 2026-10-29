import { useRef, useState } from 'react';
import type { MatchDocumentV1 } from '@mizar/protocol/context';
import { BpLocalEditor } from '../bp/BpLocalEditor';
import { useBpWorkspace } from '../bp/client';
import { Button, Dialog, Panel, Select, StatusBanner } from '../ui';
import { command } from './client';
import { MatchDocumentView } from './MatchDocumentView';
import '@mizar/hud-view/bp.css';

export function MatchBpSection({
  document,
  local,
  contextRevision,
}: {
  document: MatchDocumentV1;
  local: boolean;
  contextRevision: string | undefined;
}) {
  const { workspace, connected } = useBpWorkspace();
  const [mode, setMode] = useState<'maps' | 'bp' | null>(null);
  const [message, setMessage] = useState('');
  const [savedRevision, setSavedRevision] = useState<string>();
  const editor = useRef({ dirty: false, saving: false });
  const canClose = () =>
    !editor.current.saving && (!editor.current.dirty || window.confirm('放弃尚未保存的修改？'));
  const editable =
    local &&
    contextRevision !== savedRevision &&
    connected &&
    workspace?.source === 'local' &&
    workspace.authoringMode === 'standalone' &&
    contextRevision === workspace.contextRevision;
  return (
    <section id="match-bp" className="match-bp-section" aria-label="地图与禁选">
      <Panel className="match-bp-toolbar">
        <div>
          <h2>地图与禁选</h2>
          <p>
            {local
              ? '只有地图结果也可以保存；有完整记录时再填写 BP。进入现场后由自动编排安排播出。'
              : '地图与 BP 由网站同步。正常开播无需在这里操作，进入现场后自动编排播放。'}
          </p>
        </div>
        {local ? (
          <div className="preparation-actions">
            {!document.veto.length ? (
              <Button
                disabled={!editable}
                onClick={() => {
                  editor.current = { dirty: false, saving: false };
                  setMode('maps');
                }}
              >
                只记录地图结果
              </Button>
            ) : null}
            <Button
              disabled={!editable}
              onClick={() => {
                editor.current = { dirty: false, saving: false };
                setMode('bp');
              }}
            >
              {document.veto.length ? '修改完整 BP' : '填写完整 BP'}
            </Button>
          </div>
        ) : null}
      </Panel>
      {!local && !document.veto.length ? (
        <StatusBanner tone="info">
          等待网站禁选结果。如需修改，请在网站管理本场；这里会自动同步。
        </StatusBanner>
      ) : null}
      {local && document.maps.length > 0 && document.veto.length === 0 ? (
        <StatusBanner tone="info">已记录地图顺序；没有完整禁选记录，不播放 BP 动画。</StatusBanner>
      ) : null}
      <MatchDocumentView document={document} section="maps" />
      {message ? <StatusBanner tone="info">{message}</StatusBanner> : null}
      <Dialog
        open={mode !== null}
        title={mode === 'maps' ? '记录地图结果' : '编辑比赛 BP'}
        className={mode === 'maps' ? 'map-results-dialog' : 'bp-editor-dialog'}
        showCloseButton={false}
        canClose={canClose}
        onClose={() => setMode(null)}
      >
        {mode === 'bp' && workspace ? (
          <BpLocalEditor
            workspace={workspace}
            connected={editable}
            onStateChange={(state) => {
              editor.current = state;
            }}
            onCancel={() => {
              if (canClose()) setMode(null);
            }}
            onSaved={(text) => {
              setSavedRevision(contextRevision);
              setMode(null);
              setMessage(text);
            }}
          />
        ) : null}
        {mode === 'maps' && contextRevision ? (
          <MapResults
            document={document}
            contextRevision={contextRevision}
            connected={editable}
            onStateChange={(state) => {
              editor.current = state;
            }}
            onCancel={() => {
              if (canClose()) setMode(null);
            }}
            onSaved={() => {
              setSavedRevision(contextRevision);
              setMode(null);
              setMessage('地图结果已保存；未生成禁选记录。');
            }}
          />
        ) : null}
      </Dialog>
    </section>
  );
}

function MapResults({
  document,
  contextRevision,
  connected,
  onStateChange,
  onCancel,
  onSaved,
}: {
  document: MatchDocumentV1;
  contextRevision: string;
  connected: boolean;
  onStateChange: (state: { dirty: boolean; saving: boolean }) => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [baseline] = useState(document);
  const [revision] = useState(contextRevision);
  const count = Number(baseline.format.slice(2));
  const [maps, setMaps] = useState(() =>
    Array.from({ length: count }, (_, i) => ({
      name: baseline.maps.find((m) => m.mapOrder === i + 1)?.mapName ?? '',
      side: baseline.maps.find((m) => m.mapOrder === i + 1)?.teamAStartSide ?? '',
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const locked = baseline.maps.some(
    (m) => m.scoreA !== null || m.scoreB !== null || m.completedAt !== null,
  );
  const change = (index: number, key: 'name' | 'side', value: string) => {
    setMaps((current) => current.map((m, i) => (i === index ? { ...m, [key]: value } : m)));
    setDirty(true);
    onStateChange({ dirty: true, saving: busy });
  };
  return (
    <form
      className="map-results-form"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        onStateChange({ dirty, saving: true });
        const updated = {
          ...baseline,
          maps: maps.flatMap((map, i) =>
            map.name
              ? [
                  {
                    mapId:
                      baseline.maps.find((m) => m.mapOrder === i + 1)?.mapId ?? crypto.randomUUID(),
                    mapOrder: i + 1,
                    mapName: map.name,
                    pickedByEntryId: null,
                    teamAStartSide: map.side || null,
                    scoreA: null,
                    scoreB: null,
                    completedAt: null,
                  },
                ]
              : [],
          ),
        };
        void command('/operator/local-match/save', {
          document: updated,
          expectedContextRevision: revision,
        })
          .then(onSaved)
          .catch((reason: Error) => setError(reason.message))
          .finally(() => {
            setBusy(false);
            onStateChange({ dirty, saving: false });
          });
      }}
    >
      <p>
        {baseline.entrants.a.name} vs {baseline.entrants.b.name} · {baseline.format.toUpperCase()}
      </p>
      <p>只保存已知地图顺序和开局阵营；未知项可以留空，不会推断禁图、选图方或生成 BP 动画。</p>
      {maps.map((map, index) => (
        <div className="map-result-row" key={index}>
          <Select
            label={`图 ${index + 1}`}
            value={map.name}
            disabled={busy || locked}
            onChange={(e) => change(index, 'name', e.target.value)}
          >
            <option value="">待确定</option>
            {baseline.mapPool.map((name) => (
              <option
                key={name}
                value={name}
                disabled={maps.some((m, i) => i !== index && m.name === name)}
              >
                {name.replace(/^de_/, '').toUpperCase()}
              </option>
            ))}
          </Select>
          <Select
            label={`${baseline.entrants.a.name} 开局阵营 · 图 ${index + 1}`}
            value={map.side}
            disabled={!map.name || busy || locked}
            onChange={(e) => change(index, 'side', e.target.value)}
          >
            <option value="">待定 / 游戏内决定</option>
            <option value="CT">CT</option>
            <option value="T">T</option>
          </Select>
        </div>
      ))}
      {locked ? (
        <StatusBanner tone="warning">已有比赛结果，不能在此重写地图计划。</StatusBanner>
      ) : null}
      {error ? <StatusBanner tone="danger">{error}</StatusBanner> : null}
      <div className="preparation-actions">
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={locked || !connected || contextRevision !== revision || !dirty || busy}
        >
          保存地图结果
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}
