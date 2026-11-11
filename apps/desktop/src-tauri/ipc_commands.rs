use crate::ipc_contract::desktop_ipc;

// Single source for handler registration, permissions and the frontend command type.
// Each tuple is (Rust handler path, allowed window labels).
const PRODUCT_WINDOWS: &[&str] = &[
    "main",
    "program-overlay",
    "tool-bp",
    "tool-diagnostics",
    "tool-hud",
    "tool-preview",
    "tool-review",
    "tool-connection",
    "tool-game-picture",
    "workspace-dock",
    "workspace-left",
];
const MAIN: &[&str] = &["main"];
const MAIN_AND_WORKSPACE: &[&str] = &["main", "workspace-dock", "workspace-left"];
const MAIN_AND_DIAGNOSTICS: &[&str] = &["main", "tool-diagnostics"];
const MAIN_AND_DOCK: &[&str] = &["main", "workspace-dock"];
const GAME_PICTURE: &[&str] = &["tool-game-picture"];
const REVIEW: &[&str] = &["tool-review"];

pub fn commands() -> Vec<(&'static str, &'static [&'static str])> {
    let mut registered = Vec::new();
    macro_rules! ignore_declaration {
        ($($tokens:tt)*) => {};
    }
    macro_rules! command {
        ($execution:ident $name:ident $windows:ident $($signature:tt)*) => {
            registered.push((concat!("desktop_ipc::", stringify!($name)), $windows));
        };
    }
    desktop_ipc!(
        ignore_declaration,
        ignore_declaration,
        ignore_declaration,
        ignore_declaration,
        ignore_declaration,
        command
    );
    registered
}

/// Generate the frontend command union; invoked by build.rs and ipc_generate.rs.
pub fn frontend_commands() -> String {
    let mut result = String::from("// Generated from desktop/src-tauri/ipc_commands.rs. Do not edit.\nexport type DesktopCommand =\n");
    let commands = commands();
    for (index, (path, _)) in commands.iter().enumerate() {
        let name = path.rsplit("::").next().expect("command name");
        let suffix = if index + 1 == commands.len() { ";" } else { "" };
        result.push_str(&format!("  | '{name}'{suffix}\n"));
    }
    result
}
