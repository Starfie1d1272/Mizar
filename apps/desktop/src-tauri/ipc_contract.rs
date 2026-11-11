// The desktop host and frontend generator expand the same declarations.
macro_rules! desktop_ipc {
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


        $string_enum!(FrameRateAction { Inspect = "inspect", Apply = "apply", Restore = "restore" });
        $string_enum!(PinAction { Prepare = "prepare", Commit = "commit", Release = "release" });
        $string_enum!(PinKind { Incident = "incident", Export = "export", Delivery = "delivery", Active = "active" });
        $string_enum!(ObserverAction { ConnectionMode = "connection-mode", StartConfigured = "start-configured", Stop = "stop", RestoreHud = "restore-hud", Preflight = "preflight", Start = "start" });
        $string_enum!(MulnxAction { Update = "update" });
        $object!(Cs2HostStatus {
            found: bool, managed: bool, layout_aligned: bool, generation: u64,
            geometry: JsonObject, message: Nullable(String), layout_pending: bool, visible: bool,
        });
        $object!(ObsConfigurationContext { document_generation: String, message: String });
        $object!(ObsConfigurationResult { reason: String, message: String });
        $object!(SelectedDemo { token: String, name: String });
        $string_enum!(DemoPhase { Idle = "idle", Starting = "starting", Playing = "playing", Stopping = "stopping", Recovery = "recovery" });
        $object!(DemoTestView { active: bool, phase: DemoPhase, request_id: Nullable(String), team_a_name: String, team_b_name: String, data_ready: bool });
        $object!(ObserverResult {
            #[serde(default, skip_serializing_if = "Option::is_none")] pending: Optional(bool),
            #[serde(default, skip_serializing_if = "Option::is_none")] use_mulnx: OptionalNullable(bool),
            #[serde(default, skip_serializing_if = "Option::is_none")] warning: OptionalNullable(String),
        });
        $object!(ConsoleStatus {
            enabled: bool, generation: Nullable(String), revocation_pending: bool,
            #[serde(default, skip_serializing_if = "Option::is_none")] version: Optional(u32),
            #[serde(default, skip_serializing_if = "Option::is_none")] changed_at: Optional(String),
            #[serde(default, skip_serializing_if = "Option::is_none")] warning: Optional(String),
            runtime: Nullable(JsonObject),
        });
        $string_enum!(FrameRateStatus { Confirmed = "confirmed", Unsupported = "unsupported", Unconfirmed = "unconfirmed" });
        $string_enum!(FrameRateTransaction { Idle = "idle", Pending = "pending", Applied = "applied", Restored = "restored", Relinquished = "relinquished", Ended = "ended" });
        $object!(FrameRateReading { status: FrameRateStatus, current: Nullable(f64), transaction: FrameRateTransaction, can_apply: bool, can_restore: bool, message: String });
        $object!(DiagnosticReceipt { event_ids: Array(String) });
        $string_enum!(PinReleasedState { Released = "released" });
        $string_enum!(PinActiveState { Prepared = "prepared", Committed = "committed" });
        $object!(PinReleased { pin_id: String, state: PinReleasedState });
        $object!(PinSegment { name: String, bytes: u64, sha256: String });
        $object!(PinActive { source_state: JsonObject, schema: String, pin_id: String, producer_kind: String, producer_run_id: String,
            kind: String, state: PinActiveState, expires_at: Nullable(String), segments: Array(PinSegment),
            #[serde(default, skip_serializing_if = "Option::is_none")] delivery_owner: Optional(JsonObject),
        });
        $union!(DiagnosticPin { Released(PinReleased), Active(PinActive) });
        $object!(GsiIssue { code: String, message: String });
        $object!(GsiOperation { code: Nullable(String), stage: Nullable(String) });
        $object!(GsiStatus { detected: bool, installed: bool, conflict: bool, file_conflict: bool, endpoint_conflict: bool, read_failed: bool,
            cfg_path: Nullable(String), candidate_count: u64, conflict_count: u64, issues: Array(GsiIssue), conflict_files: Array(String), last_operation: Nullable(GsiOperation),
        });

        $command!(sync entry_document MAIN
            (window: tauri::WebviewWindow, app: tauri::AppHandle) required [] ()
            -> String = crate::desktop_commands::entry_document);
        $command!(async enter_workspace MAIN
            (window: tauri::WebviewWindow, app: tauri::AppHandle) required [
                preparation_id: String, document: String, expected_revision: Nullable(String),
                expected_demo_request: Nullable(String), manual: bool, preserve_settings: bool,
                external_pid: Nullable(u32), external_created: Nullable(String),
            ] () -> Unit = crate::preparation_task::enter);
        $command!(sync cancel_entry_intent MAIN
            (window: tauri::WebviewWindow, app: tauri::AppHandle) required [intent_id: String] ()
            -> Unit = crate::desktop_commands::cancel_entry_intent);
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
            ) -> Unit = crate::desktop_commands::finish_workspace);
        $command!(async workspace_exit_status PRODUCT_WINDOWS (app: tauri::AppHandle) required [] ()
            -> WorkspaceExitStatus = crate::desktop_commands::workspace_exit_status);
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
        $command!(sync restore_layout PRODUCT_WINDOWS
            (app: tauri::AppHandle) required []
            (diagnostic_operation_id: Option<String>) -> String = crate::desktop_commands::restore_layout);
        $command!(async restore_cs2_focus PRODUCT_WINDOWS
            (window: tauri::WebviewWindow, app: tauri::AppHandle) required []
            (diagnostic_operation_id: Option<String>) -> bool = crate::desktop_commands::restore_cs2_focus);
        $command!(sync cs2_host_status PRODUCT_WINDOWS
            (state: tauri::State<'_, HostState>) required []
            () -> Cs2HostStatus = crate::desktop_commands::cs2_host_status);
        $command!(async select_obs_executable PRODUCT_WINDOWS
            (app: tauri::AppHandle) required []
            (diagnostic_operation_id: Option<String>) -> Nullable(String) = crate::desktop_commands::select_obs_executable);
        $command!(async launch_obs PRODUCT_WINDOWS
            (log: tauri::State<'_, DesktopLog>) required [executable_path: String]
            (diagnostic_operation_id: Option<String>) -> bool = crate::desktop_commands::launch_obs);
        $command!(async begin_obs_configuration MAIN
            (log: tauri::State<'_, DesktopLog>) required [executable_path: String, session_id: String, document_generation: String]
            (diagnostic_operation_id: Option<String>) -> bool = crate::desktop_commands::begin_obs_configuration);
        $command!(async finish_obs_configuration MAIN
            (log: tauri::State<'_, DesktopLog>) required [session_id: String]
            (diagnostic_operation_id: Option<String>) -> ObsConfigurationResult = crate::desktop_commands::finish_obs_configuration);
        $command!(async read_obs_configuration_context MAIN
            (log: tauri::State<'_, DesktopLog>) required []
            () -> ObsConfigurationContext = crate::desktop_commands::read_obs_configuration_context);
        $command!(async mulnx_control MAIN
            (window: tauri::WebviewWindow, app: tauri::AppHandle) required [action: MulnxAction]
            (diagnostic_operation_id: Option<String>) -> Unit = crate::desktop_commands::mulnx_control);
        $command!(async select_demo_file MAIN
            (window: tauri::WebviewWindow, app: tauri::AppHandle) required []
            (diagnostic_operation_id: Option<String>) -> Nullable(SelectedDemo) = crate::desktop_commands::select_demo_file);
        $command!(async start_demo_test MAIN
            (window: tauri::WebviewWindow, app: tauri::AppHandle) required [token: String, team_a_name: String, team_b_name: String, preserve_settings: OptionalNullable(bool), camera_trial: OptionalNullable(bool)]
            (diagnostic_operation_id: Option<String>) -> DemoTestView = crate::desktop_commands::start_demo_test);
        $command!(async resume_demo_test MAIN
            (window: tauri::WebviewWindow, app: tauri::AppHandle) required [request_id: String]
            () -> DemoTestView = crate::desktop_commands::resume_demo_test);
        $command!(async finish_demo_test MAIN_AND_WORKSPACE
            (window: tauri::WebviewWindow, app: tauri::AppHandle) optional [request_id: OptionalNullable(String)]
            (diagnostic_operation_id: Option<String>, diagnostic_task_id: Option<String>, diagnostic_trigger: Option<String>) -> Unit = crate::desktop_commands::finish_demo_test);
        $command!(async cs2_console_status MAIN_AND_DIAGNOSTICS
            (app: tauri::AppHandle) required []
            (diagnostic_operation_id: Option<String>, diagnostic_task_id: Option<String>, diagnostic_trigger: Option<String>) -> ConsoleStatus = crate::desktop_commands::cs2_console_status);
        $command!(async set_cs2_console_capture MAIN
            (app: tauri::AppHandle) required [enabled: bool, expected_generation: OptionalNullable(String)]
            (diagnostic_operation_id: Option<String>, diagnostic_task_id: Option<String>, diagnostic_trigger: Option<String>) -> ConsoleStatus = crate::desktop_commands::set_cs2_console_capture);
        $command!(async set_cs2_preferences PRODUCT_WINDOWS
            (app: tauri::AppHandle) required [quality_preset: QualityPreset, frame_rate_limit: FrameRateLimit, prefer_mulnx: OptionalNullable(bool)]
            (diagnostic_operation_id: Option<String>) -> Unit = crate::desktop_commands::set_cs2_preferences);
        $command!(async open_cs2_backup PRODUCT_WINDOWS
            (app: tauri::AppHandle) required []
            (diagnostic_operation_id: Option<String>) -> Unit = crate::desktop_commands::open_cs2_backup);
        $command!(sync open_main PRODUCT_WINDOWS
            (app: tauri::AppHandle) optional [path: OptionalNullable(String)]
            (diagnostic_operation_id: Option<String>) -> Unit = crate::desktop_commands::open_main);
        $command!(async present_production PRODUCT_WINDOWS
            (app: tauri::AppHandle) required [live: bool, preparation_id: OptionalNullable(String)]
            (diagnostic_operation_id: Option<String>, diagnostic_task_id: Option<String>, diagnostic_trigger: Option<String>) -> Unit = crate::desktop_commands::present_production);
        $command!(sync program_overlay_ready PRODUCT_WINDOWS
            (window: tauri::WebviewWindow) required [generation: u64, document_id: u64]
            () -> Unit = crate::desktop_commands::program_overlay_ready);
        $command!(async recover_program_overlay PRODUCT_WINDOWS
            (window: tauri::WebviewWindow) required []
            (diagnostic_operation_id: Option<String>) -> String = crate::desktop_commands::recover_program_overlay);
        $command!(sync close_review REVIEW
            (window: tauri::WebviewWindow) required []
            () -> Unit = crate::desktop_commands::close_review);
        $command!(async open_tool PRODUCT_WINDOWS
            (app: tauri::AppHandle) required [tool: String, preset_id: OptionalNullable(String)]
            (diagnostic_operation_id: Option<String>) -> Unit = crate::desktop_commands::open_tool);
        $command!(sync open_steam_api_key PRODUCT_WINDOWS
            (log: tauri::State<'_, DesktopLog>) required []
            (diagnostic_operation_id: Option<String>) -> Unit = crate::desktop_commands::open_steam_api_key);
        $command!(sync open_issue_report PRODUCT_WINDOWS
            (log: tauri::State<'_, DesktopLog>) required []
            (diagnostic_operation_id: Option<String>) -> Unit = crate::desktop_commands::open_issue_report);
        $command!(async install_update PRODUCT_WINDOWS
            (window: tauri::WebviewWindow, app: tauri::AppHandle) required []
            (diagnostic_operation_id: Option<String>) -> Unit = crate::desktop_commands::install_update);
        $command!(sync open_music_downloads PRODUCT_WINDOWS
            (log: tauri::State<'_, DesktopLog>) required []
            (diagnostic_operation_id: Option<String>) -> Unit = crate::desktop_commands::open_music_downloads);
        $command!(sync open_update_page PRODUCT_WINDOWS
            (log: tauri::State<'_, DesktopLog>) required [source: String, version: OptionalNullable(String)]
            (diagnostic_operation_id: Option<String>) -> Unit = crate::desktop_commands::open_update_page);
        $command!(sync open_update_recovery PRODUCT_WINDOWS
            (app: tauri::AppHandle) required []
            (diagnostic_operation_id: Option<String>) -> Unit = crate::desktop_commands::open_update_recovery);
        $command!(sync open_rivalhub_authorization PRODUCT_WINDOWS
            (log: tauri::State<'_, DesktopLog>) required [url: String]
            (diagnostic_operation_id: Option<String>) -> Unit = crate::desktop_commands::open_rivalhub_authorization);
        $command!(sync open_rivalhub_workbench PRODUCT_WINDOWS
            (log: tauri::State<'_, DesktopLog>) required [url: String]
            (diagnostic_operation_id: Option<String>) -> Unit = crate::desktop_commands::open_rivalhub_workbench);
        $command!(async gsi_status PRODUCT_WINDOWS
            (log: tauri::State<'_, DesktopLog>) required []
            () -> GsiStatus = crate::desktop_commands::gsi_status);
        $command!(async control_cs2_frame_rate GAME_PICTURE
            (app: tauri::AppHandle) required [action: FrameRateAction, frame_rate_limit: OptionalNullable(FrameRateLimit)]
            (diagnostic_operation_id: Option<String>, diagnostic_task_id: Option<String>, diagnostic_trigger: Option<String>) -> FrameRateReading = crate::desktop_commands::control_cs2_frame_rate);
        $command!(async persist_diagnostic_events PRODUCT_WINDOWS
            (log: tauri::State<'_, DesktopLog>) required [events: Array(JsonValue)]
            () -> DiagnosticReceipt = crate::desktop_commands::persist_diagnostic_events);
        $command!(async diagnostic_pin PRODUCT_WINDOWS
            (log: tauri::State<'_, DesktopLog>) required [action: PinAction, pin_id: String, kind: PinKind]
            () -> DiagnosticPin = crate::desktop_commands::diagnostic_pin);
        $command!(async save_support_bundle PRODUCT_WINDOWS
            (app: tauri::AppHandle) required [export_id: String]
            (diagnostic_operation_id: Option<String>) -> bool = crate::desktop_commands::save_support_bundle);
        $command!(async select_cs2_installation PRODUCT_WINDOWS
            (app: tauri::AppHandle) required [executable: bool]
            (diagnostic_operation_id: Option<String>) -> bool = crate::desktop_commands::select_cs2_installation);
        $command!(async open_cs2_config_directory PRODUCT_WINDOWS
            (log: tauri::State<'_, DesktopLog>) required []
            (diagnostic_operation_id: Option<String>) -> Unit = crate::desktop_commands::open_cs2_config_directory);
        $command!(async configure_gsi PRODUCT_WINDOWS
            (app: tauri::AppHandle) required [restore: bool, choose: bool]
            (diagnostic_operation_id: Option<String>) -> Unit = crate::desktop_commands::configure_gsi);
        $command!(async observer_command PRODUCT_WINDOWS
            (window: tauri::WebviewWindow, app: tauri::AppHandle) required [action: ObserverAction, endpoint: OptionalNullable(String), password: OptionalNullable(String), expected_revision: OptionalNullable(String)]
            () -> ObserverResult = crate::desktop_commands::observer_command);
    };
}
pub(crate) use desktop_ipc;
