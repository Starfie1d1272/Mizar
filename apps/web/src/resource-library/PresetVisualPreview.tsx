import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { parseModuleRecord, type ModuleRecord } from '@mizar/broadcast-config';
import { getBuiltinResolvedPreset, resolveHudPreset } from '@mizar/hud-config';
import {
  pulseBackgroundUrl,
  pulseTokenStyle,
  supportsProgramScene,
} from '../program/broadcast-display';
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
  mode = 'preset',
}: {
  bindings: Binding[];
  modules: Entry[];
  mode?: 'preset' | 'hud' | 'program';
}) {
  const [scene, setScene] = useState<ProgramSceneId>(mode === 'program' ? 'waiting' : 'gameplay');
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
    let resolvedHud = null;
    if (hud?.kind === 'hud' && 'preset' in hud.value) {
      try {
        resolvedHud = {
          config: resolveHudPreset(hud.value.preset, hud.value.layout, hud.value.theme),
          overlays: hud.value.overlays,
          accent: hud.value.accent,
        };
      } catch {
        // Other scenes can still be previewed when the HUD is unavailable.
      }
    }
    return { hud: resolvedHud, program: program?.kind === 'program' ? program.value : null };
  }, [bindings, modules]);
  const backgroundUrl = visuals.program ? pulseBackgroundUrl(visuals.program) : null;
  const [backgroundStatus, setBackgroundStatus] = useState<{ url: string; ready: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (!backgroundUrl) return;
    let active = true;
    setBackgroundStatus(null);
    void fetch(backgroundUrl)
      .then((response) => {
        if (active)
          setBackgroundStatus({
            url: backgroundUrl,
            ready: response.ok && !!response.headers.get('content-type')?.startsWith('image/'),
          });
      })
      .catch(() => {
        if (active) setBackgroundStatus({ url: backgroundUrl, ready: false });
      });
    return () => {
      active = false;
    };
  }, [backgroundUrl]);
  const fixture = useMemo(() => getHudEditorFixture('epl-live'), []);
  const radar = useMemo(() => radarSnapshotForProgramFixture('epl-live'), []);
  const supported =
    scene === 'gameplay'
      ? visuals.hud !== null
      : visuals.program !== null && supportsProgramScene(visuals.program, scene);

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
          {PROGRAM_SCENES.filter(
            (item) =>
              mode === 'preset' ||
              (mode === 'hud' ? item.id === 'gameplay' : item.id !== 'gameplay'),
          ).map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </Select>
      </div>
      {scene === 'gameplay' && (!visuals.hud || !fixture) ? (
        <p>画面配置暂不可预览。</p>
      ) : scene !== 'gameplay' && backgroundUrl && backgroundStatus?.url !== backgroundUrl ? (
        <p>正在读取场景背景。</p>
      ) : scene !== 'gameplay' && backgroundUrl && !backgroundStatus?.ready ? (
        <p>场景背景不可用，请重新导入或恢复资源。</p>
      ) : !supported ? (
        <p>
          {visuals.program &&
          Object.keys(visuals.program.assets).some((name) => name !== 'pulse.background')
            ? `不支持的场景图片槽：${Object.keys(visuals.program.assets)
                .filter((name) => name !== 'pulse.background')
                .join('、')}。`
            : visuals.program && pulseTokenStyle(visuals.program) === null
              ? '场景颜色包含不支持的字段或无效颜色，请检查资源。'
              : '此场景暂不支持预览。'}
        </p>
      ) : (
        <div className="resource-library__preview-frame" aria-label="示例画面" data-scene={scene}>
          {scene === 'gameplay' ? (
            <HudCanvasPreview
              resolvedPreset={visuals.hud!.config}
              overlays={visuals.hud!.overlays}
              accent={visuals.hud!.accent}
              snapshot={fixture!}
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
                  sceneStyle={
                    visuals.program ? (pulseTokenStyle(visuals.program) ?? undefined) : undefined
                  }
                  snapshot={bpPreviewSnapshot}
                  animate={false}
                  compact={false}
                />
              ) : (
                <ProgramView
                  kind="scene"
                  sceneStyle={
                    visuals.program ? (pulseTokenStyle(visuals.program) ?? undefined) : undefined
                  }
                  sceneId={scene}
                  data={presentationPreview(scene, null)}
                  snapshot={programPreviewSnapshot(scene, null)}
                  scenes={null}
                  resolvedPreset={visuals.hud?.config ?? getBuiltinResolvedPreset()}
                  overlays={visuals.hud?.overlays}
                  accent={visuals.hud?.accent}
                  preview
                  shortIntro={false}
                  previewBackground={!backgroundUrl}
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
