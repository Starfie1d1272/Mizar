import { PROGRAM_SCENES, type ProgramSceneState } from '@mizar/protocol/program-scenes';

export interface NextSceneCardProps {
  readonly director: ProgramSceneState['director'] | undefined;
  readonly bpActive?: boolean;
}

export function NextSceneCard({ director, bpActive = false }: NextSceneCardProps) {
  const mode = director?.mode;
  const paused = mode === 'manual' || mode === 'blocked';
  const next = PROGRAM_SCENES.find((scene) => scene.id === director?.next);

  const typeLabel =
    mode === 'manual'
      ? '手动保持'
      : mode === 'blocked'
        ? '自动暂停'
        : mode === 'auto'
          ? next
            ? next.mode === 'gameplay_overlay'
              ? '游戏叠加'
              : '全屏图文'
            : director?.nextStatus === 'complete'
              ? '本场结束'
              : '待定'
          : '准备中';

  const title =
    mode === 'manual'
      ? '恢复自动后继续编排'
      : mode === 'blocked'
        ? '处理问题后恢复自动'
        : (next?.title ?? (director?.nextStatus === 'complete' ? '本场结束' : '待确认'));

  const reason =
    mode === 'auto'
      ? (director?.nextReason ?? (next?.id === 'bp' && bpActive ? '正在进行地图禁选' : null))
      : mode === 'blocked'
        ? (director?.reason ?? null)
        : null;

  return (
    <div
      className="workspace-next-card"
      data-mode={mode ?? 'pending'}
      data-scene-mode={mode === 'auto' && next ? next.mode : undefined}
      data-scene-id={mode === 'auto' && next ? next.id : undefined}
    >
      <div className="workspace-next-card-header">
        <span
          className="workspace-next-card-badge"
          data-tone={mode === 'blocked' ? 'warning' : undefined}
        >
          {typeLabel}
        </span>
        <small>{paused ? '自动推进已暂停' : '下一场景'}</small>
      </div>
      <div className="workspace-next-card-body">
        <strong>{title}</strong>
        {reason ? <small className="workspace-next-card-reason">{reason}</small> : null}
      </div>
    </div>
  );
}
