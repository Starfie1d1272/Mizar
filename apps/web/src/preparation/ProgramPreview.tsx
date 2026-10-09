import { useCallback, useEffect, useMemo, useState } from 'react';
import { useBpSession, useBpWorkspace } from '../bp/client';
import { ScenePreviewViewport, type PreviewFrame } from './ScenePreviewViewport';
import { PROGRAM_SCENES, type ProgramSceneId } from '@mizar/protocol/program-scenes';
import { Button, Panel, Select } from '../ui';
import { ToolShell } from '../patterns';
import { openTool } from './client';
import './preparation.css';

export function ProgramPreview({
  standalone = false,
  allowCurrent = false,
}: {
  standalone?: boolean;
  allowCurrent?: boolean;
}) {
  const [preview, setPreview] = useState<ProgramSceneId>(() => {
    const scene = new URLSearchParams(window.location.search).get('scene');
    return PROGRAM_SCENES.find((item) => item.id === scene)?.id ?? 'waiting';
  });
  const [source, setSource] = useState<'current' | 'sample'>(allowCurrent ? 'current' : 'sample');
  const [variant, setVariant] = useState('default');
  const [version, setVersion] = useState(0);
  const [background, setBackground] = useState('map');
  const [intro, setIntro] = useState('full');
  const [immediate, setImmediate] = useState(false);
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const [demo, setDemo] = useState<readonly ProgramSceneId[] | null>(null);
  const [demoIndex, setDemoIndex] = useState(0);
  const { snapshot: bp } = useBpSession();
  const { workspace } = useBpWorkspace();
  const frame = useMemo<PreviewFrame>(
    () => ({
      key: `${source}:${preview}:${variant}:${version}:${background}:${intro}`,
      scene: preview,
      src:
        PROGRAM_SCENES.find((scene) => scene.id === preview)!.path +
        (source === 'current'
          ? ''
          : preview === 'bp'
            ? '?preview=1'
            : `?preview=1&variant=${variant}&background=${background}&intro=${intro}`),
      immediate,
    }),
    [source, preview, variant, version, background, intro, immediate],
  );
  const onSettled = useCallback((key: string) => setSettledKey(key), []);
  function chooseScene(scene: ProgramSceneId, cut = false) {
    setDemo(null);
    setImmediate(cut);
    setPreview(scene);
    setVersion((value) => value + 1);
  }
  function startDemo() {
    setSource('sample');
    const order: ProgramSceneId[] = ['waiting'];
    if (bp?.projection && bp.state !== 'hidden' && bp.state !== 'hiding') order.push('bp');
    order.push(
      'matchup',
      'gameplay',
      'halftime',
      'gameplay',
      'map_result',
      'intermap',
      'match_result',
    );
    setImmediate(false);
    setDemo(order);
    setDemoIndex(0);
    setPreview('waiting');
    setVersion((value) => value + 1);
  }
  useEffect(() => {
    if (!demo || settledKey !== frame.key) return;
    const duration = preview === 'matchup' ? (intro === 'short' ? 2000 : 6000) : 3000;
    const timer = setTimeout(() => {
      const next = demo[demoIndex + 1];
      if (!next) {
        setDemo(null);
        return;
      }
      setDemoIndex((value) => value + 1);
      setPreview(next);
      setVersion((value) => value + 1);
    }, duration);
    return () => clearTimeout(timer);
  }, [demo, demoIndex, settledKey, frame.key, preview, intro]);
  return (
    <Panel className="program-preview-panel">
      {standalone ? null : <h2>画面检查 · 只读</h2>}
      {allowCurrent ? (
        <Select
          label="节目预览来源"
          value={source}
          onChange={(event) => {
            setDemo(null);
            setSource(event.target.value as 'current' | 'sample');
          }}
        >
          <option value="current">本场资料 / 当前观战数据（只读）</option>
          <option value="sample">版式样例（不是本场事实）</option>
        </Select>
      ) : null}
      <div className="preparation-scenes">
        {PROGRAM_SCENES.map((scene) => (
          <Button
            key={scene.id}
            variant={preview === scene.id ? 'primary' : 'secondary'}
            aria-pressed={preview === scene.id}
            onClick={() => chooseScene(scene.id)}
          >
            {scene.title}
          </Button>
        ))}
      </div>
      <div className="program-preview-toolbar">
        <div className="program-preview-playback">
          <Button onClick={demo ? () => setDemo(null) : startDemo}>
            {demo ? '停止演示' : '播放演示'}
          </Button>
          <Button onClick={() => chooseScene('gameplay', true)}>预览比赛画面</Button>
          <span role="status">
            {demo
              ? `演示 ${demoIndex + 1} / ${demo.length} · ${PROGRAM_SCENES.find((scene) => scene.id === preview)!.title}`
              : source === 'current'
                ? '本场服务数据 · 无数据时显示待确认，不替换为样例'
                : preview === 'bp'
                  ? workspace?.demo.active || workspace?.source === 'fixture'
                    ? 'BP 样例只读预览 · 不切换播出'
                    : workspace?.match
                      ? '本场 BP 只读预览 · 不切换播出'
                      : 'BP 来源待确认 · 只读预览'
                  : '版式样例 · 名单与比分不是本场核实资料'}
          </span>
        </div>
        {demo && (!bp?.projection || bp.state === 'hidden' || bp.state === 'hiding') ? (
          <p>演示将跳过 BP。</p>
        ) : null}
        {source === 'sample' && preview !== 'bp' ? (
          <div className="program-preview-options">
            <Select
              label="画面样例"
              value={variant}
              onChange={(event) => {
                setDemo(null);
                setVariant(event.target.value);
              }}
            >
              <option value="default">默认</option>
              <option value="no-schedule">无赛程</option>
              <option value="bo1">BO1 版式</option>
              <option value="bo5">BO5 版式</option>
              <option value="no-media">无队标 / 头像</option>
              <option value="long-names">长名称</option>
            </Select>
            {preview === 'matchup' ? (
              <>
                <Select
                  label="开场背景"
                  value={background}
                  onChange={(event) => {
                    setDemo(null);
                    setBackground(event.target.value);
                  }}
                >
                  <option value="map">地图背景</option>
                  <option value="transparent">透明背景</option>
                </Select>
                <Select
                  label="开场时长"
                  value={intro}
                  onChange={(event) => {
                    setDemo(null);
                    setIntro(event.target.value);
                  }}
                >
                  <option value="full">完整 · 6 秒</option>
                  <option value="short">短版 · 2 秒</option>
                </Select>
                <Button onClick={() => chooseScene('matchup')}>重播开场</Button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="program-preview-workspace" data-scene={demo ? 'demo' : preview}>
        <ScenePreviewViewport frame={frame} onSettled={onSettled} />
      </div>
      {standalone ? null : (
        <Button onClick={() => void openTool('preview')}>打开独立节目预览</Button>
      )}
    </Panel>
  );
}

export function ProgramPreviewTool() {
  return (
    <ToolShell title="节目预览">
      <main className="preparation preparation--preview">
        <ProgramPreview standalone />
      </main>
    </ToolShell>
  );
}
