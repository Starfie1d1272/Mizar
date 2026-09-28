import { useState } from 'react';
import { PROGRAM_SCENES, type ProgramSceneId } from '@mizar/protocol/program-scenes';
import { useProgramScenes } from '../workspace/client';
import { Button, Panel } from '../ui';
import { ToolShell } from '../patterns';
import { openTool } from './client';
import './preparation.css';

export function ProgramPreview({ standalone = false }: { standalone?: boolean }) {
  const [preview, setPreview] = useState<ProgramSceneId>('waiting');
  const scenes = useProgramScenes();
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
      <div className="preparation-program-preview">
        <iframe
          title="节目预览"
          src={PROGRAM_SCENES.find((scene) => scene.id === preview)!.path + '?preview=1'}
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
