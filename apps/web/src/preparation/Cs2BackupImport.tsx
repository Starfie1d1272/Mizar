import { useState } from 'react';
import { Button, Checkbox, StatusBanner } from '../ui';
import { ControlTask } from '../debug/control-task';
import { desktopInvoke } from '../workspace/client';
import type { DesktopResult } from '@mizar/protocol/desktop-ipc';

type Selection = NonNullable<DesktopResult<'manage_cs2_backup'>>;

export function Cs2BackupImport() {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function run(action: 'select' | 'apply' | 'apply-hud' | 'cancel') {
    const applying = action === 'apply' || action === 'apply-hud';
    if (busy || (applying && (!confirmed || !selection))) return;
    setBusy(true);
    setMessage('');
    const task = new ControlTask('backup_import', 'user', {
      action,
      selectionId: selection?.selectionId ?? null,
    });
    try {
      const next = await desktopInvoke(
        'manage_cs2_backup',
        { action, selectionId: selection?.selectionId ?? null },
        task,
      );
      if (applying) {
        const after = await desktopInvoke('cs2_config_status', undefined, task);
        const complete = !after.busy && !after.pending && !after.running;
        task.finish(complete ? 'confirmed' : 'unconfirmed', { after });
        setMessage(
          complete
            ? action === 'apply-hud'
              ? '已写回原 H 键。请打开 CS2 确认。'
              : '设置已恢复，恢复前的原件已保存。'
            : '恢复尚未结束，请查看上方恢复状态。',
        );
      } else {
        task.finish(next ? 'confirmed' : 'cancelled', { selectionId: next?.selectionId ?? null });
      }
      setSelection(next);
      setConfirmed(false);
    } catch (error) {
      task.fail(error);
      setMessage(error instanceof Error ? error.message : '备份恢复未完成，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="cs2-backup-import" aria-busy={busy}>
      <Button disabled={busy} onClick={() => void run('select')}>
        {busy ? '正在处理…' : '选择画面备份'}
      </Button>
      {selection ? (
        <div className="cs2-backup-preview">
          <div className="cs2-backup-account">
            {selection.avatar ? (
              <img src={selection.avatar} alt="Steam 头像" />
            ) : (
              <span>头像未缓存</span>
            )}
            <strong>{selection.nickname}</strong>
          </div>
          <p>
            {selection.sourceName} · {selection.includesFrameRate ? '画质与帧率' : '画质设置'}
          </p>
          <p>
            {selection.includesHudKey
              ? '包含本账号的原 H 键，可单独恢复。'
              : '此备份没有可核实的原 H 键，请在 CS2 键位设置中核对。'}
          </p>
          <p className="settings-conflict-files">{selection.targetPath}</p>
          <Checkbox
            label={`恢复到 ${selection.nickname} 的上述配置`}
            message="先保存当前原件，再恢复备份中的相关设置。"
            checked={confirmed}
            disabled={busy}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <div className="settings-actions">
            <Button disabled={busy || !confirmed} onClick={() => void run('apply')}>
              恢复画面设置
            </Button>
            {selection.includesHudKey ? (
              <Button disabled={busy || !confirmed} onClick={() => void run('apply-hud')}>
                恢复原 H 键
              </Button>
            ) : null}
            <Button disabled={busy} onClick={() => void run('cancel')}>
              取消
            </Button>
          </div>
        </div>
      ) : null}
      {message ? <StatusBanner tone="info">{message}</StatusBanner> : null}
    </div>
  );
}
