use std::{fs, path::Path};

const MAX_BYTES: usize = 256 * 1024;

pub fn validate(contents: &str) -> Result<(), String> {
    if contents.len() > MAX_BYTES {
        return Err("诊断包超出大小限制，请重新生成。".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(contents).map_err(|_| "诊断包格式无效，请重新生成。")?;
    if value["schema"] != "mizar-support-bundle/1"
        || !value["manifest"].is_object()
        || !value["snapshot"].is_object()
        || !value["logs"].is_array()
        || !value["summary"].is_array()
    {
        return Err("诊断包格式无效，请重新生成。".into());
    }
    Ok(())
}

// The caller obtains this path exclusively from the native Save dialog, never IPC input.
pub fn save(path: &Path, contents: &str) -> Result<(), String> {
    validate(contents)?;
    if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
        return Err("请使用 .json 文件名保存诊断包。".into());
    }
    fs::write(path, contents).map_err(|_| "诊断包未能保存，请选择可写位置后重试。".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUNDLE: &str =
        r#"{"schema":"mizar-support-bundle/1","manifest":{},"snapshot":{},"logs":[],"summary":[]}"#;

    #[test]
    fn rejects_wrong_schema_and_utf8_byte_overflow() {
        assert!(validate(BUNDLE).is_ok());
        assert!(validate("{}").is_err());
        assert!(validate(&BUNDLE.replace("/1", "/2")).is_err());
        assert!(validate(&"错".repeat(MAX_BYTES / 2)).is_err());
    }

    #[test]
    fn writes_only_valid_json_to_user_chosen_path() {
        let path =
            std::env::temp_dir().join(format!("mizar-support-test-{}.json", std::process::id()));
        save(&path, BUNDLE).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), BUNDLE);
        assert!(save(&path, "{}").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), BUNDLE);
        assert!(save(&path.with_extension("txt"), BUNDLE).is_err());
        fs::remove_file(path).unwrap();
    }
}
