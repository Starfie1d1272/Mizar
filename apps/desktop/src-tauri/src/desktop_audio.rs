//! Read-only default render endpoint reporting to this session's Companion.
use crate::{production_exit, startup_log::DesktopLog};
use std::{
    io::Write,
    net::{SocketAddr, TcpStream},
    time::Duration,
};
use windows::Win32::{
    Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator},
    System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_MULTITHREADED,
    },
};

fn default_render() -> Option<String> {
    unsafe {
        if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
            return None;
        }
        let result = (|| {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
            let id = device.GetId().ok()?;
            let value = id.to_string().ok().filter(|value| !value.is_empty());
            CoTaskMemFree(Some(id.0.cast()));
            value
        })();
        CoUninitialize();
        result
    }
}

pub fn pulse(log: &DesktopLog) {
    let endpoint = default_render();
    let Ok(token) = production_exit::runtime_token(log) else {
        return;
    };
    let body = serde_json::json!({ "endpoint": endpoint }).to_string();
    let address: SocketAddr = "127.0.0.1:3000".parse().expect("loopback address");
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(100)) else {
        return;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(100)));
    let request = format!("POST /operator/runtime/audio-default HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nx-runtime-token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = stream.write_all(request.as_bytes());
}
