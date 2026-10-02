import { useState } from 'react';
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
            onClick={() => setPreview(scene.id)}
          >
            {scene.title}
          </Button>
        ))}
      </div>
      {preview !== 'bp' ? (
        <div className="program-preview-options">
          <Select
            label="画面样例"
            value={variant}
            onChange={(event) => setVariant(event.target.value)}
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
                onChange={(event) => setBackground(event.target.value)}
              >
                <option value="map">地图静态背景示意</option>
                <option value="transparent">透明底（OBS 叠加）</option>
              </Select>
              <Select
                label="开场时长"
                value={intro}
                onChange={(event) => setIntro(event.target.value)}
              >
                <option value="full">完整 · 6 秒</option>
                <option value="short">短版 · 2 秒</option>
              </Select>
              <Button onClick={() => setVersion((value) => value + 1)}>重播开场</Button>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="program-preview-workspace" data-scene={preview}>
        <div className="preparation-program-preview">
          <iframe
            key={`${preview}:${variant}:${version}:${background}:${intro}`}
            title="节目预览"
            src={
              PROGRAM_SCENES.find((scene) => scene.id === preview)!.path +
              (preview === 'bp'
                ? ''
                : `?preview=1&variant=${variant}&background=${background}&intro=${intro}`)
            }
          />
        </div>
        {preview === 'bp' ? <BpWorkspaceControls /> : null}
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
