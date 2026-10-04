/** Offline visual exchange only; no runtime client or telemetry adapter. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getBuiltinResolvedPreset } from '@mizar/hud-config';
import '@mizar/design-tokens/tokens.css';
import { GameplayHud } from '../program/GameplayHud';
import { getProgramFixture, type ProgramFixtureId } from '../program/fixtures';
import { radarSnapshotForProgramFixture } from '../program/fixtures/radar-fixtures';
import '../program/program-scenes.css';
import './perfectworld.css';

const scenes: readonly { id: ProgramFixtureId; label: string }[] = [
  { id: 'real-live-rich', label: '实战 · 完整 5v5' },
  { id: 'real-planting', label: '实战 · 下包' },
  { id: 'real-planted', label: '实战 · 已下包' },
  { id: 'real-defusing', label: '实战 · 拆包与阵亡' },
  { id: 'real-post-explosion-freezetime', label: '实战 · 冻结期' },
  { id: 'real-timeout-ct', label: '实战 · 暂停' },
  { id: 'focused-avatar', label: '展示样本 · 头像' },
  { id: 'focused-low-health-edge', label: '展示样本 · 低血量' },
  { id: 'objective-unavailable-edge', label: '边界样本 · 计时不可用' },
];

// Offline references keep existing local/data images and remove remote dependencies.
function offlineValue<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, item: unknown) => {
      if ((key === 'avatarUrl' || key === 'logoUrl') && typeof item === 'string') {
        if (/^https?:/.test(item)) return null;
        if (item.startsWith('/')) return `.${item}`;
      }
      return item;
    }),
  ) as T;
}
const samples = scenes.map((scene) => ({
  ...scene,
  snapshot: offlineValue(getProgramFixture(scene.id)!),
  radarSnapshot: radarSnapshotForProgramFixture(scene.id),
}));
const preset = getBuiltinResolvedPreset('builtin:perfectworld-preset');

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Preview() {
  const [index, setIndex] = useState(0);
  const sample = samples[index]!;
  const [scale, setScale] = useState(Math.min(1, (window.innerWidth - 32) / 1920));
  return (
    <>
      <header className="reference-controls">
        <strong>上海 / 类 Perfect World · 展示参考</strong>
        <select
          aria-label="参考场景"
          value={index}
          onChange={(event) => setIndex(Number(event.target.value))}
        >
          {scenes.map((scene, i) => (
            <option key={scene.id} value={i}>
              {scene.label}
            </option>
          ))}
        </select>
        <button
          onClick={() => setScale(scale === 1 ? Math.min(1, (window.innerWidth - 32) / 1920) : 1)}
        >
          原尺寸 / 适应窗口
        </button>
        <button
          onClick={() =>
            download(
              `${sample.id}.html`,
              document.querySelector('.gameplay-hud')!.outerHTML,
              'text/html',
            )
          }
        >
          导出当前 DOM
        </button>
        <button
          onClick={() =>
            download(`${sample.id}.json`, JSON.stringify(sample, null, 2), 'application/json')
          }
        >
          导出展示数据
        </button>
        <span>固定样本，计时不会自动推进；C4 呼吸动画可直接预览。</span>
      </header>
      <main className="reference-stage" style={{ width: 1920 * scale, height: 1080 * scale }}>
        <div className="reference-canvas" style={{ transform: `scale(${scale})` }}>
          <GameplayHud
            snapshot={sample.snapshot}
            radarSnapshot={sample.radarSnapshot}
            resolvedPreset={preset}
            presentationRevision={index}
          />
        </div>
      </main>
    </>
  );
}
// Build-time exporter reads the same samples used by this preview.
Object.assign(window, { perfectworldReference: { samples, preset } });
createRoot(document.getElementById('root')!).render(<Preview />);
