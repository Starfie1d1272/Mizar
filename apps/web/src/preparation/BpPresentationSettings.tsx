import { useState } from 'react';
import type { BpSnapshot } from '@mizar/protocol/bp';
import { BpCompactPresentation, BpPresentation } from '@mizar/hud-view';
import { Panel, StatusBanner } from '../ui';
import { command, useLocalRead } from './client';
import './bp-presentation-settings.css';

type Mode = 'full' | 'compact';
type View = { mode: Mode; revision: string };
const maps = ['ancient', 'anubis', 'inferno', 'nuke', 'mirage', 'dust2', 'vertigo'];
const kinds = ['ban', 'ban', 'pick', 'pick', 'ban', 'ban', 'decider'] as const;
const cards = maps.map((map, index) => ({
  mapName: `de_${map}`,
  kind: kinds[index]!,
  entrant: index === 6 ? null : index % 2 ? ('b' as const) : ('a' as const),
  sideChoice: null,
}));
const preview: BpSnapshot = {
  schemaVersion: 'mizar.bp.v2',
  revision: 'preview',
  state: 'shown',
  revealedCount: 7,
  projection: {
    competition: '示例赛事',
    stage: '示例',
    format: 'bo3',
    entrants: {
      a: { name: '示例战队 A', logoUrl: null },
      b: { name: '示例战队 B', logoUrl: null },
    },
    cards,
    steps: cards.map((_, index) => ({ cardIndex: index, kind: 'card' as const })),
  },
};

export function BpPresentationSettingsPanel() {
  const [refresh, setRefresh] = useState(0);
  const view = useLocalRead<View>('/local/v1/bp-presentation', 3000, refresh);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function select(mode: Mode) {
    if (!view || busy || view.mode === mode) return;
    setBusy(true);
    setMessage('');
    try {
      await command('/operator/bp-presentation', { mode, expectedRevision: view.revision });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败，请重试。');
    } finally {
      setRefresh((value) => value + 1);
      setBusy(false);
    }
  }
  return (
    <Panel className="settings-card bp-presentation-settings">
      <h2>BP 播出样式</h2>
      <p>选择进入 BP 时的画面。预览使用示例数据，设置不影响当前播出。</p>
      <fieldset disabled={!view || busy}>
        <legend>选择 BP 样式</legend>
        {(['full', 'compact'] as const).map((mode) => (
          <label key={mode} className="bp-presentation-choice">
            <input
              type="radio"
              name="bp-presentation"
              value={mode}
              checked={view?.mode === mode}
              onChange={() => void select(mode)}
            />
            <strong>{mode === 'full' ? '全屏 BP' : '游戏画面 + BP 底栏'}</strong>
            <span className="bp-presentation-preview" aria-hidden="true">
              {mode === 'compact' ? (
                <video
                  muted
                  playsInline
                  preload="metadata"
                  src="/fixtures/epl-inferno-video/replay/background.mp4"
                />
              ) : null}
              <span className="bp-presentation-preview-canvas">
                {mode === 'full' ? (
                  <BpPresentation snapshot={preview} />
                ) : (
                  <BpCompactPresentation snapshot={preview} />
                )}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {!view ? (
        <StatusBanner tone="warning">展示设置暂不可用，请检查制作服务。</StatusBanner>
      ) : null}
      {message ? <StatusBanner tone="warning">{message}</StatusBanner> : null}
    </Panel>
  );
}
