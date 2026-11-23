//! Serializes cancellation with the irreversible submission of a preparation step.
use std::{collections::HashMap, sync::Mutex};
use tauri::Manager;

#[derive(Default)]
pub struct PreparationGate(Mutex<HashMap<String, bool>>);

impl PreparationGate {
    pub fn register_with(
        &self,
        id: String,
        accept: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let mut attempts = self.0.lock().map_err(|_| "启动取消状态不可用。")?;
        if attempts.get(&id).copied() == Some(true) {
            return Err("本次启动已取消，请重新启动工作台。".into());
        }
        accept()?;
        attempts.entry(id).or_insert(false);
        Ok(())
    }

    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let mut attempts = self.0.lock().map_err(|_| "启动取消状态不可用。")?;
        if let Some(cancelled) = attempts.get_mut(id) {
            *cancelled = true;
        }
        Ok(())
    }

    pub fn retire(&self, id: &str) {
        if let Ok(mut attempts) = self.0.lock() {
            attempts.remove(id);
        }
    }

    pub fn check(&self, id: Option<&str>) -> Result<(), String> {
        self.commit(id, || Ok(()))
    }

    pub fn commit<T>(
        &self,
        id: Option<&str>,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let attempts = self.0.lock().map_err(|_| "启动取消状态不可用。")?;
        if let Some(id) = id {
            match attempts.get(id).copied() {
                Some(false) => {}
                Some(true) => return Err("本次启动已取消，请重新启动工作台。".into()),
                None => return Err("本次启动已失效，请重新进入工作台。".into()),
            }
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
        let guarded_action = || {
            if let Some(verify) = self.verify {
                verify()?;
            }
            match self.exit {
                Some((exit, ticket)) => exit.commit(ticket, action),
                None => action(),
            }
        };
        match self.gate {
            Some(gate) => gate.commit(self.id, guarded_action),
            None => guarded_action(),
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

pub(crate) fn check_preparation(app: &tauri::AppHandle, id: Option<&str>) -> Result<(), String> {
    app.state::<PreparationGate>().check(id)
}

pub(crate) fn cancel_preparation(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    app.state::<PreparationGate>().cancel(id)
}

pub(crate) fn retire_preparation(app: &tauri::AppHandle, id: &str) {
    app.state::<PreparationGate>().retire(id);
}

pub(crate) fn preparation_ticket(app: &tauri::AppHandle, id: &str) -> Result<u64, String> {
    app.state::<crate::host_state::HostState>()
        .entry_ticket
        .lock()
        .map_err(|_| "启动状态不可用。")?
        .as_ref()
        .filter(|(saved, _)| saved == id)
        .map(|(_, ticket)| *ticket)
        .ok_or_else(|| "本次启动已失效，请重新进入工作台。".into())
}

#[cfg(test)]
mod tests {
    use super::PreparationGate;

    #[test]
    fn cancelled_or_retired_attempts_cannot_commit_after_many_subsequent_cancels() {
        let gate = PreparationGate::default();
        gate.register_with("id-0".into(), || Ok(())).unwrap();
        gate.cancel("id-0").unwrap();
        assert!(gate.check(Some("id-0")).is_err());
        assert!(gate.commit(Some("id-0"), || Ok(())).is_err());

        for i in 1..=300 {
            let id = format!("id-{i}");
            let prev = format!("id-{}", i - 1);
            gate.register_with(id.clone(), || Ok(())).unwrap();
            gate.retire(&prev);
            gate.cancel(&id).unwrap();
            assert!(gate.commit(Some(&id), || Ok(())).is_err());
        }

        // Retired and cancelled earlier IDs stay permanently rejected without 256-entry eviction.
        assert!(gate.commit(Some("id-0"), || Ok(())).is_err());
        assert!(gate.commit(Some("id-10"), || Ok(())).is_err());
        gate.register_with("live".into(), || Ok(())).unwrap();
        assert!(gate.commit(Some("live"), || Ok(())).is_ok());
        gate.retire("live");
        assert!(gate.commit(Some("live"), || Ok(())).is_err());
    }
}
