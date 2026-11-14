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
const SUPPORT_WINDOWS: &[&str] = &[
    "main",
    "tool-diagnostics",
    "workspace-dock",
    "workspace-left",
    "tool-review",
];
const OBSERVER_WINDOWS: &[&str] = &["main", "tool-connection", "workspace-left"];
const GAME_PREFERENCES_WINDOWS: &[&str] = &["main", "tool-game-picture"];
const PROGRAM_OVERLAY: &[&str] = &["program-overlay"];
const MAIN_AND_DOCK: &[&str] = &["main", "workspace-dock"];
const PREPARATION_STATUS_WINDOWS: &[&str] = &["main", "workspace-dock", "tool-connection"];
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
