import { useState } from 'react';
import { PROGRAM_SCENES, type ProgramSceneId } from '@mizar/protocol/program-scenes';
import { useProgramScenes } from '../workspace/client';
import { Button, Panel, Select } from '../ui';
import { ToolShell } from '../patterns';
import { openTool } from './client';
import './preparation.css';

export function ProgramPreview({ standalone = false }: { standalone?: boolean }) {
  const [preview, setPreview] = useState<ProgramSceneId>('waiting');
  const scenes = useProgramScenes();
  const [variant, setVariant] = useState('default');
  const [version, setVersion] = useState(0);
  return (
    <Panel>
      {standalone ? null : <h2>节目预览</h2>}
      <p>选择场景检查画面；正式切换在现场进行。</p>
      <div className="preparation-scenes">
        {PROGRAM_SCENES.map((scene) => (
          <Button
            key={scene.id}
            aria-pressed={preview === scene.id}
            onClick={() => setPreview(scene.id)}
          >
            {scene.title} · {scenes?.available.includes(scene.id) ? '就绪' : '不可用'}
          </Button>
        ))}
      </div>
      <p>
        {scenes?.blocked[preview] ??
          `当前播出：${PROGRAM_SCENES.find((item) => item.id === scenes?.active)?.title ?? '等待连接'}`}
      </p>
      <Select label="画面样例" value={variant} onChange={(event) => setVariant(event.target.value)}>
        <option value="default">默认 · 真实回放衍生</option>
        <option value="bo1">BO1 版式</option>
        <option value="bo5">BO5 版式</option>
        <option value="no-media">无队标 / 头像</option>
        <option value="long-names">长名称</option>
      </Select>
      <Button onClick={() => setVersion((value) => value + 1)}>重播开场</Button>
      <div className="preparation-program-preview">
        <iframe
          key={`${preview}:${variant}:${version}`}
          title="节目预览"
          src={
            PROGRAM_SCENES.find((scene) => scene.id === preview)!.path +
            `?preview=1&variant=${variant}`
          }
        />
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
        <h1>节目预览</h1>
        <ProgramPreview standalone />
      </main>
    </ToolShell>
  );
}
