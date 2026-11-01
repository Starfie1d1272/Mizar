//! IPC boundary for the host-owned preparation task.
use crate::preparation_task;

#[tauri::command]
pub(crate) fn preparation_status() -> Result<serde_json::Value, String> {
    preparation_task::status()
}

#[tauri::command]
pub(crate) fn retry_workspace_entry(app: tauri::AppHandle) -> Result<(), String> {
    preparation_task::retry_entry(app)
}

#[tauri::command]
pub(crate) async fn cancel_workspace_entry(
    app: tauri::AppHandle,
    entry_id: Option<String>,
) -> Result<(), String> {
    preparation_task::cancel_entry(app, entry_id).await
}

#[tauri::command]
pub(crate) async fn enter_workspace(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    preparation_id: String,
    document: String,
    expected_revision: Option<String>,
    expected_demo_request: Option<String>,
    manual: bool,
    preserve_settings: bool,
    external_pid: Option<u32>,
    external_created: Option<String>,
) -> Result<(), String> {
    preparation_task::enter(
        window,
        app,
        preparation_id,
        document,
        expected_revision,
        expected_demo_request,
        manual,
        preserve_settings,
        external_pid,
        external_created,
    )
    .await
}
