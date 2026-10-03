import { useCallback, useEffect, useMemo, useState } from 'react';
import { useBpSession } from '../bp/client';
import { ScenePreviewViewport, type PreviewFrame } from './ScenePreviewViewport';
import { BpWorkspaceControls } from '../bp/BpPage';
import { PROGRAM_SCENES, type ProgramSceneId } from '@mizar/protocol/program-scenes';
import { Button, Panel, Select } from '../ui';
import { ToolShell } from '../patterns';
import { openTool } from './client';
import './preparation.css';

export function ProgramPreview({ standalone = false }: { standalone?: boolean }) {
  const [preview, setPreview] = useState<ProgramSceneId>(() => {
    const scene = new URLSearchParams(window.location.search).get('scene');
    return PROGRAM_SCENES.find((item) => item.id === scene)?.id ?? 'waiting';
  });
  const [variant, setVariant] = useState('default');
  const [version, setVersion] = useState(0);
  const [background, setBackground] = useState('map');
  const [intro, setIntro] = useState('full');
  const [immediate, setImmediate] = useState(false);
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const [demo, setDemo] = useState<readonly ProgramSceneId[] | null>(null);
  const [demoIndex, setDemoIndex] = useState(0);
  const { snapshot: bp } = useBpSession();
  const frame = useMemo<PreviewFrame>(
    () => ({
      key: `${preview}:${variant}:${version}:${background}:${intro}`,
      scene: preview,
      src:
        PROGRAM_SCENES.find((scene) => scene.id === preview)!.path +
        (preview === 'bp'
          ? ''
          : `?preview=1&variant=${variant}&background=${background}&intro=${intro}`),
      immediate,
    }),
    [preview, variant, version, background, intro, immediate],
  );
  const onSettled = useCallback((key: string) => setSettledKey(key), []);
  function chooseScene(scene: ProgramSceneId, cut = false) {
    setDemo(null);
    setImmediate(cut);
    setPreview(scene);
    setVersion((value) => value + 1);
  }
  function startDemo() {
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
      {standalone ? null : <h2>节目预览</h2>}
      <p>
        切换场景查看同一套播出版式。等待页使用 Rivals 历史赛程，BP
        使用当前播放会话，其余页面使用真实遥测样例。
      </p>
      <div className="preparation-scenes">
        {PROGRAM_SCENES.map((scene) => (
          <Button
            key={scene.id}
            aria-pressed={preview === scene.id}
            onClick={() => chooseScene(scene.id)}
          >
            {scene.title}
          </Button>
        ))}
      </div>
      <div className="program-preview-playback">
        <Button onClick={demo ? () => setDemo(null) : startDemo}>
          {demo ? '停止连续演示' : '连续演示转场'}
        </Button>
        <Button onClick={() => chooseScene('gameplay', true)}>立即切入比赛预览</Button>
        <span role="status">
          {demo
            ? `演示 ${demoIndex + 1} / ${demo.length} · ${PROGRAM_SCENES.find((scene) => scene.id === preview)!.title}`
            : '静态页停留 3 秒，开场按所选时长；仅预览，不控制播出。'}
        </span>
      </div>
      {!bp?.projection || bp.state === 'hidden' || bp.state === 'hiding' ? (
        <p>当前 BP 未显示，连续演示将跳过 BP。BP 标签中的播放与收起会影响当前播出会话。</p>
      ) : null}
      {preview !== 'bp' ? (
        <div className="program-preview-options">
          <Select
            label="画面样例"
            value={variant}
            onChange={(event) => {
              setDemo(null);
              setVariant(event.target.value);
            }}
          >
            <option value="default">默认 · 完整资料</option>
            <option value="no-schedule">等待页 · 无邻近赛程</option>
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
                <option value="map">地图静态背景示意</option>
                <option value="transparent">透明底（OBS 叠加）</option>
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
      <div className="program-preview-workspace" data-scene={demo ? 'demo' : preview}>
        <ScenePreviewViewport frame={frame} onSettled={onSettled} />
        <div hidden={preview !== 'bp' || demo !== null}>
          <p>当前 BP 播出控制：播放、收起及切换演示来源会同步影响 OBS 的 BP 画面。</p>
          <BpWorkspaceControls />
        </div>
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
      <main className="preparation">
        <ProgramPreview standalone />
      </main>
    </ToolShell>
  );
}
