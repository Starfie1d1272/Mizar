//! Serializes cancellation with the irreversible submission of a preparation step.
use std::{collections::HashSet, sync::Mutex};

#[derive(Default)]
pub struct PreparationGate(Mutex<HashSet<String>>);

impl PreparationGate {
    pub fn cancel(&self, id: String) -> Result<(), String> {
        let mut cancelled = self.0.lock().map_err(|_| "启动取消状态不可用。")?;
        if cancelled.len() >= 1024 && !cancelled.contains(&id) {
            return Err("启动取消记录已满，请重新启动 Mizar。".into());
        }
        cancelled.insert(id);
        Ok(())
    }

    pub fn check(&self, id: Option<&str>) -> Result<(), String> {
        self.commit(id, || Ok(()))
    }

    pub fn commit<T>(
        &self,
        id: Option<&str>,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let cancelled = self.0.lock().map_err(|_| "启动取消状态不可用。")?;
        if id.is_some_and(|id| cancelled.contains(id)) {
            return Err("本次启动已取消，请重新启动工作台。".into());
        }
        // Cancellation cannot return while this submission is in progress.
        action()
    }
}

pub struct PreparationGuard<'a> {
    pub gate: Option<&'a PreparationGate>,
    pub id: Option<&'a str>,
}

impl PreparationGuard<'_> {
    pub fn check(&self) -> Result<(), String> {
        match self.gate {
            Some(gate) => gate.check(self.id),
            None => Ok(()),
        }
    }
    pub fn commit<T>(&self, action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        match self.gate {
            Some(gate) => gate.commit(self.id, action),
            None => action(),
        }
    }
}

/// A submitted request may still start the game; its durable record must stay.
pub fn recover_unsubmitted<T>(
    outcome: Result<T, String>,
    submitted: bool,
    recover: impl FnOnce() -> Result<(), String>,
) -> Result<T, String> {
    match outcome {
        Err(error) if !submitted => {
            recover().map_err(|cause| format!("{error}；原配置恢复未完成：{cause}"))?;
            Err(error)
        }
        result => result,
    }
}

/// A late game launch can still consume the launcher's options after a timeout.
pub fn may_restore_launch_options(submitted: bool, confirmed: bool) -> bool {
    !submitted || confirmed
}

pub fn may_recover_mulnx_journal(
    expected: Option<&str>,
    actual: Option<&str>,
    mulnx: bool,
) -> bool {
    expected.is_none() || (mulnx && expected == actual)
}

#[cfg(test)]
mod tests {
    use super::{
        may_recover_mulnx_journal, may_restore_launch_options, recover_unsubmitted, PreparationGate,
    };
    use std::{
        sync::{mpsc, Arc},
        thread,
        time::Duration,
    };

    #[test]
    fn cancellation_before_commit_prevents_the_action() {
        let gate = PreparationGate::default();
        gate.cancel("entry".into()).unwrap();
        assert!(gate
            .commit(Some("entry"), || -> Result<(), String> {
                panic!("cancelled action ran")
            })
            .is_err());
        assert_eq!(gate.commit(Some("other"), || Ok(42)), Ok(42));
    }

    #[test]
    fn cancellation_waits_for_a_submission_already_in_progress() {
        let gate = Arc::new(PreparationGate::default());
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker_gate = Arc::clone(&gate);
        let worker = thread::spawn(move || {
            worker_gate.commit(Some("entry"), || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
        });
        started_rx.recv().unwrap();
        let (cancelled_tx, cancelled_rx) = mpsc::channel();
        let (cancel_started_tx, cancel_started_rx) = mpsc::channel();
        let cancel_gate = Arc::clone(&gate);
        let cancel = thread::spawn(move || {
            cancel_started_tx.send(()).unwrap();
            cancel_gate.cancel("entry".into()).unwrap();
            cancelled_tx.send(()).unwrap();
        });
        cancel_started_rx.recv().unwrap();
        assert!(cancelled_rx
            .recv_timeout(Duration::from_millis(50))
            .is_err());
        release_tx.send(()).unwrap();
        worker.join().unwrap().unwrap();
        cancelled_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        cancel.join().unwrap();
        assert!(gate.check(Some("entry")).is_err());
    }

    #[test]
    fn failure_only_recovers_a_request_that_was_never_submitted() {
        use std::cell::Cell;
        let recovered = Cell::new(0);
        let result: Result<(), String> = recover_unsubmitted(Err("failed".into()), false, || {
            recovered.set(recovered.get() + 1);
            Ok(())
        });
        assert_eq!(result, Err("failed".into()));
        assert_eq!(recovered.get(), 1);
        let result: Result<(), String> = recover_unsubmitted(Err("uncertain".into()), true, || {
            panic!("submitted request must remain pending")
        });
        assert_eq!(result, Err("uncertain".into()));
        let result: Result<(), String> =
            recover_unsubmitted(Err("failed".into()), false, || Err("restore failed".into()));
        assert_eq!(
            result,
            Err("failed；原配置恢复未完成：restore failed".into())
        );
    }

    #[test]
    fn uncertain_submitted_launch_keeps_options_until_its_result_is_known() {
        assert!(may_restore_launch_options(false, false));
        assert!(may_restore_launch_options(true, true));
        assert!(!may_restore_launch_options(true, false));
    }

    #[test]
    fn recovery_cannot_take_another_launch_transaction() {
        assert!(may_recover_mulnx_journal(
            Some("entry"),
            Some("entry"),
            true
        ));
        assert!(!may_recover_mulnx_journal(
            Some("entry"),
            Some("other"),
            true
        ));
        assert!(!may_recover_mulnx_journal(
            Some("entry"),
            Some("entry"),
            false
        ));
        assert!(!may_recover_mulnx_journal(Some("entry"), None, true));
    }
}
