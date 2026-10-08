use serde_json::{json, Value};

pub fn message(code: &str) -> &'static str {
    match code {
        "installation-not-found" => "未找到完整的 CS2 安装。请从 Steam 的「管理 → 浏览本地文件」确认位置，再选择安装目录或 cs2.exe。",
        "multiple-installations" => "发现多份 CS2 安装。请选择本次使用的安装目录或 cs2.exe，然后重新检查。",
        "selected-path-missing" => "已选择的 CS2 路径不存在。请确认磁盘已连接，或重新选择安装位置。",
        "selected-path-invalid" => "所选位置没有完整的 CS2 程序与配置目录。请选择安装根目录、game\\bin\\win64 或 cs2.exe。",
        "metadata-invalid" => "Steam 安装清单无法读取或解析。请打开 Steam 检查安装，或手动选择 CS2 安装位置。",
        "selection-unreadable" => "已保存的 CS2 位置无法读取。请重新选择安装位置。",
        "restore-before-selection" => "请先恢复当前 GSI 配置，再选择另一份 CS2 安装。原配置备份仍保留。",
        "gsi-file-missing" => "已安装的 Mizar GSI 文件缺失。请恢复原 GSI 配置，再重新安装。",
        "gsi-file-changed" => "Mizar GSI 文件与安装记录不一致。请先备份当前文件，再恢复原 GSI 配置并重新安装。",
        "record-unreadable" => "GSI 安装记录或配置文件无法读取。请检查文件访问权限并导出诊断包，保留现有文件和备份。",
        "endpoint-conflict" => "其他 GSI 配置也向 Mizar 的接收地址发送数据。点击「一键安装 / 修复 GSI」自动备份并停用重复配置。",
        "status-unreadable" => "无法检查 GSI 配置。请检查配置文件夹的访问权限，再重新检查或导出诊断包。",
        "access-denied" => "无法访问 CS2 配置或运行数据。请检查文件访问权限，再重试。",
        "steam-not-running" => "请先打开 Steam 并登录，再启动 CS2。",
        "steam-not-unique" => "无法确认唯一的 Steam 客户端。请退出多余的 Steam 进程，再重试。",
        "steam-account-unavailable" => "无法读取当前 Steam 账号。请在 Steam 中重新登录，再重试。",
        "video-config-missing" => "当前 Steam 账号还没有 CS2 视频配置。请用该账号从 Steam 运行一次 CS2，正常退出后重试。",
        "video-config-ambiguous" => "当前 Steam 账号存在多份视频配置。请检查 Steam 安装位置并导出诊断包。",
        _ => "配置工具发生内部错误。请在高级设置中导出诊断包并反馈问题；保留现有配置和备份。",
    }
}

pub fn failure(output: &[u8]) -> String {
    let value: Value = String::from_utf8_lossy(output)
        .lines()
        .rev()
        .find_map(|line| {
            serde_json::from_str::<Value>(line)
                .ok()
                .filter(|value| value["error"].is_object())
        })
        .unwrap_or(Value::Null);
    message(
        value["error"]["code"]
            .as_str()
            .unwrap_or("operation-failed"),
    )
    .into()
}

pub fn gsi_status(result: &Value) -> Value {
    let codes: Vec<&str> = result["issueCodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .take(16)
        .collect();
    json!({
        "detected": result["detected"] == true,
        "installed": result["installed"] == true,
        "conflict": result["conflict"] == true,
        "fileConflict": result["fileConflict"] == true,
        "endpointConflict": result["endpointConflict"] == true,
        "readFailed": result["readFailed"] == true,
        "cfgPath": result["cfgPath"].as_str(),
        "candidateCount": result["candidateCount"].as_u64().unwrap_or(0),
        "conflictCount": result["conflictCount"].as_u64().unwrap_or(0),
        "issues": codes.iter().map(|code| json!({"code":code,"message":message(code)})).collect::<Vec<_>>(),
        "conflictFiles": result["conflictFiles"].as_array().into_iter().flatten().filter_map(Value::as_str).take(32).collect::<Vec<_>>(),
        "lastOperation": result["lastOperation"].as_object().map(|value| json!({
            "code": value.get("code").and_then(Value::as_str),
            "stage": value.get("stage").and_then(Value::as_str)
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn errors_are_actionable_without_forwarding_raw_script_output() {
        assert!(failure(br#"{"error":{"code":"multiple-installations"}}"#).contains("请选择"));
        for output in [
            b"private-token C:\\Users\\secret".as_slice(),
            br#"{"error":{"code":"unknown-secret","message":"secret"}}"#,
        ] {
            assert!(!failure(output).contains("secret"));
        }
        let status = gsi_status(
            &json!({"readFailed":true,"issueCodes":["status-unreadable"],"gsiToken":"secret"}),
        );
        assert_eq!(status["conflict"], false);
        assert_eq!(status["readFailed"], true);
        assert_eq!(status["issues"][0]["code"], "status-unreadable");
        assert!(!status.to_string().contains("secret"));
    }
}
