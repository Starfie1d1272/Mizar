import type { ProductionGuidance } from '@mizar/protocol/program-scenes';
import { useLocalRead, type Production } from '../preparation/client';
import { desktopInvoke } from './client';
import { useObsStatus } from './obs-client';
import { useState } from 'react';
import './workspace.css';

export function ProductionStatus({ matchId }: { matchId?: string | null }) {
  const response = useLocalRead<ProductionGuidance>('/local/v1/production-guidance', 5000);
  const production = useLocalRead<Production>('/local/v1/production');
  const obs = useObsStatus();
  const [error, setError] = useState('');
  const guidance = matchId !== undefined && response?.matchId !== matchId ? null : response;
  const connected = obs?.connection === 'connected';
  const obsText =
    !obs || !connected
      ? '无法确认'
      : obs.streaming
        ? obs.sceneAligned !== true || obs.findings.length > 0
          ? '需检查'
          : '正常'
        : '未推流';
  const platformText = !guidance
    ? '无法确认'
    : ({ live: '正常', offline: '未开播', unknown: '无法确认', unconfigured: '未设置' } as const)[
        guidance.bilibili
      ];
  const reminder =
    guidance?.broadcastAssigned &&
    (production?.mode === 'live' || production?.mode === 'hidden') &&
    guidance.phase === 'live' &&
    connected &&
    obs?.streaming === false;
  return (
    <section className="production-status" aria-label="当前任务与直播状态">
      <div className="production-status__signals" aria-label="直播状态">
        <span data-tone={obsText === '正常' ? 'success' : 'muted'}>OBS {obsText}</span>
        <span data-tone={platformText === '正常' ? 'success' : 'muted'}>
          Bilibili {platformText}
        </span>
      </div>
      <strong>{guidance?.task ?? '正在读取制作状态'}</strong>
      {guidance ? (
        <>
          {guidance.result && ['map_end', 'match_end'].includes(guidance.phase) ? (
            <p>{guidance.result}</p>
          ) : null}
          {guidance.nextMap && guidance.phase !== 'live' ? (
            <p>下一图 · {guidance.nextMap.replace(/^de_/, '')}</p>
          ) : null}
          {guidance.nextStep ? <p>{guidance.nextStep}</p> : null}
          {guidance.interMapReminder ? (
            <p role="status">图间已超过 10 分钟，请确认下一图准备情况。</p>
          ) : null}
          {reminder ? <p role="status">比赛进行中，OBS 未推流，请检查 OBS。</p> : null}
          {guidance.rivalhubUrl && ['map_end', 'match_end'].includes(guidance.phase) ? (
            <a
              href={guidance.rivalhubUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                if (!window.__TAURI_INTERNALS__) return;
                event.preventDefault();
                void desktopInvoke('open_rivalhub_workbench', { url: guidance.rivalhubUrl }).catch(
                  () => setError('打开失败，请在浏览器中访问 RivalHub。'),
                );
              }}
            >
              {guidance.phase === 'match_end'
                ? '打开 RivalHub 完成赛后任务'
                : '打开 RivalHub 本场工作台'}
            </a>
          ) : null}
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
