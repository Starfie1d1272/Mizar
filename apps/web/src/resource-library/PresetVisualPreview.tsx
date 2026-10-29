import { useMemo, useState, useSyncExternalStore } from 'react';
import { parseModuleRecord, type ModuleRecord } from '@mizar/broadcast-config';
import { resolveHudPreset } from '@mizar/hud-config';
import { PROGRAM_SCENES, type ProgramSceneId } from '@mizar/protocol/program-scenes';
import { ProgramView } from '@mizar/hud-view';
import { bpPreviewSnapshot } from '../bp/preview';
import { HudCanvasPreview } from '../operator/HudCanvasPreview';
import { getHudEditorFixture } from '../program/fixtures';
import { radarSnapshotForProgramFixture } from '../program/fixtures/radar-fixtures';
import { presentationPreview, programPreviewSnapshot } from '../program/presentation-preview';
import { Select } from '../ui';
import '../operator/hud-console.css';

type Binding = { kind: string; mode: 'off' } | { kind: string; mode: 'use'; moduleId: string };
type Entry = { id: string; kind: string; value?: unknown };

const motionQuery = '(prefers-reduced-motion: reduce)';
const subscribeMotion = (notify: () => void) => {
  const query = window.matchMedia(motionQuery);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};
const readReducedMotion = () => window.matchMedia(motionQuery).matches;

/** Read saved visual modules only; no device or active-configuration operation is needed. */
export function PresetVisualPreview({
  bindings,
  modules,
}: {
  bindings: Binding[];
  modules: Entry[];
}) {
  const [scene, setScene] = useState<ProgramSceneId>('gameplay');
  const reducedMotion = useSyncExternalStore(subscribeMotion, readReducedMotion, () => false);
  const visuals = useMemo(() => {
    const get = (kind: 'hud' | 'program'): ModuleRecord | null => {
      const binding = bindings.find((item) => item.kind === kind);
      if (!binding || binding.mode !== 'use') return null;
      const entry = modules.find((item) => item.id === binding.moduleId && item.kind === kind);
      if (!entry) return null;
      try {
        return parseModuleRecord(entry);
      } catch {
        return null;
      }
    };
    const hud = get('hud');
    const program = get('program');
    if (
      !hud ||
      hud.kind !== 'hud' ||
      !('preset' in hud.value) ||
      !program ||
      program.kind !== 'program'
    )
      return null;
    try {
      return {
        hud: resolveHudPreset(hud.value.preset, hud.value.layout, hud.value.theme),
        overlays: hud.value.overlays,
        accent: hud.value.accent,
        program: program.value,
      };
    } catch {
      return null;
    }
  }, [bindings, modules]);
  const fixture = useMemo(() => getHudEditorFixture('epl-live'), []);
  const radar = useMemo(() => radarSnapshotForProgramFixture('epl-live'), []);
  const selected = scene === 'gameplay' ? null : visuals?.program.scenes[scene];
  const supported =
    scene === 'gameplay' ||
    (selected?.kind === 'builtin' &&
      selected.id === 'pulse' &&
      selected.apiVersion === 1 &&
      Object.keys(visuals?.program.tokens ?? {}).length === 0 &&
      Object.keys(visuals?.program.assets ?? {}).length === 0);
  return (
    <section className="resource-library__preview" aria-label="方案画面预览">
      <div className="resource-library__preview-heading">
        <div>
          <h3>画面预览</h3>
          <p>模拟画面 · 示例比赛数据</p>
        </div>
        <Select
          label="节目场景"
          value={scene}
          onChange={(event) => setScene(event.currentTarget.value as ProgramSceneId)}
        >
          {PROGRAM_SCENES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </Select>
      </div>
      {!visuals || !fixture ? (
        <p>画面配置暂不可预览。</p>
      ) : !supported ? (
        <p>此场景暂不支持预览。</p>
      ) : (
        <div className="resource-library__preview-frame" aria-label="示例画面" data-scene={scene}>
          {scene === 'gameplay' ? (
            <HudCanvasPreview
              resolvedPreset={visuals.hud}
              overlays={visuals.overlays}
              accent={visuals.accent}
              snapshot={fixture}
              radarSnapshot={radar}
              mapBackground
              connectionState="live"
              liveSource={false}
              editorMode="preview"
              editorInteractive={false}
              selectedWidgetId={null}
              showGrid={false}
              showCenter={false}
              showSafeArea={false}
            />
          ) : (
            <div className="resource-library__preview-canvas">
              {scene === 'bp' ? (
                <ProgramView
                  kind="bp"
                  snapshot={bpPreviewSnapshot}
                  animate={false}
                  compact={false}
                />
              ) : (
                <ProgramView
                  kind="scene"
                  sceneId={scene}
                  data={presentationPreview(scene, null)}
                  snapshot={programPreviewSnapshot('gameplay', null)}
                  scenes={null}
                  resolvedPreset={visuals.hud}
                  overlays={visuals.overlays}
                  accent={visuals.accent}
                  preview
                  shortIntro={false}
                  previewBackground
                  reducedMotion={reducedMotion}
                />
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
