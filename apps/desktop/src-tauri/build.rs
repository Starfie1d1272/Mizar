fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "restore_layout",
                "restore_cs2_focus",
                "set_program_overlay_enabled",
                "cs2_host_status",
                "select_obs_executable",
                "open_main",
                "present_production",
                "open_tool",
                "gsi_status",
                "configure_gsi",
            ]),
        ),
    )
    .expect("Tauri build metadata");
}
