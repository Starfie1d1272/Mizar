import { useEffect, useRef, useState } from 'react';
import {
  CAMERA_STAGES,
  cameraMapSchema,
  orchestrationPresetSchema,
  type CameraMap,
  type CameraShot,
  type OrchestrationPreset,
  type OrchestrationView,
} from '@mizar/protocol/orchestration';
import { Button, Checkbox, Field, Panel, Select, StatusBanner } from '../ui';
import { command, useLocalRead, type Production } from '../preparation/client';
import { MUSIC_LABELS, type MusicView } from '../music/MusicControls';

function ImportPreset({ disabled, onFile }: { disabled: boolean; onFile: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        aria-label="导入预设到草稿"
        type="file"
        accept=".json,application/json"
        hidden
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onFile(file);
        }}
      />
      <Button disabled={disabled} onClick={() => input.current?.click()}>
        导入预设
      </Button>
    </>
  );
}

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
            onChange={(e) => {
              const milliseconds = Number(e.target.value) * 1000;
              const rounded = Math.round(milliseconds);
              change({
                ...shot,
                maxMs: Math.abs(milliseconds - rounded) < 1e-7 ? rounded : milliseconds,
              });
            }}
          />
        </details>
      ) : null}
    </div>
  );
}
export function CameraSettings() {
  const current = useLocalRead<OrchestrationView>('/local/v1/orchestration', 1500);
  const production = useLocalRead<Production>('/local/v1/production', 1500);
  const music = useLocalRead<MusicView>('/local/v1/music', 2000);
  const [advanced, setAdvanced] = useState(false);
  const [draft, setDraft] = useState<OrchestrationPreset | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<OrchestrationView | null>(null);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const operation = useRef(false);
  const editVersion = useRef(0);
  const [automaticOverride, setAutomaticOverride] = useState<boolean | null>(null);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!draft) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [draft]);
  useEffect(() => {
    if (automaticOverride !== null && current?.automaticEnabled === automaticOverride)
      setAutomaticOverride(null);
  }, [automaticOverride, current?.automaticEnabled]);
  useEffect(() => {
    if (automaticOverride === null) return;
    const timer = setTimeout(() => setAutomaticOverride(null), 5000);
    return () => clearTimeout(timer);
  }, [automaticOverride]);
  useEffect(() => {
    if (
      confirmed &&
      current &&
      current.activePresetId === confirmed.activePresetId &&
      JSON.stringify(current.presets) === JSON.stringify(confirmed.presets) &&
      JSON.stringify(current.preset) === JSON.stringify(confirmed.preset)
    )
      setConfirmed(null);
  }, [confirmed, current]);
  useEffect(() => {
    if (!confirmed) return;
    const timer = setTimeout(() => setConfirmed(null), 5000);
    return () => clearTimeout(timer);
  }, [confirmed]);
  const catalog = confirmed ?? current;
  const selected = selectedId ?? catalog?.activePresetId;
  const selectedPreset = catalog?.presets.find((item) => item.id === selected)?.preset;
  const config = draft ?? selectedPreset;
  const catalogFull = (catalog?.presets.length ?? 0) >= 32;
  const tracks = [
    ...new Map(
      Object.values(music?.config.groups ?? {})
        .flatMap((g) => g.tracks)
        .map((t) => [t.id, t]),
    ).values(),
  ];
  const action = async (run: () => Promise<void> | void) => {
    if (operation.current) return;
    operation.current = true;
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
      operation.current = false;
      setBusy(false);
    }
  };
  const updateCatalog = async (body: object) => {
    const result = (await command(
      '/operator/orchestration',
      body,
    )) as unknown as OrchestrationView & { createdPresetId?: string };
    if (!Array.isArray(result.presets) || !result.activePresetId)
      throw new Error('预设状态未确认，请重试。');
    setConfirmed(result);
    return result;
  };
  const create = (copy: boolean) =>
    void action(async () => {
      const version = editVersion.current;
      const result = await updateCatalog({
        action: 'create-preset',
        ...(copy ? { sourceId: selected } : {}),
      });
      if (!result.createdPresetId) throw new Error('新预设未确认，请重新打开管理页。');
      if (editVersion.current !== version) {
        setMessage('预设已创建，当前更改尚未保存。');
        return;
      }
      setSelectedId(result.createdPresetId);
      setDraft(null);
      setAdvanced(true);
      setMessage(copy ? '已复制预设，可继续编辑。' : '已新建预设，可继续编辑。');
    });
  const importFile = (file: File) =>
    void action(async () => {
      if (file.size > 256 * 1024) throw new Error('预设文件过大，请选择较小的文件。');
      const preset = orchestrationPresetSchema.parse(JSON.parse(await file.text()));
      const initialVersion = editVersion.current;
      const result = await updateCatalog({ action: 'create-preset' });
      if (!result.createdPresetId) throw new Error('新预设未确认，请重新打开管理页。');
      if (editVersion.current !== initialVersion) {
        await updateCatalog({ action: 'save-preset', id: result.createdPresetId, preset });
        setMessage('已导入草稿，当前更改尚未保存。');
        return;
      }
      setSelectedId(result.createdPresetId);
      setDraft(preset);
      const version = ++editVersion.current;
      setAdvanced(true);
      await updateCatalog({ action: 'save-preset', id: result.createdPresetId, preset });
      if (editVersion.current === version) {
        setDraft(null);
        setMessage('已导入并保存草稿，请在启用前确认镜头和音频资源。');
      } else setMessage('已保存导入内容，后续更改尚未保存。');
    });
  const edit = (next: OrchestrationPreset) => {
    editVersion.current++;
    setDraft(next);
    setMessage('');
    setFailed(false);
  };
  const update = (index: number, patch: Partial<CameraMap>) => {
    if (config)
      edit({
        ...config,
        maps: config.maps.map((m, i) => (i === index ? { ...m, ...patch } : m)),
      });
  };
  return (
    <Panel>
      <h2>{advanced ? '管理与编辑预设' : '运镜设置'}</h2>
      {advanced ? <Button onClick={() => setAdvanced(false)}>返回运镜设置</Button> : null}
      {current && !current.ready ? (
        <StatusBanner tone="danger">运镜预设无法读取，请检查本机数据目录后重启服务。</StatusBanner>
      ) : null}
      {!advanced ? (
        <>
          <Checkbox
            label="开启自动运镜"
            checked={automaticOverride ?? current?.automaticEnabled ?? false}
            disabled={busy || !current?.ready || production?.mode !== 'preparation'}
            message={
              production && production.mode !== 'preparation'
                ? '结束本场制作后可修改。'
                : '下次进入工作台时使用此设置。'
            }
            onChange={(event) => {
              const enabled = event.target.checked;
              void action(async () => {
                await command('/operator/orchestration', { action: 'set-automatic', enabled });
                setAutomaticOverride(enabled);
                setMessage('自动运镜设置已保存。');
              });
            }}
          />
          <h3>当前预设</h3>
          <p>{catalog?.preset.name ?? '正在读取预设…'}</p>
          <p>适用地图：{catalog?.preset.maps.map((map) => map.map).join('、') || '暂无'}</p>
          <Select
            label="选择预设"
            value={selected ?? ''}
            disabled={busy || Boolean(draft) || !catalog?.ready}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {catalog?.presets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.preset.name}
                {item.id === catalog.activePresetId ? '（当前）' : ''}
              </option>
            ))}
          </Select>
          {selectedPreset ? (
            <p>
              所选预设适用地图：{selectedPreset.maps.map((map) => map.map).join('、') || '暂无'}
            </p>
          ) : null}
          {catalog &&
          selected === catalog.activePresetId &&
          selectedPreset &&
          JSON.stringify(selectedPreset) !== JSON.stringify(catalog.preset) ? (
            <p>所选预设有已保存的更改，启用后生效。</p>
          ) : null}
          <Button
            disabled={busy || Boolean(draft) || !selected || !catalog?.ready}
            onClick={() =>
              void action(async () => {
                await updateCatalog({ action: 'activate-preset', id: selected });
                setMessage('预设已启用。');
              })
            }
          >
            启用所选预设
          </Button>
          <ImportPreset
            disabled={busy || Boolean(draft) || catalogFull || !catalog?.ready}
            onFile={importFile}
          />
          <p>导入后会保存为草稿，确认资源后可启用。</p>
          {catalogFull ? <p>预设已达到上限，请使用已有预设。</p> : null}
          {draft ? <p>有未保存的预设更改，可返回管理页继续编辑。</p> : null}
          <Button onClick={() => setAdvanced(true)}>管理与编辑预设</Button>
        </>
      ) : (
        <>
          {!config ? (
            <p role="status">正在读取运镜设置</p>
          ) : (
            <>
              <p>保存草稿后，可在运镜设置中启用。</p>
              {catalogFull ? <p>预设已达到上限，请使用已有预设。</p> : null}
              <Button
                disabled={busy || Boolean(draft) || !catalog?.ready || catalogFull}
                onClick={() => create(false)}
              >
                新建预设
              </Button>
              <Button
                disabled={busy || Boolean(draft) || !selected || !catalog?.ready || catalogFull}
                onClick={() => create(true)}
              >
                复制预设
              </Button>
              {draft ? (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setDraft(null);
                    setMessage('已放弃未保存的更改。');
                  }}
                >
                  放弃未保存更改
                </Button>
              ) : null}
              <Field
                label="预设名称"
                value={config.name}
                onChange={(e) => edit({ ...config, name: e.target.value })}
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
                          <div key={i}>
                            <Shot
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
                            <Button
                              onClick={() =>
                                update(index, {
                                  pauseCandidates: {
                                    ...map.pauseCandidates,
                                    [stage]: map.pauseCandidates[stage].filter((_, j) => i !== j),
                                  },
                                })
                              }
                            >
                              移除候选 {i + 1}
                            </Button>
                          </div>
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
                        edit({ ...config, maps: config.maps.filter((_, i) => i !== index) })
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
                  edit({
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
                    const version = editVersion.current;
                    await updateCatalog({ action: 'save-preset', id: selected, preset });
                    if (editVersion.current === version) {
                      setDraft(null);
                      setMessage('草稿已保存。');
                    } else setMessage('已保存本次内容，后续更改尚未保存。');
                  })
                }
              >
                保存草稿
              </Button>
              <details>
                <summary>导入与导出</summary>
                <p>启用前请确认镜头和音频资源可用。</p>
                <ImportPreset
                  disabled={busy || Boolean(draft) || catalogFull || !catalog?.ready}
                  onFile={importFile}
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
            </>
          )}
        </>
      )}
      {message ? <StatusBanner tone={failed ? 'danger' : 'info'}>{message}</StatusBanner> : null}
    </Panel>
  );
}
