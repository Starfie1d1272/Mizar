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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};

    #[test]
    fn destroys_and_releases_before_creating_only_overlay() {
        let events = Rc::new(RefCell::new(Vec::new()));
        let a = events.clone();
        let b = events.clone();
        let c = events.clone();
        replace(
            || {
                a.borrow_mut().push("destroy-confirmed");
                Ok(())
            },
            || {
                b.borrow_mut().push("label-released");
                Ok(())
            },
            || {
                c.borrow_mut().push("create-overlay");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(
            *events.borrow(),
            ["destroy-confirmed", "label-released", "create-overlay"]
        );
    }

    #[test]
    fn failure_or_cancellation_never_reaches_create() {
        for failed in 0..2 {
            let events = Rc::new(RefCell::new(Vec::new()));
            let a = events.clone();
            let b = events.clone();
            let c = events.clone();
            let result = replace(
                || {
                    a.borrow_mut().push("destroy");
                    if failed == 0 {
                        Err("not confirmed".into())
                    } else {
                        Ok(())
                    }
                },
                || {
                    b.borrow_mut().push("release");
                    if failed == 1 {
                        Err("cancelled or not released".into())
                    } else {
                        Ok(())
                    }
                },
                || {
                    c.borrow_mut().push("create");
                    Ok(())
                },
            );
            assert!(result.is_err());
            assert!(!events.borrow().contains(&"create"));
        }
    }

    #[test]
    fn duplicate_recovery_is_rejected_until_first_releases_lock() {
        let lock = std::sync::Mutex::new(());
        let first = try_lock(&lock).unwrap();
        assert!(try_lock(&lock).is_err());
        drop(first);
        assert!(try_lock(&lock).is_ok());
    }

    #[test]
    fn create_failure_is_returned_without_extra_actions() {
        let events = Rc::new(RefCell::new(Vec::new()));
        let a = events.clone();
        let b = events.clone();
        let c = events.clone();
        assert!(replace(
            || {
                a.borrow_mut().push("destroy");
                Ok(())
            },
            || {
                b.borrow_mut().push("release");
                Ok(())
            },
            || {
                c.borrow_mut().push("create-failed");
                Err("create failed".into())
            },
        )
        .is_err());
        assert_eq!(*events.borrow(), ["destroy", "release", "create-failed"]);
    }

    #[test]
    fn hide_reentry_exit_and_old_generation_are_rejected() {
        assert!(workspace_valid(true, 1, 1, true));
        assert!(!workspace_valid(false, 1, 1, true));
        assert!(!workspace_valid(true, 1, 2, true));
        assert!(!workspace_valid(true, 1, 1, false));
        assert!(may_present(true, false, 3, 3, true));
        assert!(!may_present(true, true, 3, 3, true));
        assert!(!may_present(true, false, 4, 3, true));
        assert!(!may_present(true, false, 3, 3, false));
        assert!(!may_present(false, false, 3, 3, true));
    }
}
