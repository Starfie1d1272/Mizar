import { useState } from 'react';
import { parseModuleRecord, type ModuleRecord } from '@mizar/broadcast-config';
import { CAMERA_STAGES, cameraMapSchema, type CameraShot } from '@mizar/protocol/orchestration';
import { MUSIC_LABELS } from '../music/MusicControls';
import { Shot } from '../orchestration/CameraShotField';
import { Button, Checkbox, Field, Panel, Select, StatusBanner } from '../ui';

type CameraRecord = Extract<ModuleRecord, { kind: 'camera' }>;

/** The parent owns persistence and must only render this editor for editable copies. */
export function CameraModuleEditor({
  module,
  modules = [module],
  busy,
  onDraftChange,
  save,
}: {
  module: CameraRecord;
  modules?: ModuleRecord[];
  busy: boolean;
  onDraftChange?: (value: CameraRecord['value']) => void;
  save: (value: ModuleRecord) => Promise<boolean>;
}) {
  const [value, setDraft] = useState(module.value);
  const setValue = (next: CameraRecord['value']) => {
    setDraft(next);
    onDraftChange?.(next);
  };
  const [error, setError] = useState(false);
  const maps = modules.flatMap((item) => (item.kind === 'camera' ? item.value.maps : []));
  const sources = maps
    .map((map) => map.source)
    .filter(
      (source, i, all) =>
        all.findIndex((item) => JSON.stringify(item) === JSON.stringify(source)) === i,
    );
  const sounds = [
    ...maps.flatMap((map) => (map.openingSound ? [map.openingSound] : [])),
    ...modules.flatMap((item) =>
      item.kind === 'music'
        ? Object.values(item.value.groups).flatMap((group) => group.tracks)
        : [],
    ),
  ].filter(
    (sound, i, all) =>
      all.findIndex((item) => JSON.stringify(item) === JSON.stringify(sound)) === i,
  );
  const update = (index: number, patch: Partial<CameraRecord['value']['maps'][number]>) =>
    setValue({
      ...value,
      maps: value.maps.map((map, i) => (i === index ? { ...map, ...patch } : map)),
    });
  const candidates = (
    label: string,
    shots: CameraShot[],
    change: (shots: CameraShot[]) => void,
  ) => (
    <details>
      <summary>
        {label}（{shots.length}）
      </summary>
      {shots.map((shot, i) => (
        <div key={i}>
          <Shot
            label={`候选 ${i + 1}`}
            shot={shot}
            change={(next) =>
              change(
                next
                  ? shots.map((item, j) => (i === j ? next : item))
                  : shots.filter((_, j) => i !== j),
              )
            }
          />
          <Button onClick={() => change(shots.filter((_, j) => i !== j))}>移除候选 {i + 1}</Button>
        </div>
      ))}
      <Button
        disabled={busy || shots.length >= 64}
        onClick={() => change([...shots, { macro: '', maxMs: 6000 }])}
      >
        添加候选
      </Button>
    </details>
  );
  return (
    <details>
      <summary>编辑运镜</summary>
      <p>保存为草稿，不会改变当前播出。启用前请确认镜头和音频来源可用。</p>
      <Field
        label="预设名称"
        value={value.name}
        onChange={(e) => setValue({ ...value, name: e.target.value })}
      />
      <Checkbox
        label="开启自动运镜"
        checked={value.automaticEnabled}
        onChange={(e) => setValue({ ...value, automaticEnabled: e.target.checked })}
      />
      <div className="settings-grid">
        {value.maps.map((map, index) => (
          <Panel className="settings-card" key={index}>
            <Field
              label="地图"
              placeholder="de_…"
              value={map.map}
              onChange={(e) => update(index, { map: e.target.value })}
            />
            <Select
              label="运镜包"
              value={String(
                sources.findIndex(
                  (source) => JSON.stringify(source) === JSON.stringify(map.source),
                ),
              )}
              onChange={(e) => {
                const source = sources[Number(e.target.value)];
                if (source) update(index, { source });
              }}
            >
              {sources.map((source, i) => (
                <option key={i} value={String(i)}>
                  {source.sourceName}
                </option>
              ))}
            </Select>
            <Shot
              label="开场镜头名称"
              shot={map.opening}
              change={(opening) => update(index, { opening })}
            />
            <Select
              label="本图开场音效"
              value={
                map.openingSound
                  ? String(
                      sounds.findIndex(
                        (sound) => JSON.stringify(sound) === JSON.stringify(map.openingSound),
                      ),
                    )
                  : ''
              }
              onChange={(e) =>
                update(index, {
                  openingSound:
                    e.target.value === '' ? null : (sounds[Number(e.target.value)] ?? null),
                })
              }
            >
              <option value="">沿用开场短音效</option>
              {sounds.map((sound, i) => (
                <option key={i} value={String(i)}>
                  {sound.name}
                </option>
              ))}
            </Select>
            {candidates('回合开局 · 随机列表', map.rounds, (rounds) => update(index, { rounds }))}
            {(['tactical', 'technical'] as const).map((stage) => (
              <div key={stage}>
                {candidates(`${MUSIC_LABELS[stage]}候选`, map.pauseCandidates[stage], (shots) =>
                  update(index, { pauseCandidates: { ...map.pauseCandidates, [stage]: shots } }),
                )}
              </div>
            ))}
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
              onClick={() => setValue({ ...value, maps: value.maps.filter((_, i) => i !== index) })}
            >
              移除地图
            </Button>
          </Panel>
        ))}
      </div>
      <Button
        disabled={busy || value.maps.length >= 32 || sources.length === 0}
        onClick={() =>
          (() => {
            const source = sources[0];
            if (!source) return;
            const {
              pack: _pack,
              openingSound: _sound,
              ...map
            } = cameraMapSchema.parse({ map: 'de_placeholder', pack: 'placeholder' });
            setValue({
              ...value,
              maps: [...value.maps, { ...map, map: '', source, openingSound: null }],
            });
          })()
        }
      >
        添加地图
      </Button>
      {sources.length === 0 && <p>此资源没有可复用的运镜来源，无法添加地图。</p>}
      {error && <StatusBanner tone="danger">预设格式或内容有误，请检查后重试。</StatusBanner>}
      <Button
        disabled={busy}
        onClick={() => {
          setValue(module.value);
          setError(false);
        }}
      >
        放弃未保存更改
      </Button>
      <Button
        variant="primary"
        disabled={busy}
        onClick={() => {
          try {
            const next = parseModuleRecord({ ...module, value });
            setError(false);
            void save(next);
          } catch {
            setError(true);
          }
        }}
      >
        保存草稿
      </Button>
    </details>
  );
}
