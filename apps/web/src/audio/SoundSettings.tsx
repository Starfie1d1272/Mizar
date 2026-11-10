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
      {outputActive && findings.length > 0 && (
        <StatusBanner tone="info">正在直播或录制，停止输出后可重新配置。</StatusBanner>
      )}
      <Mixer />
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
        <MusicSettings active={section === 'music'} />
      </div>
      <div hidden={section !== 'sources'}>
        <Panel className="settings-card">
          <h2>音源</h2>
          <ObsAudioRouting key={routingVersion} active={section === 'sources'} />
          <p>音源由「Mizar 制播」集合统一维护，设备选择与静音状态分别配置。</p>
          {!connected ? (
            <p>连接后自动检查音频。</p>
          ) : preparing ? (
            <p>正在自动准备，请稍候。</p>
          ) : unchecked ? (
            <p>等待场景准备完成后检查音频。</p>
          ) : findings.length ? (
            findings.map((finding) => (
              <StatusBanner key={finding.code} tone="warning">
                {finding.message}
              </StatusBanner>
            ))
          ) : (
            <p>音频配置检查通过。请在 OBS 核对实际设备、电平和输出音轨，并录制试听。</p>
          )}
          <details key={String(findings.length > 0)} open={findings.length > 0}>
            <summary>{findings.length ? '处理音频问题' : '音频维护'}</summary>
            {outputActive && <p>正在直播或录制，请停止输出后再修复场景与音频。</p>}
            <Button
              disabled={busy || preparing || !connected || outputActive}
              onClick={() => {
                setBusy(true);
                setMessage('');
                void prepareObs()
                  .then(() => {
                    setRoutingVersion((version) => version + 1);
                    setMessage('场景与音频准备已完成，请核对下方检查结果并录制试听。');
                  })
                  .catch((error: unknown) =>
                    setMessage(error instanceof Error ? error.message : '场景与音频准备未完成。'),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              修复场景与音频
            </Button>
            <small>
              此操作重新准备专用集合，修复缺失的场景与固定音源。切换待核对时先使用上方「恢复音频状态」；更换设备使用「采集设备」，静音和音量使用混音器。实际电平和输出音轨仍需在
              OBS 核对。
            </small>
            {message && <p role="status">{message}</p>}
          </details>
        </Panel>
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
