//! Identity and paths of the installed local runtime.
use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    time::Duration,
};

pub(crate) const BASE: &str = "http://127.0.0.1:3000";

pub(crate) fn bundle_root() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|error| format!("无法定位产品安装目录：{error}"))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法定位产品安装目录。".to_string())
}

pub(crate) fn health_matches(root: &Path) -> bool {
    let Ok(bytes) = fs::read(root.join("resources/metadata/artifact.json")) else {
        return false;
    };
    let Ok(artifact) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    let address: SocketAddr = "127.0.0.1:3000".parse().expect("fixed loopback address");
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(700)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    if stream
        .take(64 * 1024)
        .read_to_string(&mut response)
        .is_err()
    {
        return false;
    }
    let Some(body) = response.split("\r\n\r\n").nth(1) else {
        return false;
    };
    let Ok(health) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    health["product"]["repository"] == "Starfie1d1272/Mizar"
        && health["product"]["mode"] == "product"
        && health["product"]["artifactSha256"] == artifact["artifactSha256"]
}
