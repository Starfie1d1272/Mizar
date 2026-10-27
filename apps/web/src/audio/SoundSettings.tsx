import { useState } from 'react';
import { MusicSettings } from '../music/MusicSettings';
import { ObsAudioRouting } from '../preparation/ObsAudioRouting';
import { ObsGameAudioPolicy } from '../preparation/ObsGameAudioPolicy';
import { useObsPreparation, prepareObs } from '../workspace/obs-preparation';
import { useObsStatus } from '../workspace/obs-client';
import { Button, Panel, StatusBanner } from '../ui';
import { Mixer } from './Mixer';

type Section = 'music' | 'sources' | 'policy';
export function SoundSettings() {
  const [section, setSection] = useState<Section>('music');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const obs = useObsStatus();
  const preparation = useObsPreparation();
  const preparing = preparation.phase === 'running';
  const connected = obs?.connection === 'connected';
  const outputActive = connected && (obs.streaming || obs.recording);
  const findings =
    obs?.findings.filter(
      (item) => item.code.startsWith('audio_') || item.code === 'game_audio_missing',
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
        <StatusBanner tone="info">正在直播或录制，自动配置暂缓；停止输出后继续处理。</StatusBanner>
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
          <ObsAudioRouting />
          <p>缺少来源时自动添加默认桌面音频与麦克风；已有音频来源会保留并检查。</p>
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
            {outputActive && <p>正在直播或录制，请停止输出后再添加来源。</p>}
            <Button
              disabled={busy || preparing || !connected || outputActive}
              onClick={() => {
                setBusy(true);
                setMessage('');
                void prepareObs()
                  .then(() => setMessage('已重新处理自动配置，请核对音频检查结果。'))
                  .catch(() => setMessage('音频自动配置未完成，请检查 OBS。'))
                  .finally(() => setBusy(false));
              }}
            >
              重试音频自动配置
            </Button>
            <small>
              已有自定义或游戏捕获音频时，不重复添加默认采集；请在 OBS
              中处理具体设备、静音和音轨问题。
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
