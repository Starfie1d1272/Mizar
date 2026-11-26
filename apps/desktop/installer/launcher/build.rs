use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn escape_rc_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "\\\\")
}

fn find_rc_exe() -> Option<PathBuf> {
    if Command::new("rc.exe").arg("/?").output().is_ok() {
        return Some(PathBuf::from("rc.exe"));
    }

    let mut kit_roots: Vec<PathBuf> = Vec::new();
    if let Some(sdk) = env::var_os("WindowsSdkDir") {
        kit_roots.push(PathBuf::from(sdk).join("bin"));
    }
    if let Some(pf86) = env::var_os("ProgramFiles(x86)") {
        kit_roots.push(
            PathBuf::from(pf86)
                .join("Windows Kits")
                .join("10")
                .join("bin"),
        );
    }
    kit_roots.push(PathBuf::from(r"C:\Program Files (x86)\Windows Kits\10\bin"));

    let mut candidates: Vec<PathBuf> = Vec::new();
    for root in kit_roots {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path().join("x64").join("rc.exe");
            if p.is_file() {
                candidates.push(p);
            }
        }
        let direct = root.join("x64").join("rc.exe");
        if direct.is_file() {
            candidates.push(direct);
        }
    }
    candidates.sort();
    candidates.pop()
}

fn main() {
    println!("cargo:rerun-if-changed=../../src-tauri/icons/icon.ico");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let icon_path = manifest_dir
        .join("..")
        .join("..")
        .join("src-tauri")
        .join("icons")
        .join("icon.ico");

    assert!(
        icon_path.is_file(),
        "missing icon asset: {}",
        icon_path.display()
    );

    let rc_content = format!("1 ICON \"{}\"\n", escape_rc_path(&icon_path));
    let rc_path = out_dir.join("launcher.rc");
    let res_path = out_dir.join("launcher.res");
    fs::write(&rc_path, rc_content).expect("write launcher.rc");

    let rc_exe = find_rc_exe().expect("Windows SDK rc.exe not found");
    let output = Command::new(&rc_exe)
        .arg("/nologo")
        .arg("/fo")
        .arg(&res_path)
        .arg(&rc_path)
        .output()
        .expect("failed to execute rc.exe");
    assert!(
        output.status.success(),
        "rc.exe failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    println!(
        "cargo:rustc-link-arg-bin=mizar-launcher={}",
        res_path.display()
    );
}
