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
    "workspace-dock",
    "workspace-left",
];
const MAIN: &[&str] = &["main"];
const MAIN_AND_WORKSPACE: &[&str] = &["main", "workspace-dock", "workspace-left"];
const MAIN_AND_DIAGNOSTICS: &[&str] = &["main", "tool-diagnostics"];
const MAIN_AND_DOCK: &[&str] = &["main", "workspace-dock"];
const DOCK: &[&str] = &["workspace-dock"];
const REVIEW: &[&str] = &["tool-review"];

pub const COMMANDS: &[(&str, &[&str])] = &[
    ("restore_layout", PRODUCT_WINDOWS),
    ("recover_program_overlay", PRODUCT_WINDOWS),
    ("program_overlay_ready", PRODUCT_WINDOWS),
    ("restore_cs2_focus", PRODUCT_WINDOWS),
    ("set_program_overlay_enabled", PRODUCT_WINDOWS),
    ("cs2_host_status", PRODUCT_WINDOWS),
    ("select_obs_executable", PRODUCT_WINDOWS),
    ("launch_obs", PRODUCT_WINDOWS),
    ("begin_obs_configuration", MAIN),
    ("finish_obs_configuration", MAIN),
    ("read_obs_configuration_context", MAIN),
    ("cs2_config_status", PRODUCT_WINDOWS),
    ("mulnx_handoff_status", PRODUCT_WINDOWS),
    ("launch_mulnx", PRODUCT_WINDOWS),
    ("mulnx_control", MAIN),
    ("open_mulnx_browser", PRODUCT_WINDOWS),
    ("observer_workspace::observer_command", PRODUCT_WINDOWS),
    ("start_managed_cs2", PRODUCT_WINDOWS),
    ("preflight_cs2_replacement", PRODUCT_WINDOWS),
    ("replace_external_cs2", PRODUCT_WINDOWS),
    ("cancel_cs2_preparation", PRODUCT_WINDOWS),
    ("begin_managed_camera", PRODUCT_WINDOWS),
    ("cancel_managed_camera", PRODUCT_WINDOWS),
    ("finish_managed_cs2", PRODUCT_WINDOWS),
    ("finish_workspace", MAIN_AND_WORKSPACE),
    ("workspace_exit_status", PRODUCT_WINDOWS),
    ("select_demo_file", MAIN),
    ("start_demo_test", MAIN),
    ("resume_demo_test", MAIN),
    ("cancel_demo_entry", MAIN),
    ("finish_demo_test", MAIN_AND_WORKSPACE),
    ("restore_cs2_backup", PRODUCT_WINDOWS),
    ("open_cs2_backup", PRODUCT_WINDOWS),
    ("manage_cs2_backup", MAIN),
    ("set_cs2_preferences", PRODUCT_WINDOWS),
    ("cs2_console_status", MAIN_AND_DIAGNOSTICS),
    ("set_cs2_console_capture", MAIN),
    ("open_main", PRODUCT_WINDOWS),
    ("present_production", PRODUCT_WINDOWS),
    ("present_workbench_panels", MAIN),
    ("preparation_task::enter_workspace", MAIN),
    ("preparation_task::preparation_status", MAIN_AND_DOCK),
    ("preparation_task::preparation_retry", MAIN_AND_DOCK),
    ("preparation_task::preparation_cancel", MAIN_AND_DOCK),
    ("workbench_status", DOCK),
    ("open_tool", PRODUCT_WINDOWS),
    ("close_review", REVIEW),
    ("open_rivalhub_authorization", PRODUCT_WINDOWS),
    ("open_steam_api_key", PRODUCT_WINDOWS),
    ("open_issue_report", PRODUCT_WINDOWS),
    ("install_update", PRODUCT_WINDOWS),
    ("open_update_page", PRODUCT_WINDOWS),
    ("open_music_downloads", PRODUCT_WINDOWS),
    ("open_update_recovery", PRODUCT_WINDOWS),
    ("open_rivalhub_workbench", PRODUCT_WINDOWS),
    ("save_support_bundle", PRODUCT_WINDOWS),
    ("gsi_status", PRODUCT_WINDOWS),
    ("configure_gsi", PRODUCT_WINDOWS),
    ("ensure_gsi", PRODUCT_WINDOWS),
    ("select_cs2_installation", PRODUCT_WINDOWS),
    ("open_cs2_config_directory", PRODUCT_WINDOWS),
];

/// Generate the frontend command union; invoked by build.rs and ipc_generate.rs.
pub fn frontend_commands() -> String {
    let mut result = String::from("// Generated from desktop/src-tauri/ipc_commands.rs. Do not edit.\nexport type DesktopCommand =\n");
    for (index, (path, _)) in COMMANDS.iter().enumerate() {
        let name = path.rsplit("::").next().expect("command name");
        let suffix = if index + 1 == COMMANDS.len() { ";" } else { "" };
        result.push_str(&format!("  | '{name}'{suffix}\n"));
    }
    result.push_str("\nexport function invokeDesktopCommand<T>(\n  invoke: (command: string, args?: Record<string, unknown>) => Promise<T>,\n  command: DesktopCommand,\n  args?: Record<string, unknown>,\n): Promise<T> {\n  return invoke(command, args);\n}\n");
    result
}
