use mizar_common::{is_reparse_point, parse_semver_triplet, remove_dir_safe};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactMetadata {
    pub app_version: String,
    pub git_sha: String,
    pub artifact_sha256: String,
    pub resource_mode: String,
    pub repository: String,
    pub product_schema_version: u32,
    pub desktop_host: String,
    pub platform: String,
    #[serde(default)]
    pub development_only: bool,
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn sha256_file(path: &Path) -> io::Result<String> {
    if is_reparse_point(path)? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("拒绝读取重解析点文件：{}", path.display()),
        ));
    }
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

pub fn verify_payload(
    payload_dir: &Path,
    expected_content_digest: Option<&str>,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<ArtifactMetadata, String> {
    if is_reparse_point(payload_dir).map_err(|e| format!("无法检查载荷目录: {e}"))? {
        return Err("载荷目录不能是重解析点".into());
    }
    let artifact_path = payload_dir.join("resources/metadata/artifact.json");
    let raw = fs::read(&artifact_path).map_err(|e| format!("无法读取 artifact.json: {e}"))?;
    if raw.len() > 1024 * 1024 {
        return Err("artifact.json 超出大小限制".into());
    }
    let artifact: ArtifactMetadata =
        serde_json::from_slice(&raw).map_err(|e| format!("artifact.json 解析失败: {e}"))?;

    if artifact.repository != "Starfie1d1272/Mizar"
        || artifact.product_schema_version != 1
        || artifact.desktop_host != "tauri2"
        || artifact.platform != "win32-x64"
        || parse_semver_triplet(&artifact.app_version).is_none()
        || !is_hex(&artifact.git_sha, 40)
        || !is_hex(&artifact.artifact_sha256, 64)
    {
        return Err("artifact.json 身份字段无效".into());
    }

    if let Some(expected) = expected_content_digest {
        if !expected.eq_ignore_ascii_case(&artifact.artifact_sha256) {
            return Err(format!(
                "载荷内容摘要不匹配：期望 {expected}，实际 {}",
                artifact.artifact_sha256
            ));
        }
    }

    let sums_path = payload_dir.join("resources/metadata/SHA256SUMS");
    let sums_text =
        fs::read_to_string(&sums_path).map_err(|e| format!("无法读取 SHA256SUMS: {e}"))?;
    let mut entries: Vec<(String, String)> = Vec::new();
    let mut seen = HashSet::new();

    for line in sums_text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.len() < 67 || &trimmed[64..66] != "  " {
            return Err("SHA256SUMS 格式无效".into());
        }
        let hash = &trimmed[..64];
        let rel = &trimmed[66..];
        if !is_hex(hash, 64)
            || rel.contains('\\')
            || rel.starts_with('/')
            || rel.starts_with("state/")
            || rel.split('/').any(|p| p.is_empty() || p == "..")
            || !seen.insert(rel.to_owned())
        {
            return Err(format!("SHA256SUMS 包含非法路径或摘要：{rel}"));
        }
        entries.push((rel.to_owned(), hash.to_owned()));
    }

    entries.sort_by(|a, b| a.0.cmp(&b.0));

    for required in [
        "Mizar.exe",
        "mizar-applier.exe",
        "mizar-launcher.exe",
        "resources/runtime/node.exe",
        "resources/app/dist/server.js",
        "resources/web/dist/index.html",
        "resources/scripts/product-runtime.mjs",
        "resources/scripts/product-logs.mjs",
        "resources/metadata/artifact.json",
    ] {
        if !seen.contains(required) {
            return Err(format!("载荷缺少必要文件：{required}"));
        }
    }

    let mut digest = Sha256::new();
    for (rel, expected_hash) in &entries {
        if is_cancelled() {
            return Err("cancelled".into());
        }
        let file_path = payload_dir.join(rel);
        let actual = sha256_file(&file_path).map_err(|e| format!("校验文件失败 {rel}: {e}"))?;
        if actual != *expected_hash {
            return Err(format!("文件摘要不匹配：{rel}"));
        }
        if rel != "resources/metadata/artifact.json" {
            digest.update(rel.as_bytes());
            digest.update(b"\0");
            digest.update(expected_hash.as_bytes());
            digest.update(b"\n");
        }
    }

    let computed: String = digest
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if computed != artifact.artifact_sha256 {
        return Err("载荷整体 contentDigest 校验失败".into());
    }

    Ok(artifact)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let s = entry.path();
        let d = dst.join(entry.file_name());
        if is_reparse_point(&s)? {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("拒绝复制重解析点：{}", s.display()),
            ));
        }
        let meta = fs::symlink_metadata(&s)?;
        if meta.is_dir() {
            copy_dir_recursive(&s, &d)?;
        } else {
            fs::copy(&s, &d)?;
        }
    }
    Ok(())
}

pub fn move_or_copy_dir(src: &Path, dst: &Path) -> io::Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_dir_recursive(src, dst)?;
            let _ = remove_dir_safe(src);
            Ok(())
        }
    }
}

pub fn prepare_core_resources(
    staging_dir: &Path,
    state_root: &Path,
    artifact: &ArtifactMetadata,
    core_archive_sha256: Option<&str>,
    installer_sha256: Option<&str>,
    installer_bytes: Option<u64>,
) -> Result<String, String> {
    if artifact.resource_mode != "core" {
        return Ok(String::new());
    }
    let entry = staging_dir.join("resources/app/dist/web-installer/installed-entry.mjs");
    if !entry.is_file() {
        return Err("Core 载荷缺少资源安装入口 installed-entry.mjs".into());
    }
    let node_exe = staging_dir.join("resources/runtime/node.exe");
    let core_sha = core_archive_sha256.ok_or("Core 模式缺少 --core-archive-sha256")?;
    let inst_sha = installer_sha256.ok_or("Core 模式缺少 --installer-sha256")?;
    let inst_bytes = installer_bytes.ok_or("Core 模式缺少 --installer-bytes")?;

    let mut cmd = Command::new(&node_exe);
    cmd.arg(&entry)
        .arg(&artifact.app_version)
        .arg(&artifact.git_sha)
        .arg(&artifact.artifact_sha256)
        .arg(core_sha)
        .arg(inst_sha)
        .arg(inst_bytes.to_string())
        .env("MIZAR_STATE_ROOT", state_root)
        .current_dir(staging_dir);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("无法启动资源准备进程 node.exe: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if !output.status.success() {
        return Err(format!(
            "Core 资源准备失败 (code={:?}): {stderr}",
            output.status.code()
        ));
    }
    Ok(format!("stdout={stdout}; stderr={stderr}"))
}
