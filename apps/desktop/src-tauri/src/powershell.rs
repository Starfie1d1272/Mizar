use crate::{cs2_diagnostics, startup_log::DesktopLog};
use serde_json::Value;
use std::{
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const OUTPUT_LIMIT: usize = 64 * 1024;

// Keep canonical paths for safety checks; PowerShell 5.1's filesystem provider
// rejects the verbatim drive prefix returned by Rust canonicalize().
pub fn provider_path(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc}"))
    } else if let Some(disk) = value.strip_prefix(r"\\?\") {
        PathBuf::from(disk)
    } else {
        path.to_path_buf()
    }
}

fn drain(mut reader: impl Read) -> io::Result<Vec<u8>> {
    let mut kept = Vec::new();
    let mut buffer = [0; 4096];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let retain = count.min(OUTPUT_LIMIT.saturating_sub(kept.len()));
        kept.extend_from_slice(&buffer[..retain]);
        truncated |= retain < count;
    }
    if truncated {
        kept.extend_from_slice(b"\n[output truncated at 64 KiB]");
    }
    Ok(kept)
}

fn redact(log: &DesktopLog, text: &str) -> String {
    let mut value = text.to_owned();
    if let Ok(token) = std::fs::read_to_string(log.state_root.join("data/gsi-token.txt")) {
        if !token.trim().is_empty() {
            value = value.replace(token.trim(), "[redacted]");
        }
    }
    value
        .lines()
        .map(|line| {
            let lower = line.to_lowercase();
            if [
                "password",
                "token",
                "authorization",
                "api_key",
                "apikey",
                "secret",
            ]
            .iter()
            .any(|key| lower.contains(key))
            {
                "[credential-bearing line redacted]"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn diagnostic(log: &DesktopLog, operation: &str, phase: &str, detail: &str) {
    let clean = redact(log, detail);
    let mut rest = clean.as_str();
    let mut part = 0;
    loop {
        let mut end = rest.len().min(6000);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        log.event(
            "powershell",
            "failure",
            Some(&format!(
                "operation={operation}; phase={phase}; part={part}\n{}",
                &rest[..end]
            )),
        );
        rest = &rest[end..];
        if rest.is_empty() {
            break;
        }
        part += 1;
    }
}

fn failed(log: &DesktopLog, operation: &str, phase: &str, detail: &str) -> String {
    diagnostic(log, operation, phase, detail);
    format!("{operation}失败（{phase}）。请重试；详细错误见 state/logs/desktop.ndjson，可通过高级设置中的诊断与支持反馈。")
}

pub fn run(
    mut command: Command,
    log: &DesktopLog,
    operation: &str,
    timeout: Duration,
) -> Result<String, String> {
    command
        .env_remove("PSModulePath")
        .env("MIZAR_STATE_ROOT", provider_path(&log.state_root))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| failed(log, operation, "启动工具", &format!("{e}\n{e:?}")))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    // Drain both pipes while the process runs, so verbose errors cannot fill a
    // pipe and be misreported as a timeout. Retained memory is bounded.
    let out = thread::spawn(move || drain(stdout));
    let err = thread::spawn(move || drain(stderr));
    let deadline = Instant::now() + timeout;
    let mut wait_error = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            other => {
                wait_error = Some(match other {
                    Err(e) => format!("{e}\n{e:?}"),
                    _ => format!("timeout after {timeout:?}"),
                });
                if let Err(e) = child.kill() {
                    diagnostic(log, operation, "终止工具", &format!("{e:?}"));
                }
                break child.wait().ok();
            }
        }
    };
    let collect = |handle: thread::JoinHandle<io::Result<Vec<u8>>>| -> Result<Vec<u8>, String> {
        handle
            .join()
            .map_err(|e| failed(log, operation, "读取输出", &format!("{e:?}")))?
            .map_err(|e| failed(log, operation, "读取输出", &format!("{e:?}")))
    };
    let stdout_result = collect(out);
    let stderr_result = collect(err);
    let stdout = stdout_result?;
    let stderr = stderr_result?;
    let exit = format!("exit={:?}", status.and_then(|s| s.code()));
    let unsuccessful = wait_error.is_some() || !status.is_some_and(|s| s.success());
    if unsuccessful || !stderr.is_empty() {
        diagnostic(
            log,
            operation,
            "stderr",
            &format!("{exit}\n{}", String::from_utf8_lossy(&stderr)),
        );
    }
    if unsuccessful {
        diagnostic(
            log,
            operation,
            "stdout",
            &format!("{exit}\n{}", String::from_utf8_lossy(&stdout)),
        );
        if let Some(reason) = wait_error {
            return Err(failed(log, operation, "等待工具", &reason));
        }
        return Err(format!(
            "{operation}失败。{} 详细错误见 state/logs/desktop.ndjson。",
            cs2_diagnostics::failure(&stdout)
        ));
    }
    String::from_utf8(stdout).map_err(|e| failed(log, operation, "解析输出编码", &format!("{e:?}")))
}

pub fn parse(log: &DesktopLog, operation: &str, output: &str) -> Result<Value, String> {
    serde_json::from_str(output.trim())
        .map_err(|e| failed(log, operation, "解析结果", &format!("{e:?}\n{output}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;

    #[test]
    fn canonical_paths_keep_the_same_location_for_powershell() {
        assert_eq!(
            provider_path(Path::new(r"\\?\D:\Mizar 中文\state")),
            PathBuf::from(r"D:\Mizar 中文\state")
        );
        assert_eq!(
            provider_path(Path::new(r"\\?\UNC\server\share\state")),
            PathBuf::from(r"\\server\share\state")
        );
    }

    #[test]
    fn failures_keep_stderr_exit_and_parse_evidence_without_deadlock_or_token_leaks() {
        let root = std::env::temp_dir().join(format!("mizar-shell-log-{}", std::process::id()));
        let log = DesktopLog::new(&root, None).unwrap();
        std::fs::create_dir_all(log.state_root.join("data")).unwrap();
        std::fs::write(
            log.state_root.join("data/gsi-token.txt"),
            "test-private-credential",
        )
        .unwrap();
        let command = |script: &str| {
            let mut c = Command::new("powershell.exe");
            c.args(["-NoProfile", "-NonInteractive", "-Command", script])
                .creation_flags(0x08000000);
            c
        };
        let error = run(command("[Console]::Error.WriteLine('original-failure test-private-credential'); [Console]::Out.Write(('x' * 70000)); exit 7"), &log, "GSI 检测", Duration::from_secs(15)).unwrap_err();
        assert!(error.contains("GSI 检测"));
        assert!(!error.contains("original-failure"));
        assert!(run(
            command("[Console]::Error.WriteLine('before-timeout'); Start-Sleep -Seconds 10"),
            &log,
            "超时检查",
            Duration::from_secs(2)
        )
        .is_err());
        let status_script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../scripts/qualification/bundle/gsi-status.ps1");
        let invocation = format!(
            "$env:MIZAR_STATE_ROOT='relative'; & '{}'",
            status_script.to_string_lossy().replace('\'', "''")
        );
        assert!(run(
            command(&invocation),
            &log,
            "初始化检查",
            Duration::from_secs(15)
        )
        .is_err());
        assert!(parse(&log, "结果检查", "not-json").is_err());
        let text = std::fs::read_to_string(log.directory.join("desktop.ndjson")).unwrap();
        for expected in [
            "original-failure",
            "exit=Some(7)",
            "output truncated",
            "before-timeout",
            "not-json",
            "common.ps1",
        ] {
            assert!(text.contains(expected), "missing {expected}");
        }
        assert!(!text.contains("test-private-credential"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
