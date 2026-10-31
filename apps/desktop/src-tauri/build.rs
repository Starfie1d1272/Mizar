#[path = "ipc_commands.rs"]
mod ipc_commands;

use std::{collections::HashSet, env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=ipc_commands.rs");
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let capability_dir = out.join("ipc-capabilities");
    fs::create_dir_all(&capability_dir).expect("create capability directory");
    // Remove stale generated capabilities when commands are removed.
    for entry in fs::read_dir(&capability_dir).expect("read capability directory") {
        fs::remove_file(entry.expect("capability entry").path()).expect("remove old capability");
    }
    let mut names = Vec::new();
    let mut seen = HashSet::new();
    let mut handler = String::from("tauri::generate_handler![\n");
    for &(path, windows) in ipc_commands::COMMANDS {
        let name = path.rsplit("::").next().expect("command name");
        assert!(seen.insert(name), "duplicate IPC command: {name}");
        assert!(!windows.is_empty(), "IPC command without windows: {name}");
        assert!(name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'));
        let id = name.replace('_', "-");
        let labels = windows
            .iter()
            .map(|label| format!("\"{label}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let capability = format!("{{\"identifier\":\"ipc-{id}\",\"windows\":[{labels}],\"remote\":{{\"urls\":[\"http://127.0.0.1:3000/*\"]}},\"permissions\":[\"allow-{id}\"]}}");
        fs::write(capability_dir.join(format!("{id}.json")), capability).expect("write capability");
        handler.push_str(&format!("    {path},\n"));
        names.push(name);
    }
    handler.push(']');
    fs::write(out.join("ipc_handler.rs"), handler).expect("write handler");
    let frontend_path = PathBuf::from("../../web/src/workspace/desktop-commands.generated.ts");
    println!("cargo:rerun-if-changed={}", frontend_path.display());
    assert_eq!(fs::read_to_string(&frontend_path).expect("read generated frontend commands"), ipc_commands::frontend_commands(),
        "frontend IPC commands are stale; run rustc ipc_generate.rs -o <temporary-path> and execute it from src-tauri");
    let pattern = format!("{}/*.json", capability_dir.display()).replace('\\', "/");
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .capabilities_path_pattern(Box::leak(pattern.into_boxed_str()))
            .app_manifest(
                tauri_build::AppManifest::new().commands(Box::leak(names.into_boxed_slice())),
            ),
    )
    .expect("Tauri build metadata");
}
