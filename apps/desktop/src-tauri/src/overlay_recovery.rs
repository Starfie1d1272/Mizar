//! Ordering and gates for the fixed local Program overlay replacement.

pub fn try_lock(lock: &std::sync::Mutex<()>) -> Result<std::sync::MutexGuard<'_, ()>, String> {
    lock.try_lock()
        .map_err(|_| "现场窗口正在处理，请稍后重试。".into())
}

pub fn replace(
    destroy_and_confirm: impl FnOnce() -> Result<(), String>,
    wait_label_release: impl FnOnce() -> Result<(), String>,
    create: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    destroy_and_confirm()?;
    wait_label_release()?;
    create()
}

pub fn workspace_valid(visible: bool, original: u64, current: u64, ticket_valid: bool) -> bool {
    visible && original == current && ticket_valid
}

pub fn may_present(
    visible: bool,
    recovering: bool,
    generation: u64,
    ready: u64,
    game_allowed: bool,
) -> bool {
    visible && !recovering && generation != 0 && generation == ready && game_allowed
}
