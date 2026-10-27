import { useMusicPreview } from './useMusicPreview';
import { controlEvidence, browserErrorEvidence } from '../debug/control-journal';
import { useState } from 'react';
import {
  MUSIC_GROUPS,
  type MusicConfig,
  type MusicGroup,
  type MusicTrack,
} from '@mizar/protocol/music';
import { Button, Checkbox, Field, Panel, Select, StatusBanner } from '../ui';
import { command, useLocalRead } from '../preparation/client';
import { MusicControls, MUSIC_LABELS, type MusicView } from './MusicControls';

async function localFile(url: string, file: File, type: string) {
  const operationId = crypto.randomUUID();
  controlEvidence('music_file', 'selected', {
    operationId,
    name: file.name,
    bytes: file.size,
    type: file.type,
    destination: url,
  });
  let body: ArrayBuffer;
  controlEvidence('music_file', 'read_begin', { operationId, name: file.name, bytes: file.size });
  try {
    body = await file.arrayBuffer();
  } catch (error) {
    controlEvidence('music_file', 'read_failed', {
      operationId,
      error: browserErrorEvidence(error),
    });
    throw new Error('文件未能读取，请确认文件仍在原位置且可以访问后重新选择。', { cause: error });
  }
  controlEvidence('music_file', 'read_success', { operationId, bytes: body.byteLength });
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': type,
        'x-mizar-filename': encodeURIComponent(file.name),
        'x-mizar-operation-id': operationId,
      },
      body,
    });
  } catch (error) {
    controlEvidence('music_file', 'upload_failed', {
      operationId,
      error: browserErrorEvidence(error),
    });
    throw new Error('曲目未能传到本机服务，请确认 Mizar 正在运行后重试。', { cause: error });
  }
  controlEvidence('music_file', 'uploaded', { operationId, status: response.status });
  if (!response.ok) {
    const reason = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(
      reason?.message ??
        (url.endsWith('import')
          ? '音乐包未导入，原配置已保留。请检查 music.json、文件格式与大小限制。'
          : '曲目未添加，请检查音频格式与大小（最大 32 MiB）。'),
    );
  }
  return response.json() as Promise<MusicView & MusicTrack>;
}
export function MusicSettings() {
  const preview = useMusicPreview();
  const current = useLocalRead<MusicView>('/local/v1/music', 2000);
  const [selectedGroup, setSelectedGroup] = useState<MusicGroup>('waiting');
  const [draft, setConfig] = useState<MusicConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageAt, setMessageAt] = useState<MusicGroup | 'import' | 'save'>('import');
  const [failed, setFailed] = useState(false);
  const config = draft ?? current?.config ?? null;
  const change = (group: MusicGroup, patch: Partial<MusicConfig['groups'][MusicGroup]>) => {
    controlEvidence('music_draft', 'change', { group, patch });
    if (patch.volume !== undefined) preview.volume(group, patch.volume);
    else void preview.stop();
    setDirty(true);
    setMessage('');
    setConfig((c) => {
      const base = c ?? config;
      return base
        ? { ...base, groups: { ...base.groups, [group]: { ...base.groups[group], ...patch } } }
        : null;
    });
  };
  const action = async (
    run: () => Promise<void>,
    at: MusicGroup | 'import' | 'save' = 'import',
  ) => {
    if (busy) return;
    setMessageAt(at);
    setFailed(false);
    setBusy(true);
    setMessage('');
    try {
      await run();
    } catch (e) {
      setFailed(true);
      setMessage(e instanceof Error ? e.message : '操作未完成，请重试。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Panel className="music-settings-playback">
        <div className="music-settings-playback-intro">
          <h2>当前播放</h2>
          <p>由 OBS 播放。这里的播放操作和音乐总音量立即生效。</p>
        </div>
        <MusicControls volumeDisabled={busy || dirty} />
        {dirty ? <p>请先保存场景配置，再选择正式播放曲目。</p> : null}
        {current?.storage && (!current.storage.ready || current.storage.failed) ? (
          <StatusBanner tone="danger">
            音乐存储未就绪，原配置未加载。请检查数据目录权限或状态文件后重新检查。
            <Button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await command('/operator/music', { action: 'reload' });
                  setMessage('音乐存储已重新加载。');
                })
              }
            >
              重新检查音乐存储
            </Button>
          </StatusBanner>
        ) : null}
      </Panel>
      {!config ? (
        <p role="status">等待本机音乐服务，请确认 Companion 已配置 OBS。</p>
      ) : (
        <>
          <div className="music-settings-save">
            <div className="music-settings-save__title">
              <h2>音乐配置</h2>
              <span role="status">
                {dirty
                  ? '有未保存修改'
                  : messageAt === 'save' && message && !failed
                    ? message
                    : '配置已保存'}
              </span>
            </div>
            <div className="music-settings-save__actions">
              <details className="music-settings-import">
                <summary>导入音乐包</summary>
                <Field
                  label="一键导入音乐包"
                  message="选择含 music.json 和相对路径音频的 ZIP（最大 128 MiB）。验证成功后替换七组配置。"
                  type="file"
                  accept=".zip"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file)
                      void action(async () => {
                        await preview.stop();
                        const result = await localFile(
                          '/operator/music/import',
                          file,
                          'application/zip',
                        );
                        setConfig(result.config);
                        setDirty(false);
                        setMessage('音乐包已导入并保存。');
                      });
                  }}
                />
                <p>只选择你有权直播或录制使用的音乐。文件仅保存在本机，不联网下载或分享。</p>
              </details>
              <Button
                variant="primary"
                loading={busy}
                disabled={busy || !dirty}
                onClick={() =>
                  void action(async () => {
                    await command('/operator/music', { action: 'configure', config });
                    setDirty(false);
                    setMessage('音乐配置已保存。');
                  }, 'save')
                }
              >
                保存音乐配置
              </Button>
            </div>
          </div>
          {message && (messageAt === 'import' || (messageAt === 'save' && failed)) ? (
            <StatusBanner tone={failed ? 'danger' : 'info'}>{message}</StatusBanner>
          ) : null}
          <div className="music-settings-workspace">
            <nav className="music-settings-groups" aria-label="音乐场景">
              {MUSIC_GROUPS.map((group) => (
                <Button
                  key={group}
                  aria-pressed={selectedGroup === group}
                  onClick={() => {
                    void preview.stop();
                    setSelectedGroup(group);
                  }}
                >
                  {MUSIC_LABELS[group]}
                  <span>
                    {config.groups[group].tracks.length
                      ? `${config.groups[group].tracks.length} 首`
                      : '空'}
                  </span>
                </Button>
              ))}
            </nav>
            {MUSIC_GROUPS.map((group) => {
              const spec = config.groups[group];
              const playlist = group === 'waiting' || group === 'technical';
              return (
                <Panel className="settings-card" key={group} hidden={selectedGroup !== group}>
                  <div className="music-settings-group-heading">
                    <h3>{MUSIC_LABELS[group]}</h3>
                    <Checkbox
                      checked={spec.enabled}
                      disabled={busy}
                      onChange={(e) => change(group, { enabled: e.target.checked })}
                      label="启用"
                    />
                  </div>
                  {group === 'waiting' ? <p>赛前、BP、热身与图间共用，不因画面切换重播。</p> : null}
                  {spec.tracks.length ? (
                    <ol
                      className="music-settings-tracks"
                      aria-label={MUSIC_LABELS[group] + '曲目列表'}
                    >
                      {spec.tracks.map((track, index) => (
                        <li key={track.entryId ?? `${track.id}:${index}`}>
                          <span className="music-settings-track-index">
                            {String(index + 1).padStart(2, '0')}
                          </span>
                          <strong>{track.name}</strong>
                          <Field
                            label={`曲目音量 · ${Math.round((track.gain ?? spec.volume) * 100)}%`}
                            aria-label={`${track.name} 音量`}
                            type="range"
                            min="0"
                            max="1"
                            step="0.05"
                            value={track.gain ?? spec.volume}
                            disabled={busy}
                            onChange={(event) =>
                              change(group, {
                                tracks: spec.tracks.map((entry, n) =>
                                  n === index
                                    ? { ...entry, gain: Number(event.target.value) }
                                    : entry,
                                ),
                              })
                            }
                          />
                          <Button
                            disabled={busy}
                            aria-label={'试听 ' + track.name}
                            onClick={() => void preview.start(group, spec, track)}
                          >
                            试听
                          </Button>
                          <Button
                            disabled={busy}
                            aria-label={'移除 ' + track.name}
                            onClick={() =>
                              change(group, { tracks: spec.tracks.filter((_, i) => i !== index) })
                            }
                          >
                            移除
                          </Button>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <div className="music-settings-empty">
                      <strong>尚未选曲 · 静音</strong>
                      <p>选择本地音频后保存，系统按节目编排播放。未选曲时保持静音。</p>
                    </div>
                  )}
                  <Field
                    label={playlist ? '选择本地曲目' : '选择本地主题'}
                    message={
                      playlist
                        ? '可多选；重新选择会替换本组列表。支持 MP3、WAV、OGG、FLAC、M4A，每首最大 32 MiB。'
                        : '本场景使用一首主题；重新选择会替换原曲目。'
                    }
                    type="file"
                    accept=".wav,.mp3,.ogg,.flac,.m4a"
                    multiple={playlist}
                    disabled={busy}
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      e.target.value = '';
                      if (files.length)
                        void action(async () => {
                          const tracks: MusicTrack[] = [];
                          for (const file of files)
                            tracks.push({
                              ...(await localFile(
                                '/operator/music/track',
                                file,
                                'application/x-mizar-audio',
                              )),
                              entryId: crypto.randomUUID(),
                            });
                          change(group, { tracks });
                          setMessage('曲目已选，请保存音乐配置。');
                        }, group);
                    }}
                  />
                  {message && messageAt === group ? (
                    <StatusBanner tone={failed ? 'danger' : 'info'}>{message}</StatusBanner>
                  ) : null}
                  <Field
                    label={`场景音量 · ${Math.round(spec.volume * 100)}%`}
                    message="试听使用未保存的音量和选段；保存后用于节目自动播放。"
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={spec.volume}
                    disabled={busy}
                    onChange={(e) => change(group, { volume: Number(e.target.value) })}
                  />
                  <div className="music-controls" aria-label="音乐试听">
                    <Button
                      disabled={
                        busy ||
                        !spec.tracks.length ||
                        Boolean(
                          current?.storage && (!current.storage.ready || current.storage.failed),
                        )
                      }
                      onClick={() => void preview.start(group, spec, spec.tracks[0]!)}
                    >
                      试听本组
                    </Button>
                    <Button
                      disabled={
                        !preview.status || ['stopped', 'failed'].includes(preview.status.phase)
                      }
                      onClick={() => void preview.stop()}
                    >
                      停止试听
                    </Button>
                    <span>通过 OBS 试听，会进入直播/录制。</span>
                  </div>
                  {!spec.tracks.length ? <p>本组尚未选曲，选择本地音频后可试听。</p> : null}
                  {preview.error && selectedGroup === group ? (
                    <StatusBanner tone="danger">{preview.error}</StatusBanner>
                  ) : null}
                  {preview.status?.group === group ? (
                    <StatusBanner
                      tone={
                        preview.status.phase === 'failed' || preview.status.phase === 'cleanup'
                          ? 'danger'
                          : 'info'
                      }
                    >
                      {preview.status.message}
                      {preview.status.phase === 'confirmation' ? (
                        <>
                          <Button onClick={() => void preview.confirm()}>确认通过 OBS 试听</Button>
                          <Button onClick={() => void preview.stop()}>取消试听</Button>
                        </>
                      ) : null}
                    </StatusBanner>
                  ) : null}
                  <details>
                    <summary>高级设置</summary>
                    {playlist ? (
                      <Select
                        label="播放顺序"
                        value={spec.order}
                        disabled={busy}
                        onChange={(e) =>
                          change(group, { order: e.target.value as 'sequence' | 'shuffle' })
                        }
                      >
                        <option value="sequence">顺序循环</option>
                        <option value="shuffle">随机（不连续重复）</option>
                      </Select>
                    ) : null}
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
                        onChange={(e) => change(group, { [key]: Number(e.target.value) })}
                      />
                    ))}
                    {spec.tracks.map((track, i) => (
                      <div key={track.entryId ?? `${track.id}:${i}`}>
                        <strong>{track.name}</strong>
                        {(['startMs', 'endMs'] as const).map((key) => (
                          <Field
                            key={key}
                            label={
                              key === 'startMs' ? '起点（毫秒）' : '终点（毫秒，留空至自然结束）'
                            }
                            type="number"
                            min={key === 'startMs' ? 0 : 1}
                            max="86400000"
                            value={track[key] ?? ''}
                            disabled={busy}
                            onChange={(e) =>
                              change(group, {
                                tracks: spec.tracks.map((t, n) =>
                                  n === i
                                    ? {
                                        ...t,
                                        [key]:
                                          e.target.value === '' && key === 'endMs'
                                            ? null
                                            : Number(e.target.value),
                                      }
                                    : t,
                                ),
                              })
                            }
                          />
                        ))}
                      </div>
                    ))}
                    <Button
                      disabled={busy || !spec.tracks.length}
                      onClick={() => change(group, { tracks: [] })}
                    >
                      清空本组曲目
                    </Button>
                  </details>
                </Panel>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
