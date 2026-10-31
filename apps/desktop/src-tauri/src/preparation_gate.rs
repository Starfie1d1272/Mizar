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
    pub verify: Option<&'a dyn Fn() -> Result<(), String>>,
    pub exit: Option<(&'a crate::production_exit::ExitGate, u64)>,
}

impl PreparationGuard<'_> {
    pub fn check(&self) -> Result<(), String> {
        match self.gate {
            Some(gate) => gate.check(self.id),
            None => Ok(()),
        }?;
        if let Some(verify) = self.verify {
            verify()?;
        }
        Ok(())
    }
    pub fn commit<T>(&self, action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        match self.gate {
            Some(gate) => gate.commit(self.id, || {
                if let Some(verify) = self.verify {
                    verify()?;
                }
                match self.exit {
                    Some((exit, ticket)) => exit.commit(ticket, action),
                    None => action(),
                }
            }),
            None => {
                if let Some(verify) = self.verify {
                    verify()?;
                }
                match self.exit {
                    Some((exit, ticket)) => exit.commit(ticket, action),
                    None => action(),
                }
            }
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
