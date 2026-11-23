//! Ownership and document fencing of a pending workspace entry.

use std::sync::Mutex;
use tauri::Manager;

const MAX_ENTRY_CANCELLED_IDS: usize = 256;

#[derive(Default)]
struct EntryIntentState {
    document: u64,
    active: Option<(String, bool)>,
    cancelled: std::collections::VecDeque<String>,
}
#[derive(Default)]
pub(crate) struct EntryIntent(Mutex<EntryIntentState>);
impl EntryIntent {
    pub(crate) fn generation(&self) -> Result<String, String> {
        Ok(self
            .0
            .lock()
            .map_err(|_| "进入状态不可用。")?
            .document
            .to_string())
    }
    pub(crate) fn try_generation(&self) -> Option<u64> {
        self.0.try_lock().ok().map(|state| state.document)
    }
    fn begin_with_gate(
        &self,
        gate: Option<&crate::preparation_gate::PreparationGate>,
        id: String,
        document: &str,
    ) -> Result<(), String> {
        // Keep lock order consistent with PreparationGate::commit -> EntryIntent::commit.
        if let Some(gate) = gate {
            return gate.register_with(id.clone(), || self.begin(id, document));
        }
        self.begin(id, document)
    }
    fn begin(&self, id: String, document: &str) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| "进入状态不可用。")?;
        if document != state.document.to_string() {
            state.cancelled.retain(|item| item != &id);
            return Err("进入页面已变化，请重新进入。".into());
        }
        if state.cancelled.iter().any(|existing| existing == &id) {
            state.cancelled.retain(|item| item != &id);
            return Err("进入已取消。".into());
        }
        if state.active.is_some() {
            return Err("正在进入工作台，请稍候。".into());
        }
        state.active = Some((id, false));
        Ok(())
    }
    pub(crate) fn cancel_with<T>(
        &self,
        id: &str,
        read: impl FnOnce() -> Result<T, String>,
        record_pre_cancel: impl FnOnce(&T) -> bool,
    ) -> Result<(bool, T), String> {
        let mut state = self.0.lock().map_err(|_| "进入状态不可用。")?;
        let matched = if let Some((active, cancelled)) = state.active.as_mut() {
            if active == id {
                *cancelled = true;
                true
            } else {
                false
            }
        } else {
            false
        };
        let value = read()?;
        if !matched
            && record_pre_cancel(&value)
            && !state.cancelled.iter().any(|existing| existing == id)
        {
            if state.cancelled.len() >= MAX_ENTRY_CANCELLED_IDS {
                state.cancelled.pop_front();
            }
            state.cancelled.push_back(id.to_owned());
        }
        Ok((matched, value))
    }
    pub(crate) fn cancel(&self, id: &str) -> Result<(), String> {
        self.cancel_with(id, || Ok(()), |_| true).map(|_| ())
    }
    pub(crate) fn finish(&self, id: &str) {
        if let Ok(mut state) = self.0.lock() {
            if state
                .active
                .as_ref()
                .is_some_and(|(active, _)| active == id)
            {
                state.active = None;
            }
            state.cancelled.retain(|item| item != id);
        }
    }
    pub(crate) fn cancel_all(&self) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some((_, cancelled)) = state.active.as_mut() {
            *cancelled = true;
        }
        state.cancelled.clear();
        state.document = state.document.wrapping_add(1);
    }
    pub(crate) fn commit<T>(
        &self,
        id: &str,
        consume: bool,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self.0.lock().map_err(|_| "进入状态不可用。")?;
        if !state
            .active
            .as_ref()
            .is_some_and(|(active, cancelled)| active == id && !cancelled)
        {
            return Err("进入已取消。".into());
        }
        let result = action();
        if consume && result.is_ok() {
            state.active = None;
        }
        result
    }
    pub(crate) fn publish(
        &self,
        id: &str,
        valid_page: impl FnOnce() -> bool,
        show: impl FnOnce(u64),
    ) -> bool {
        let state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if !state
            .active
            .as_ref()
            .is_some_and(|(active, cancelled)| active == id && !cancelled)
            || !valid_page()
        {
            return false;
        }
        show(state.document);
        true
    }
}

pub(crate) fn begin(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    intent_id: String,
    document: String,
) -> Result<(), String> {
    crate::window_presentation::check_demo_main(&window)?;
    if intent_id.len() != 36
        || !intent_id
            .bytes()
            .all(|c| c.is_ascii_hexdigit() || c == b'-')
    {
        return Err("进入请求无效。".into());
    }
    app.state::<EntryIntent>().begin_with_gate(
        Some(
            app.state::<crate::preparation_gate::PreparationGate>()
                .inner(),
        ),
        intent_id,
        &document,
    )
}

#[cfg(test)]
mod tests {
    use super::EntryIntent;
    use crate::preparation_gate::PreparationGate;

    #[test]
    fn active_intent_and_gate_reject_stale_and_replaced_commits_across_300_cancels() {
        let intent = EntryIntent::default();
        let gate = PreparationGate::default();
        let doc = intent.generation().unwrap();

        assert!(intent
            .begin_with_gate(Some(&gate), "id-0".into(), &doc)
            .is_ok());
        assert!(intent.cancel("id-0").is_ok());
        assert!(intent.commit("id-0", false, || Ok(())).is_err());
        intent.finish("id-0");
        gate.retire("id-0");

        for i in 1..=300 {
            let id = format!("id-{i}");
            assert!(intent
                .begin_with_gate(Some(&gate), id.clone(), &doc)
                .is_ok());
            // Task cancel after handoff must not pollute pre-cancel history.
            let cancelled = intent.cancel_with(&id, || Ok(()), |_| false);
            assert!(cancelled.unwrap().0);
            intent.finish(&id);
            gate.retire(&id);
        }

        assert!(intent.commit("id-0", false, || Ok(())).is_err());
        assert!(gate.commit(Some("id-0"), || Ok(())).is_err());
        assert!(intent.begin("stale".into(), "999").is_err());
    }
}
