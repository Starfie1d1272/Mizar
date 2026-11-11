// The desktop host and frontend generator expand the same declarations.
macro_rules! ipc_lifecycle {
    ($object:ident, $string_enum:ident, $number_enum:ident, $literal:ident, $union:ident, $command:ident) => {
        $string_enum!(WorkspaceExitStage {
            Idle = "", Checking = "checking", Production = "production",
            Restoration = "restoration", Detachment = "detachment", Presentation = "presentation",
        });
        $string_enum!(Cs2ActivityPhase {
            Idle = "idle", Starting = "starting", Checking = "checking", Restoring = "restoring",
        });
        $string_enum!(Cs2ConfigPhase {
            Idle = "idle", Uncertain = "uncertain", Running = "running", Pending = "pending",
        });
        $string_enum!(QualityPreset {
            VeryHigh = "very-high", High = "high", Medium = "medium", Preserve = "preserve",
        });
        $string_enum!(BackupAction { Select = "select", Apply = "apply", Cancel = "cancel" });
        $number_enum!(FrameRateLimit(u16) { Unlimited = 0, Fps30 = 30, Fps60 = 60 });
        $literal!(Busy, bool, true);
        $literal!(Ready, bool, false);
        $object!(PreparationSteps {
            obs: bool,
            game_configuration: bool,
            game: bool,
            capture: bool,
            camera: bool,
        });
        $object!(PreparationStatus {
            id: String,
            running: bool,
            cancelled: bool,
            entered: bool,
            message: String,
            steps: PreparationSteps,
        });
        $object!(WorkspaceExitStatus {
            busy: bool,
            stage: WorkspaceExitStage,
            message: Nullable(String),
            window_message: Nullable(String),
        });
        $object!(Cs2BusyStatus {
            busy: Busy,
            phase: Cs2ActivityPhase,
            observer_hud_pending: bool,
        });
        $object!(Cs2ConfigStatus {
            busy: Ready,
            phase: Cs2ConfigPhase,
            quality_preset: QualityPreset,
            frame_rate_limit: FrameRateLimit,
            prefer_mulnx: bool,
            preparation_id: Nullable(String),
            spectator_recovery_pending: bool,
            native_hud_toggle: bool,
            demo_cleanup_pending: bool,
            demo_camera_request_id: Nullable(String),
            observer_hud_pending: bool,
            spectator_warning: Nullable(String),
            can_preserve: bool,
            preserve_settings: bool,
            pending: bool,
            mulnx_launch_resumable: bool,
            camera_lease_ready: bool,
            running: bool,
            message: Nullable(String),
        });
        $union!(Cs2Status { Busy(Cs2BusyStatus), Ready(Cs2ConfigStatus) });
        $object!(BackupSelection {
            selection_id: String,
            nickname: String,
            avatar: Nullable(String),
            source_name: String,
            target_path: String,
            includes_frame_rate: bool,
        });

        $command!(sync entry_document MAIN
            (window: tauri::WebviewWindow, app: tauri::AppHandle) required [] ()
            -> String = crate::entry_document);
        $command!(async enter_workspace MAIN
            (window: tauri::WebviewWindow, app: tauri::AppHandle) required [
                preparation_id: String, document: String, expected_revision: Nullable(String),
                expected_demo_request: Nullable(String), manual: bool, preserve_settings: bool,
                external_pid: Nullable(u32), external_created: Nullable(String),
            ] () -> Unit = crate::preparation_task::enter);
        $command!(sync cancel_entry_intent MAIN
            (window: tauri::WebviewWindow, app: tauri::AppHandle) required [intent_id: String] ()
            -> Unit = crate::cancel_entry_intent);
        $command!(sync preparation_status MAIN_AND_DOCK () required [] ()
            -> Nullable(PreparationStatus) = crate::preparation_task::status);
        $command!(async cancel_workspace_entry MAIN_AND_DOCK
            (app: tauri::AppHandle) required [entry_id: Nullable(String)] ()
            -> Unit = crate::preparation_task::cancel_entry);
        $command!(sync retry_workspace_entry MAIN_AND_DOCK (app: tauri::AppHandle) required [] ()
            -> Unit = crate::preparation_task::retry_entry);
        $command!(async finish_workspace MAIN_AND_WORKSPACE
            (window: tauri::WebviewWindow, app: tauri::AppHandle)
            optional [confirm_steam_cancelled: Optional(bool)] (
                diagnostic_operation_id: Option<String>, diagnostic_task_id: Option<String>,
                diagnostic_trigger: Option<String>,
            ) -> Unit = crate::finish_workspace);
        $command!(async workspace_exit_status PRODUCT_WINDOWS (app: tauri::AppHandle) required [] ()
            -> WorkspaceExitStatus = crate::workspace_exit_status);
        $command!(async finish_managed_cs2 PRODUCT_WINDOWS (app: tauri::AppHandle) required [] (
                diagnostic_operation_id: Option<String>, diagnostic_task_id: Option<String>,
                diagnostic_trigger: Option<String>,
            ) -> Unit = crate::cs2_host::finish_managed_cs2);
        $command!(async cs2_config_status PRODUCT_WINDOWS (app: tauri::AppHandle) required [] ()
            -> Cs2Status = crate::cs2_host::config_status);
        $command!(async restore_cs2_backup PRODUCT_WINDOWS
            (app: tauri::AppHandle) required [confirm_steam_cancelled: bool] (
                diagnostic_operation_id: Option<String>, diagnostic_task_id: Option<String>,
                diagnostic_trigger: Option<String>,
            ) -> Unit = crate::cs2_host::restore_backup);
        $command!(async manage_cs2_backup MAIN
            (window: tauri::WebviewWindow, app: tauri::AppHandle)
            required [action: BackupAction, selection_id: Nullable(String)]
            (diagnostic_operation_id: Option<String>)
            -> Nullable(BackupSelection) = crate::cs2_host::manage_backup);
    };
}
pub(crate) use ipc_lifecycle;
