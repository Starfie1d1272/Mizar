//! Serializes cancellation with the irreversible submission of a preparation step.
use std::{
    collections::{HashSet, VecDeque},
    sync::Mutex,
};
use tauri::Manager;

const MAX_CANCELLED_IDS: usize = 256;

#[derive(Default)]
struct GateState {
    cancelled: HashSet<String>,
    order: VecDeque<String>,
}

#[derive(Default)]
pub struct PreparationGate(Mutex<GateState>);

impl PreparationGate {
    pub fn cancel(&self, id: String) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| "启动取消状态不可用。")?;
        if state.cancelled.insert(id.clone()) {
            state.order.push_back(id);
            while state.cancelled.len() > MAX_CANCELLED_IDS {
                let Some(oldest) = state.order.pop_front() else {
                    break;
                };
                state.cancelled.remove(&oldest);
            }
        }
        Ok(())
    }

    pub fn retire(&self, id: &str) {
        let Ok(mut state) = self.0.lock() else {
            return;
        };
        if state.cancelled.remove(id) {
            state.order.retain(|item| item != id);
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
        let state = self.0.lock().map_err(|_| "启动取消状态不可用。")?;
        if id.is_some_and(|id| state.cancelled.contains(id)) {
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
