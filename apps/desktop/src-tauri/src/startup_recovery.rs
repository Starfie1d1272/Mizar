//! Native, explicit configuration recovery when the local service cannot start.
//! No WebView, launch, game close, production completion or automatic file writes.
use crate::{
    managed_cs2::{ManagedCs2, StartupRecoveryStatus},
    startup_log::DesktopLog,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Check,
    Restore,
    ConfirmSteam,
    RetryStartup,
    Logs,
    Exit,
}
fn actions(status: &Result<StartupRecoveryStatus, String>) -> Vec<Action> {
    let mut actions = vec![Action::Check];
    if let Ok(status) = status {
        if status.pending && status.permits_restore(true).is_ok() {
            actions.push(if status.uncertain {
                Action::ConfirmSteam
            } else {
                Action::Restore
            });
        }
        // Never restart the recovery-capable Host during a game or pending launch.
        if !status.running && !status.uncertain {
            actions.push(Action::RetryStartup);
        }
    }
    actions.extend([Action::Logs, Action::Exit]);
    actions
}
fn status_message(status: &Result<StartupRecoveryStatus, String>) -> String {
    match status {
        Err(error) => format!("恢复状态无法确认，未修改配置。{error} 请重新检查，或查看本机日志。"),
        Ok(status) if status.running => "CS2 正在运行，本次仅检查。可以继续当前游戏；正常退出游戏后再重新检查配置恢复。".into(),
        Ok(status) if status.requires_service => "Demo 试播隔离状态需要制播服务确认，本次不恢复配置。请修复制播服务启动问题后，再在准备中心恢复。".into(),
        Ok(status) if status.uncertain => "Steam 启动结果待确认。先取消 Steam 启动请求并确认 CS2 已关闭，再明确确认恢复；Mizar 不会在此关闭游戏。".into(),
        Ok(status) if status.pending => "发现未完成的配置恢复，原始备份仍保留。可在游戏关闭后恢复配置备份；失败时保留记录并显示具体原因。".into(),
        Ok(_) => "未发现待恢复记录。可以重试启动，或查看本机日志定位服务启动失败。".into(),
    }
}
fn choose(
    instruction: &str,
    content: &str,
    details: &str,
    choices: &[Action],
) -> Result<Action, String> {
    use windows::{
        core::PCWSTR,
        Win32::UI::Controls::{
            TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION,
        },
    };
    let wide = |text: &str| {
        text.chars()
            .take(8000)
            .filter(|c| *c != '\0')
            .collect::<String>()
            .encode_utf16()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let title = wide("Mizar 启动与配置恢复");
    let instruction = wide(instruction);
    let content = wide(content);
    let details = wide(details);
    let expand = wide("查看启动原因与日志位置");
    let labels = choices
        .iter()
        .map(|choice| {
            wide(match choice {
                Action::Check => "重新检查",
                Action::Restore => "恢复配置备份",
                Action::ConfirmSteam => "确认已取消 Steam 请求并恢复",
                Action::RetryStartup => "重试启动 Mizar",
                Action::Logs => "查看本机日志",
                Action::Exit => "退出",
            })
        })
        .collect::<Vec<_>>();
    let buttons = choices
        .iter()
        .zip(&labels)
        .map(|(choice, label)| TASKDIALOG_BUTTON {
            nButtonID: 1001 + *choice as i32,
            pszButtonText: PCWSTR(label.as_ptr()),
        })
        .collect::<Vec<_>>();
    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION,
        pszWindowTitle: PCWSTR(title.as_ptr()),
        pszMainInstruction: PCWSTR(instruction.as_ptr()),
        pszContent: PCWSTR(content.as_ptr()),
        pszExpandedInformation: PCWSTR(details.as_ptr()),
        pszExpandedControlText: PCWSTR(expand.as_ptr()),
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        nDefaultButton: 1001 + Action::Exit as i32,
        ..Default::default()
    };
    let mut selected = 0;
    unsafe { TaskDialogIndirect(&config, Some(&mut selected), None, None) }
        .map_err(|error| format!("配置恢复对话框无法打开。{error:?}"))?;
    Ok(choices
        .iter()
        .find(|choice| 1001 + **choice as i32 == selected)
        .copied()
        .unwrap_or(Action::Exit))
}

/// Returning true only requests another normal startup; recovery never starts it.
pub fn show(log: &DesktopLog, startup_error: &str) -> bool {
    let first_line = startup_error.lines().next().unwrap_or(startup_error);
    let reason = first_line
        .strip_prefix("runtime_ready: ")
        .or_else(|| first_line.strip_prefix("runtime_spawn: "))
        .unwrap_or(first_line)
        .chars()
        .take(360)
        .collect::<String>();
    let mut managed = ManagedCs2::new(log.clone());
    let mut feedback = String::new();
    loop {
        let status = managed.startup_recovery_status();
        let content = format!(
            "启动原因：{reason}\n\n{}\n\n{feedback}",
            status_message(&status)
        );
        let details = format!("原启动失败：{startup_error}\n\n本机日志目录：{}\n\n原始日志与配置只供本机检查，请勿公开整个数据目录。服务恢复后，从运行诊断导出脱敏诊断包反馈。", log.directory.display());
        let choice = match choose("Mizar 启动未完成", &content, &details, &actions(&status)) {
            Ok(choice) => choice,
            Err(error) => {
                log.event("cs2_startup_recovery", "failure", Some(&error));
                crate::windows_startup::failure_dialog(startup_error, Some(&log.directory));
                return false;
            }
        };
        match choice {
            Action::Check => (),
            Action::Exit => return false,
            Action::Logs => {
                if let Err(error) =
                    crate::windows_startup::open_recovery_target(&log.directory.to_string_lossy())
                {
                    feedback = format!("日志目录无法打开。{error}");
                    log.event("cs2_startup_recovery", "failure", Some(&feedback));
                }
            }
            Action::RetryStartup => {
                // Recheck after the dialog: a late game must cancel this request.
                match managed.startup_recovery_status() {
                    Ok(status) if !status.running && !status.uncertain => return true,
                    result => feedback = status_message(&result),
                }
            }
            Action::Restore | Action::ConfirmSteam => {
                if choice == Action::ConfirmSteam {
                    match choose("确认 Steam 请求已取消且游戏已关闭", "请先在 Steam 取消启动请求，并确认所有 CS2 窗口已关闭。只有完成这些操作后才选择恢复；返回不会修改配置。", "恢复前会重新检查游戏进程。原始备份和恢复记录不会因取消而删除。", &[Action::ConfirmSteam, Action::Exit]) {
                        Ok(Action::ConfirmSteam) => (),
                        Ok(_) => continue,
                        Err(error) => { feedback = error; continue; }
                    }
                }
                match managed.restore_at_startup(choice == Action::ConfirmSteam) {
                    Ok(()) => {
                        feedback =
                            "配置恢复检查已完成，原始备份仍保留。此操作只恢复配置，不结束制作。"
                                .into();
                        log.event("cs2_startup_recovery", "success", None);
                    }
                    Err(error) => {
                        log.event("cs2_startup_recovery", "failure", Some(&error));
                        feedback = format!("配置恢复未完成：{error} 处理原因后重新检查或重试。");
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unavailable_running_or_demo_recovery_never_offers_unsafe_restore() {
        for state in [
            Err("无法确认进程".into()),
            Ok(StartupRecoveryStatus {
                pending: true,
                running: true,
                ..Default::default()
            }),
            Ok(StartupRecoveryStatus {
                pending: true,
                requires_service: true,
                ..Default::default()
            }),
        ] {
            let offered = actions(&state);
            assert!(!offered.contains(&Action::Restore));
            assert!(!offered.contains(&Action::ConfirmSteam));
        }
        let waiting = Ok(StartupRecoveryStatus {
            pending: true,
            uncertain: true,
            ..Default::default()
        });
        assert!(actions(&waiting).contains(&Action::ConfirmSteam));
        assert!(!actions(&waiting).contains(&Action::Restore));
        assert!(!actions(&waiting).contains(&Action::RetryStartup));
        assert!(!actions(&Ok(StartupRecoveryStatus {
            running: true,
            ..Default::default()
        }))
        .contains(&Action::RetryStartup));
    }
}
