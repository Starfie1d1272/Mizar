import type { ObsCaptureDiagnostic } from '@mizar/protocol/obs';
import { Button, StatusBanner } from '../ui';

export function ObsCaptureGuidance({
  diagnostic,
  busy,
  onCheck,
  expanded = false,
}: {
  diagnostic: ObsCaptureDiagnostic | null | undefined;
  busy: boolean;
  expanded?: boolean;
  onCheck: () => void;
}) {
  if (diagnostic?.state !== 'needs_attention') return null;
  const locked = diagnostic.reason === 'hook_file_locked';
  const message =
    diagnostic.reason === 'hook_pending'
      ? '正在等待游戏画面，请稍后重新检测并在 OBS 核对。'
      : '暂时没有取得游戏画面，请重新检测并在 OBS 核对。';
  return (
    <>
      <StatusBanner tone="warning">{message}</StatusBanner>
      <Button disabled={busy} loading={busy} onClick={onCheck}>
        重新检测画面
      </Button>
      <details className="obs-setup__help" open={expanded}>
        <summary>查看画面检查建议</summary>
        {diagnostic.reason === 'access_denied' ? (
          <p>
            打开 Windows「任务管理器 → 详细信息」，右键列标题，在「选择列」中勾选「已提升」，核对
            obs64.exe 与 cs2.exe。若 CS2 已提升而 OBS 未提升，先保存工作并停止输出，正常退出
            OBS，再由你手动选择「以管理员身份运行」并重新检测；Mizar
            不会自动提权。权限一致仍失败时导出诊断包，继续核对具体拒绝原因。
          </p>
        ) : locked ? (
          <p>
            OBS
            日志报告捕获文件被占用，占用程序尚未确定。若重新检测后仍无画面，先保存工作并停止输出，再正常退出并重开
            OBS。
          </p>
        ) : diagnostic.reason === 'hook_pending' ? (
          <p>游戏画面尚在初始化。先确认 CS2 已打开，稍后再检测，不必立即重启 OBS。</p>
        ) : (
          <p>
            先确认 CS2 已打开、OBS
            选中了正确的游戏窗口。仍无画面时，保存工作并停止输出，再正常退出并重开 OBS。
          </p>
        )}
        <p>
          重新检测后在 OBS 核对实际画面。仍无画面时，可在 OBS 临时添加「窗口采集」并选择
          CS2，检查画面与音频后再播出。
        </p>
      </details>
    </>
  );
}
