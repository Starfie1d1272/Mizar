import type { CameraModuleV2, CameraSourceRef } from '@mizar/broadcast-config';
import { CAMERA_STAGES, cameraMapSchema, type CameraShot } from '@mizar/protocol/orchestration';
import { MUSIC_LABELS } from '../music/MusicControls';
import { Shot } from '../orchestration/CameraShotField';
import { Button, Checkbox, Field, Panel, Select } from '../ui';

export function CameraModuleEditor({
  value,
  onChange,
  onSave,
  busy,
  sources,
}: {
  value: CameraModuleV2;
  onChange: (value: CameraModuleV2) => void;
  onSave: () => void;
  busy: boolean;
  sources: CameraSourceRef[];
}) {
  const availableSources = [...sources, ...value.maps.map((map) => map.source)].filter(
    (source, i, all) =>
      all.findIndex((item) => JSON.stringify(item) === JSON.stringify(source)) === i,
  );
  const sounds = value.maps
    .flatMap((map) => (map.openingSound ? [map.openingSound] : []))
    .filter(
      (sound, i, all) =>
        all.findIndex((item) => JSON.stringify(item) === JSON.stringify(sound)) === i,
    );
  const update = (index: number, patch: Partial<CameraModuleV2['maps'][number]>) =>
    onChange({
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
    <div>
      <h3>编辑运镜</h3>
      <p>保存为草稿，不会改变当前播出。启用前请确认镜头和音频来源可用。</p>
      <Field
        label="预设名称"
        value={value.name}
        onChange={(e) => onChange({ ...value, name: e.target.value })}
      />
      <Checkbox
        label="开启自动运镜"
        checked={value.automaticEnabled}
        onChange={(e) => onChange({ ...value, automaticEnabled: e.target.checked })}
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
                availableSources.findIndex(
                  (source) => JSON.stringify(source) === JSON.stringify(map.source),
                ),
              )}
              onChange={(e) => {
                const source = availableSources[Number(e.target.value)];
                if (source) update(index, { source });
              }}
            >
              {availableSources.map((source, i) => (
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
              onClick={() => onChange({ ...value, maps: value.maps.filter((_, i) => i !== index) })}
            >
              移除地图
            </Button>
          </Panel>
        ))}
      </div>
      <Button
        disabled={busy || value.maps.length >= 32 || availableSources.length === 0}
        onClick={() =>
          (() => {
            const source = availableSources[0];
            if (!source) return;
            const { opening, rounds, pauseCandidates, stages } = cameraMapSchema.parse({
              map: 'de_placeholder',
              pack: 'placeholder',
            });
            onChange({
              ...value,
              maps: [
                ...value.maps,
                { map: '', source, openingSound: null, opening, rounds, pauseCandidates, stages },
              ],
            });
          })()
        }
      >
        添加地图
      </Button>
      {availableSources.length === 0 && <p>请先导入含运镜来源的资源。</p>}
      <Button variant="primary" disabled={busy} onClick={onSave}>
        保存草稿
      </Button>
    </div>
  );
}
