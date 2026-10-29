import { useState } from 'react';
import type { PortableMusicConfigV1, PortableTrack } from '@mizar/broadcast-config';
import { MUSIC_GROUPS, type MusicGroup } from '@mizar/protocol/music';
import { MUSIC_LABELS } from '../music/MusicControls';
import { MusicVolumeField } from '../music/MusicVolumeField';
import { Button, Checkbox, Field, Panel, Select } from '../ui';

export function MusicModuleEditor({
  value,
  onChange,
  onSave,
  busy,
}: {
  value: PortableMusicConfigV1;
  onChange: (value: PortableMusicConfigV1) => void;
  onSave: () => void;
  busy: boolean;
}) {
  const [selectedGroup, setSelectedGroup] = useState<MusicGroup>('waiting');
  const spec = value.groups[selectedGroup];
  const change = (patch: Partial<PortableMusicConfigV1['groups'][MusicGroup]>) =>
    onChange({
      ...value,
      groups: {
        ...value.groups,
        [selectedGroup]: { ...spec, ...patch },
      },
    });
  const changeTrack = (index: number, update: (track: PortableTrack) => PortableTrack) =>
    change({ tracks: spec.tracks.map((track, i) => (i === index ? update(track) : track)) });
  const move = (index: number, destination: MusicGroup) => {
    const track = spec.tracks[index]!;
    const target = value.groups[destination];
    if (
      destination === selectedGroup ||
      target.tracks.some((entry) => entry.entryId === track.entryId) ||
      target.tracks.length >= (destination === 'waiting' || destination === 'technical' ? 64 : 1)
    )
      return;
    onChange({
      ...value,
      groups: {
        ...value.groups,
        [selectedGroup]: { ...spec, tracks: spec.tracks.filter((_, i) => i !== index) },
        [destination]: { ...target, tracks: [...target.tracks, track] },
      },
    });
  };
  return (
    <>
      <p>保存后仍是资源草稿，不会改变当前播出。</p>
      <Checkbox
        label="自动播放"
        checked={value.automaticEnabled}
        disabled={busy}
        onChange={(event) => onChange({ ...value, automaticEnabled: event.target.checked })}
      />
      <div className="music-settings-workspace">
        <nav className="music-settings-groups" aria-label="音乐场景">
          {MUSIC_GROUPS.map((group) => (
            <Button
              key={group}
              aria-pressed={group === selectedGroup}
              onClick={() => setSelectedGroup(group)}
            >
              {MUSIC_LABELS[group]}
              <span>
                {value.groups[group].tracks.length
                  ? `${value.groups[group].tracks.length} 首`
                  : '空'}
              </span>
            </Button>
          ))}
        </nav>
        <Panel className="settings-card">
          <div className="music-settings-group-heading">
            <h3>{MUSIC_LABELS[selectedGroup]}</h3>
            <Checkbox
              label="启用"
              checked={spec.enabled}
              disabled={busy}
              onChange={(event) => change({ enabled: event.target.checked })}
            />
          </div>
          {spec.tracks.length ? (
            <ol
              className="music-settings-tracks"
              aria-label={`${MUSIC_LABELS[selectedGroup]}曲目列表`}
            >
              {spec.tracks.map((track, index) => (
                <li key={track.entryId}>
                  <span className="music-settings-track-index">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <strong>{track.name}</strong>
                  <MusicVolumeField
                    label={`曲目音量 · ${Math.round((track.gain ?? spec.volume) * 100)}% · ${track.gain === undefined ? '跟随场景音量' : '单独设置'}`}
                    ariaLabel={`${track.name} 音量`}
                    value={track.gain ?? spec.volume}
                    disabled={busy}
                    onChange={(gain) => changeTrack(index, (entry) => ({ ...entry, gain }))}
                  />
                  {track.gain !== undefined && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        changeTrack(index, (entry) => {
                          const next = { ...entry };
                          delete next.gain;
                          return next;
                        })
                      }
                    >
                      跟随场景音量
                    </Button>
                  )}
                  <Button
                    disabled={busy || index === 0}
                    aria-label={`上移 ${track.name}`}
                    onClick={() => {
                      const tracks = [...spec.tracks];
                      [tracks[index - 1], tracks[index]] = [tracks[index]!, tracks[index - 1]!];
                      change({ tracks });
                    }}
                  >
                    上移
                  </Button>
                  <Button
                    disabled={busy || index === spec.tracks.length - 1}
                    aria-label={`下移 ${track.name}`}
                    onClick={() => {
                      const tracks = [...spec.tracks];
                      [tracks[index], tracks[index + 1]] = [tracks[index + 1]!, tracks[index]!];
                      change({ tracks });
                    }}
                  >
                    下移
                  </Button>
                  <Select
                    label={`移动 ${track.name} 到场景`}
                    value={selectedGroup}
                    disabled={busy}
                    onChange={(event) => move(index, event.target.value as MusicGroup)}
                  >
                    {MUSIC_GROUPS.map((group) => (
                      <option
                        key={group}
                        value={group}
                        disabled={
                          group !== selectedGroup &&
                          (value.groups[group].tracks.some(
                            (entry) => entry.entryId === track.entryId,
                          ) ||
                            value.groups[group].tracks.length >=
                              (group === 'waiting' || group === 'technical' ? 64 : 1))
                        }
                      >
                        {MUSIC_LABELS[group]}
                      </option>
                    ))}
                  </Select>
                  <Button
                    disabled={busy}
                    aria-label={`移除 ${track.name}`}
                    onClick={() => change({ tracks: spec.tracks.filter((_, i) => i !== index) })}
                  >
                    移除
                  </Button>
                </li>
              ))}
            </ol>
          ) : (
            <div className="music-settings-empty">
              <strong>尚未选曲 · 静音</strong>
            </div>
          )}
          <MusicVolumeField
            label={`场景音量 · ${Math.round(spec.volume * 100)}%`}
            message="未单独设置的曲目跟随场景音量。"
            value={spec.volume}
            disabled={busy}
            onChange={(volume) => change({ volume })}
          />
          <details>
            <summary>高级设置</summary>
            {(selectedGroup === 'waiting' || selectedGroup === 'technical') && (
              <Select
                label="播放顺序"
                value={spec.order}
                disabled={busy}
                onChange={(event) =>
                  change({ order: event.target.value as 'sequence' | 'shuffle' })
                }
              >
                <option value="sequence">顺序循环</option>
                <option value="shuffle">随机（不连续重复）</option>
              </Select>
            )}
            {(['fadeInMs', 'fadeOutMs'] as const).map((key) => (
              <Field
                key={key}
                label={key === 'fadeInMs' ? '淡入（毫秒）' : '淡出（毫秒）'}
                type="number"
                min="0"
                max="10000"
                step="100"
                value={spec[key]}
                disabled={busy}
                onChange={(event) => change({ [key]: Number(event.target.value) })}
              />
            ))}
            {spec.tracks.map((track, index) => (
              <div key={track.entryId}>
                <strong>{track.name}</strong>
                {(['startMs', 'endMs'] as const).map((key) => (
                  <Field
                    key={key}
                    label={key === 'startMs' ? '起点（毫秒）' : '终点（毫秒，留空至自然结束）'}
                    type="number"
                    min={key === 'startMs' ? 0 : 1}
                    max="86400000"
                    value={track[key] ?? ''}
                    disabled={busy}
                    onChange={(event) =>
                      changeTrack(index, (entry) => ({
                        ...entry,
                        [key]:
                          event.target.value === '' && key === 'endMs'
                            ? null
                            : Number(event.target.value),
                      }))
                    }
                  />
                ))}
              </div>
            ))}
            <Button disabled={busy || !spec.tracks.length} onClick={() => change({ tracks: [] })}>
              清空本组曲目
            </Button>
          </details>
        </Panel>
      </div>
      <div className="music-settings-save__actions">
        <Button variant="primary" loading={busy} disabled={busy} onClick={onSave}>
          保存音乐配置
        </Button>
      </div>
    </>
  );
}
