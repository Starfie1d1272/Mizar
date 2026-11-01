//! Shared desktop host state, owned by the application runtime.
use crate::{windows_host::GameTracker, workspace_focus, workspace_group, workspace_shell};
use std::sync::{
    atomic::{AtomicBool, AtomicU64},
    Arc, Mutex,
};

pub(crate) struct HostState {
    pub(crate) tracker: Arc<Mutex<GameTracker>>,
    pub(crate) visible: Arc<AtomicBool>,
    pub(crate) panels_only: AtomicBool,
    pub(crate) entry_ticket: Mutex<Option<(String, u64)>>,
    pub(crate) entry_message: Mutex<String>,
    pub(crate) layout_dirty: Arc<AtomicBool>,
    pub(crate) layout_request: AtomicU64,
    pub(crate) layout_request_generation: AtomicU64,
    pub(crate) layout_completed: AtomicU64,
    pub(crate) running: Arc<AtomicBool>,
    pub(crate) live_window_lock: Mutex<()>,
    pub(crate) overlay_generation: AtomicU64,
    pub(crate) overlay_ready: AtomicU64,
    pub(crate) overlay_epoch: AtomicU64,
    pub(crate) overlay_recovering: AtomicBool,
    pub(crate) overlay_presentation: Mutex<()>,
    pub(crate) workspace_epoch: AtomicU64,
    pub(crate) overlay_observation: Mutex<String>,
    pub(crate) overlay_document: AtomicU64,
    pub(crate) fullscreen_scope: Mutex<workspace_shell::FullscreenScope>,
    pub(crate) window_group: Mutex<workspace_group::Group>,
    pub(crate) entry_focus: Mutex<workspace_focus::Entry>,
}
