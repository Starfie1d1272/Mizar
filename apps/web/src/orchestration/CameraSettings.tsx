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
            label="最多持续（毫秒）"
            type="number"
            min={500}
            max={60000}
            value={shot.maxMs}
            onChange={(e) => change({ ...shot, maxMs: Number(e.target.value) })}
          />
        </details>
      ) : null}
    </div>
  );
}
export function CameraSettings() {
  const current = useLocalRead<OrchestrationView>('/local/v1/orchestration', 1500);
  const music = useLocalRead<MusicView>('/local/v1/music', 2000);
  const [draft, setDraft] = useState<OrchestrationPreset | null>(null);
  const [message, setMessage] = useState('');
  const [audition, setAudition] = useState('opening');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const config = draft ?? current?.preset;
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
      setMessage(e instanceof Error ? e.message : '预设操作未完成');
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
  return (
    <Panel>
      <h2>地图自动编排</h2>
      <CameraControls setup />
      <section id="mulnx-launch" aria-label="MulNX 启动管理">
        <MulnxToolControls tool={current?.tool} />
        <MulnxHandoff />
      </section>
      <details>
        <summary>游戏内筛选</summary>
        <p>试播使用当前地图已保存的镜头；结束后仍保持人工模式。</p>
        <Select label="试播镜头" value={audition} onChange={(e) => setAudition(e.target.value)}>
          <option value="opening">开场</option>
          {CAMERA_STAGES.map((stage) => (
            <option key={stage} value={stage}>
              {stage === 'warmup' ? '热身' : MUSIC_LABELS[stage]}
            </option>
          ))}
          {current?.preset.maps
            .find((m) => m.map === current.status.map)
            ?.rounds.map((shot, index) => (
              <option key={index} value={`round:${index}`}>
                {shot.macro}
              </option>
            ))}
        </Select>
        <Button
          disabled={
            busy ||
            !current?.ready ||
            !current.status.connected ||
            !current.status.isolated ||
            Boolean(current.status.current)
          }
          onClick={() =>
            void action(async () => {
              if (!current) return;
              const [stage, index] = audition.split(':');
              await command('/operator/orchestration', {
                action: 'audition',
                stage,
                ...(index ? { index: Number(index) } : {}),
                expected: {
                  context: current.status.context,
                  connection: current.status.connection,
                },
              });
              setMessage('试播请求已提交，请在游戏内核对。');
            })
          }
        >
          确认活动隔离包并试播
        </Button>
      </details>
      <p>先在 MulNX 载入本图专用隔离包。开场音效跟随实际开场画面；阶段音乐在音乐设置中配置。</p>
      {current && !current.ready ? (
        <StatusBanner tone="danger">运镜预设无法读取，请检查本机数据目录后重启服务。</StatusBanner>
      ) : null}
      {!config ? (
        <p role="status">等待本机编排服务</p>
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
                    label="MulNX 活动包名称"
                    value={map.pack}
                    onChange={(e) => update(index, { pack: e.target.value })}
                  />
                )}
                <Shot
                  label="开场宏"
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
                <details>
                  <summary>其他比赛阶段</summary>
                  {CAMERA_STAGES.map((stage) => (
                    <Shot
                      key={stage}
                      label={stage === 'warmup' ? '热身' : MUSIC_LABELS[stage]}
                      shot={map.stages[stage]}
                      change={(shot) => update(index, { stages: { ...map.stages, [stage]: shot } })}
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
            保存预设
          </Button>
          <details>
            <summary>导入与导出</summary>
            <p>JSON 只包含宏名称与本机音频引用，不含资源文件。换机先导入对应音乐包，再保存预设。</p>
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
                    setMessage('已载入草稿，请检查后保存。');
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
            <summary>联调说明</summary>
            <p>
              打开 MulNX 后，在游戏内载入所选隔离包，再连接并试播。每次换图或重连后重新确认。
              外部安装可使用 prepare-pack 工具准备资源。
            </p>
          </details>
        </>
      )}
      {message ? (
        <StatusBanner tone={failed ? 'danger' : 'info'}>
          {failed ? '预设未应用，请检查字段、文件与本机音频。' : message}
        </StatusBanner>
      ) : null}
    </Panel>
  );
}
