import { useState } from 'react';
import { MusicSettings } from '../music/MusicSettings';
import { ObsAudioRouting } from '../preparation/ObsAudioRouting';
import { ObsGameAudioPolicy } from '../preparation/ObsGameAudioPolicy';
import { prepareObs, useObsPreparation } from '../workspace/obs-preparation';
import { useObsStatus } from '../workspace/obs-client';
import { Button, Panel, StatusBanner } from '../ui';
import { Mixer } from './Mixer';

type Section = 'music' | 'sources' | 'policy';
export function SoundSettings() {
  const [section, setSection] = useState<Section>('music');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [routingVersion, setRoutingVersion] = useState(0);
  const obs = useObsStatus();
  const preparation = useObsPreparation();
  const preparing = preparation.phase === 'running';
  const connected = obs?.connection === 'connected';
  const outputActive = connected && (obs.streaming !== false || obs.recording !== false);
  const findings =
    obs?.findings.filter(
      (item) =>
        item.code.startsWith('audio_') ||
        item.code === 'game_audio_missing' ||
        item.code === 'commentary_pending',
    ) ?? [];
  const unchecked = obs?.findings.some((item) =>
    [
      'collection_missing',
      'collection_inactive',
      'scene_missing',
      'configuration_unchecked',
      'configuration_check_failed',
      'source_kind_conflict',
    ].includes(item.code),
  );
  return (
    <div className="sound-settings">
      <nav className="obs-settings-tabs" aria-label="声音设置分区">
        {(
          [
            ['music', '音乐'],
            ['sources', '音源'],
            ['policy', '场景策略'],
          ] as const
        ).map(([id, label]) => (
          <Button key={id} aria-pressed={section === id} onClick={() => setSection(id)}>
            {label}
          </Button>
        ))}
      </nav>
      <div hidden={section !== 'music'}>
        {section === 'music' && <Mixer musicOnly />}
        <MusicSettings active={section === 'music'} />
      </div>
      <div hidden={section !== 'sources'}>
        {section === 'sources' && (
          <Panel className="settings-card sound-sources">
            <div>
              <h2>节目音源</h2>
              {outputActive && <p>直播或录像期间可查看音源。停止输出后可更换设备。</p>}
            </div>
            {!connected ? (
              <StatusBanner tone="info">等待 OBS 连接，连接后可检查节目声音。</StatusBanner>
            ) : preparing ? (
              <StatusBanner tone="info">正在准备场景与音频…</StatusBanner>
            ) : unchecked || findings.length > 0 ? (
              <StatusBanner tone="warning">
                {unchecked ? 'OBS 场景还未就绪。' : findings[0]?.message}
                {findings.length > 1 && (
                  <details>
                    <summary>其他检查结果</summary>
                    <ul>
                      {findings.slice(1).map((finding) => (
                        <li key={finding.code}>{finding.message}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </StatusBanner>
            ) : null}
            {connected && !preparing && (
              <Button
                variant={unchecked || findings.length > 0 ? 'primary' : 'secondary'}
                disabled={busy || outputActive}
                onClick={() => {
                  setBusy(true);
                  setMessage('');
                  void prepareObs()
                    .then(() => {
                      setRoutingVersion((version) => version + 1);
                      setMessage('已重新检查场景与音频。');
                    })
                    .catch((error: unknown) =>
                      setMessage(error instanceof Error ? error.message : '场景与音频准备未完成。'),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                {unchecked || findings.length > 0 ? '修复场景与音频' : '重新检查'}
              </Button>
            )}
            {message && <p role="status">{message}</p>}
            <ObsAudioRouting key={routingVersion} outputActive={outputActive} />
          </Panel>
        )}
      </div>
      <div hidden={section !== 'policy'}>
        <Panel className="settings-card">
          <h2>场景策略</h2>
          <ObsGameAudioPolicy />
        </Panel>
      </div>
    </div>
  );
}
