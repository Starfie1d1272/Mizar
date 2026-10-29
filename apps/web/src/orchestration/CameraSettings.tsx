import { useState } from 'react';
import {
  CAMERA_STAGES,
  cameraMapSchema,
  orchestrationPresetSchema,
  type CameraMap,
  type CameraShot,
  type OrchestrationPreset,
  type OrchestrationView,
} from '@mizar/protocol/orchestration';
import { Button, Field, Panel, Select, StatusBanner } from '../ui';
import { command, useLocalRead } from '../preparation/client';
import { MUSIC_LABELS, type MusicView } from '../music/MusicControls';
import { MulnxToolControls } from './MulnxToolControls';
import { MulnxHandoff } from './MulnxHandoff';
import { CameraControls } from './CameraControls';

function Shot({
  label,
  shot,
  change,
}: {
  label: string;
  shot: CameraShot | null;
  change: (shot: CameraShot | null) => void;
}) {
  return (
    <div>
      <Field
        label={label}
        value={shot?.macro ?? ''}
        placeholder="留空不触发"
        onChange={(e) =>
          change(e.target.value ? { macro: e.target.value, maxMs: shot?.maxMs ?? 6000 } : null)
        }
      />
      {shot ? (
        <details>
          <summary>镜头时限</summary>
          <Field
            label="最多持续（秒）"
            type="number"
            min={0.5}
            max={60}
            step={0.001}
            value={shot.maxMs / 1000}
            onChange={(e) => change({ ...shot, maxMs: Number(e.target.value) * 1000 })}
          />
        </details>
      ) : null}
    </div>
  );
}
export function CameraSettings() {
  const current = useLocalRead<OrchestrationView>('/local/v1/orchestration', 1500);
  const music = useLocalRead<MusicView>('/local/v1/music', 2000);
  const [advanced, setAdvanced] = useState(false);
  const [draft, setDraft] = useState<OrchestrationPreset | null>(null);
  const [message, setMessage] = useState('');
  const [audition, setAudition] = useState('opening');
  const [lastPlayed, setLastPlayed] = useState<{ shot: string; context: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const config = draft ?? current?.preset;
  const currentMap = current?.preset.maps.find((map) => map.map === current.status.map);
  const shots = [
    ...(currentMap?.opening
      ? [{ value: 'opening', label: `开场 · ${currentMap.opening.macro}` }]
      : []),
    ...CAMERA_STAGES.flatMap((stage) =>
      currentMap?.stages[stage]
        ? [
            {
              value: stage,
              label: `${stage === 'warmup' ? '热身' : MUSIC_LABELS[stage]} · ${currentMap.stages[stage]!.macro}`,
            },
          ]
        : [],
    ),
    ...(['tactical', 'technical'] as const).flatMap((stage) =>
      (currentMap?.pauseCandidates[stage] ?? []).map((shot, index) => ({
        value: `${stage}:${index}`,
        label: `${MUSIC_LABELS[stage]} · ${shot.macro}`,
      })),
    ),
    ...(currentMap?.rounds.map((shot, index) => ({
      value: `round:${index}`,
      label: `回合 · ${shot.macro}`,
    })) ?? []),
  ];
  const selectedShot = shots.some((shot) => shot.value === audition) ? audition : shots[0]?.value;
  const shotIndex = shots.findIndex((shot) => shot.value === selectedShot);
  const playDisabled =
    busy ||
    !current?.ready ||
    !current.status.connected ||
    !current.status.isolated ||
    !selectedShot ||
    Boolean(current.status.current) ||
    current.status.preparation === 'preparing';
  const tracks = [
    ...new Map(
      Object.values(music?.config.groups ?? {})
        .flatMap((g) => g.tracks)
        .map((t) => [t.id, t]),
    ).values(),
  ];
  const action = async (run: () => Promise<void> | void) => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      await run();
    } catch (e) {
      setFailed(true);
      setMessage(
        e instanceof SyntaxError || (e instanceof Error && e.name === 'ZodError')
          ? '预设格式或内容有误，请检查后重试。'
          : e instanceof Error
            ? e.message
            : '操作未完成，请重试。',
      );
    } finally {
      setBusy(false);
    }
  };
  const update = (index: number, patch: Partial<CameraMap>) => {
    if (config)
      setDraft({
        ...config,
        maps: config.maps.map((m, i) => (i === index ? { ...m, ...patch } : m)),
      });
  };
  const play = (shot = selectedShot) =>
    void action(async () => {
      if (!current || !shot) return;
      const [stage, index] = shot.split(':');
      await command('/operator/orchestration', {
        action: 'audition',
        stage,
        ...(index !== undefined ? { index: Number(index) } : {}),
        expected: { context: current.status.context, connection: current.status.connection },
      });
      setLastPlayed({ shot, context: current.status.context });
      setMessage('播放请求已提交，请在游戏内核对。');
    });
  return (
    <Panel>
      <h2>{advanced ? '管理与编辑预设' : '运镜设置'}</h2>
      {advanced ? <Button onClick={() => setAdvanced(false)}>返回运镜设置</Button> : null}
      {!advanced ? (
        <>
          <CameraControls simple />
          <h3>当前预设</h3>
          <p>{current?.preset.name ?? '正在读取预设…'}</p>
          <p>适用地图：{current?.preset.maps.map((map) => map.map).join('、') || '暂无'}</p>
          <Field
            label="导入预设到草稿"
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file)
                void action(async () => {
                  if (file.size > 256 * 1024)
                    throw new Error('预设文件过大，请选择小于 256 KiB 的文件。');
                  setDraft(orchestrationPresetSchema.parse(JSON.parse(await file.text())));
                  setMessage('已载入配置草稿，请确认镜头和音频资源可用后保存。');
                  setAdvanced(true);
                });
            }}
          />
          <p>导入后可检查并保存预设。</p>
          <section aria-label="试播">
            <h3>试播</h3>
            <p>试播当前地图已保存的镜头，播放后保持手动运镜。</p>
            <p>当前地图：{current?.status.map ?? '等待游戏数据'}</p>
            <Select
              label="试播镜头"
              value={selectedShot ?? ''}
              onChange={(e) => setAudition(e.target.value)}
            >
              {!shots.length ? <option value="">当前地图暂无镜头</option> : null}
              {shots.map((shot) => (
                <option key={shot.value} value={shot.value}>
                  {shot.label}
                </option>
              ))}
            </Select>
            <Button disabled={playDisabled} onClick={() => play()}>
              播放
            </Button>
            {lastPlayed?.shot === selectedShot &&
            lastPlayed?.context === current?.status.context ? (
              <Button disabled={playDisabled} onClick={() => play()}>
                重播
              </Button>
            ) : null}
            <Button
              disabled={playDisabled || shotIndex <= 0}
              onClick={() => {
                const shot = shots[shotIndex - 1]!.value;
                setAudition(shot);
                play(shot);
              }}
            >
              上一条
            </Button>
            <Button
              disabled={playDisabled || shotIndex < 0 || shotIndex >= shots.length - 1}
              onClick={() => {
                const shot = shots[shotIndex + 1]!.value;
                setAudition(shot);
                play(shot);
              }}
            >
              下一条
            </Button>
            {current?.status.current ? (
              <Button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await command('/operator/orchestration', { action: 'hold' });
                    setMessage('已请求停止，请在游戏内核对。');
                  })
                }
              >
                停止
              </Button>
            ) : null}
            {current && !current.status.connected ? <p>请先连接运镜工具。</p> : null}
            {current?.status.connected && !current.status.isolated ? (
              <p>请先准备当前地图的镜头。</p>
            ) : null}
          </section>
          <Button onClick={() => setAdvanced(true)}>管理与编辑预设</Button>
        </>
      ) : (
        <>
          <CameraControls setup />
          <section id="mulnx-launch" aria-label="MulNX 启动管理">
            <MulnxToolControls tool={current?.tool} />
            <MulnxHandoff />
          </section>
          <p>在 MulNX 载入本图镜头包后连接。开场音效随开场画面播放；其他音乐在声音设置中配置。</p>
          {current && !current.ready ? (
            <StatusBanner tone="danger">
              运镜预设无法读取，请检查本机数据目录后重启服务。
            </StatusBanner>
          ) : null}
          {!config ? (
            <p role="status">正在读取运镜设置</p>
          ) : (
            <>
              <Field
                label="预设名称"
                value={config.name}
                onChange={(e) => setDraft({ ...config, name: e.target.value })}
              />
              <div className="settings-grid">
                {config.maps.map((map, index) => (
                  <Panel className="settings-card" key={index}>
                    <Field
                      label="地图"
                      placeholder="de_…"
                      value={map.map}
                      onChange={(e) => update(index, { map: e.target.value })}
                    />
                    {current?.tool?.packs.length ? (
                      <Select
                        label="运镜包"
                        value={map.pack}
                        onChange={(e) => update(index, { pack: e.target.value })}
                      >
                        <option value="">选择运镜包</option>
                        {map.pack && !current.tool.packs.some((p) => p.name === map.pack) ? (
                          <option value={map.pack}>{map.pack}</option>
                        ) : null}
                        {current.tool.packs.map((p) => (
                          <option key={p.name} value={p.name}>
                            {p.sourceName}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Field
                        label="镜头包名称"
                        value={map.pack}
                        onChange={(e) => update(index, { pack: e.target.value })}
                      />
                    )}
                    <Shot
                      label="开场镜头名称"
                      shot={map.opening}
                      change={(opening) => update(index, { opening })}
                    />
                    <Select
                      label="本图开场音效"
                      value={map.openingSound?.id ?? ''}
                      onChange={(e) =>
                        update(index, {
                          openingSound: tracks.find((t) => t.id === e.target.value) ?? null,
                        })
                      }
                    >
                      <option value="">沿用开场短音效</option>
                      {map.openingSound && !tracks.some((t) => t.id === map.openingSound!.id) ? (
                        <option value={map.openingSound.id}>{map.openingSound.name}</option>
                      ) : null}
                      {tracks.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </Select>
                    <details>
                      <summary>回合开局 · 随机列表（{map.rounds.length}）</summary>
                      {map.rounds.map((shot, i) => (
                        <div key={i}>
                          <Shot
                            label={`候选 ${i + 1}`}
                            shot={shot}
                            change={(next) =>
                              update(index, {
                                rounds: next
                                  ? map.rounds.map((s, j) => (i === j ? next : s))
                                  : map.rounds.filter((_, j) => i !== j),
                              })
                            }
                          />
                          <Button
                            onClick={() =>
                              update(index, { rounds: map.rounds.filter((_, j) => i !== j) })
                            }
                          >
                            移除候选 {i + 1}
                          </Button>
                        </div>
                      ))}
                      <Button
                        disabled={map.rounds.length >= 64}
                        onClick={() =>
                          update(index, { rounds: [...map.rounds, { macro: '', maxMs: 6000 }] })
                        }
                      >
                        添加候选
                      </Button>
                    </details>
                    {(['tactical', 'technical'] as const).map((stage) => (
                      <details key={stage}>
                        <summary>
                          {MUSIC_LABELS[stage]}候选（{map.pauseCandidates[stage].length}）
                        </summary>
                        {map.pauseCandidates[stage].map((shot, i) => (
                          <Shot
                            key={i}
                            label={`候选 ${i + 1}`}
                            shot={shot}
                            change={(next) =>
                              update(index, {
                                pauseCandidates: {
                                  ...map.pauseCandidates,
                                  [stage]: next
                                    ? map.pauseCandidates[stage].map((item, j) =>
                                        i === j ? next : item,
                                      )
                                    : map.pauseCandidates[stage].filter((_, j) => i !== j),
                                },
                              })
                            }
                          />
                        ))}
                        <Button
                          disabled={map.pauseCandidates[stage].length >= 64}
                          onClick={() =>
                            update(index, {
                              pauseCandidates: {
                                ...map.pauseCandidates,
                                [stage]: [
                                  ...map.pauseCandidates[stage],
                                  { macro: '', maxMs: 6000 },
                                ],
                              },
                            })
                          }
                        >
                          添加候选
                        </Button>
                      </details>
                    ))}
                    <details>
                      <summary>其他比赛阶段</summary>
                      {CAMERA_STAGES.map((stage) => (
                        <Shot
                          key={stage}
                          label={stage === 'warmup' ? '热身' : MUSIC_LABELS[stage]}
                          shot={map.stages[stage]}
                          change={(shot) =>
                            update(index, { stages: { ...map.stages, [stage]: shot } })
                          }
                        />
                      ))}
                    </details>
                    <Button
                      onClick={() =>
                        setDraft({ ...config, maps: config.maps.filter((_, i) => i !== index) })
                      }
                    >
                      移除地图
                    </Button>
                  </Panel>
                ))}
              </div>
              <Button
                disabled={busy || config.maps.length >= 32}
                onClick={() =>
                  setDraft({
                    ...config,
                    maps: [
                      ...config.maps,
                      {
                        ...cameraMapSchema.parse({ map: 'de_placeholder', pack: 'placeholder' }),
                        map: '',
                        pack: '',
                      },
                    ],
                  })
                }
              >
                添加地图
              </Button>
              <Button
                variant="primary"
                disabled={busy || !current?.ready}
                onClick={() =>
                  void action(async () => {
                    const preset = orchestrationPresetSchema.parse(config);
                    await command('/operator/orchestration', { action: 'configure', preset });
                    setDraft(preset);
                    setMessage('已保存；自动运镜需重新启用。');
                  })
                }
              >
                保存并应用预设
              </Button>
              <details>
                <summary>导入与导出</summary>
                <p>请先准备对应的镜头和音频资源，再保存预设。</p>
                <Field
                  label="导入预设到草稿"
                  type="file"
                  accept=".json,application/json"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file)
                      void action(async () => {
                        if (file.size > 256 * 1024) throw new Error('预设超过 256 KiB');
                        setDraft(orchestrationPresetSchema.parse(JSON.parse(await file.text())));
                        setMessage('已载入配置草稿，请确认镜头和音频资源可用后保存。');
                      });
                  }}
                />
                <Button
                  disabled={busy}
                  onClick={() =>
                    void action(() => {
                      const preset = orchestrationPresetSchema.parse(config);
                      const url = URL.createObjectURL(
                        new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' }),
                      );
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = 'mizar-orchestration.json';
                      a.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                      setMessage('已导出预设。');
                    })
                  }
                >
                  导出预设
                </Button>
              </details>
              <details>
                <summary>连接说明</summary>
                <p>打开 MulNX 后，在游戏内载入本图镜头包，再连接并试播。换图或重连后请重新确认。</p>
              </details>
            </>
          )}
        </>
      )}
      {message ? <StatusBanner tone={failed ? 'danger' : 'info'}>{message}</StatusBanner> : null}
    </Panel>
  );
}
