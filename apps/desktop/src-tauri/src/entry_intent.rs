//! Ownership and document fencing of a pending workspace entry.

use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
struct EntryIntentState {
    document: u64,
    entry_epoch: u64,
    active: Option<(String, bool)>,
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
    pub(crate) fn issue_document(&self) -> Result<String, String> {
        let state = self.0.lock().map_err(|_| "进入状态不可用。")?;
        Ok(format!("{}:{}", state.document, state.entry_epoch))
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
        let Some((doc, epoch)) = document.split_once(':') else {
            return Err("进入页面已变化，请重新进入。".into());
        };
        let (Ok(doc), Ok(epoch)) = (doc.parse::<u64>(), epoch.parse::<u64>()) else {
            return Err("进入页面已变化，请重新进入。".into());
        };
        if doc != state.document {
            return Err("进入页面已变化，请重新进入。".into());
        }
        if epoch != state.entry_epoch {
            return Err("进入已取消。".into());
        }
        if state.active.is_some() {
            return Err("正在进入工作台，请稍候。".into());
        }
        state.entry_epoch = state.entry_epoch.wrapping_add(1);
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
        // Only bump the unstarted entry epoch when no intent or task owns an entry.
        if !matched && state.active.is_none() && record_pre_cancel(&value) {
            state.entry_epoch = state.entry_epoch.wrapping_add(1);
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
        }
    }
    pub(crate) fn cancel_all(&self) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some((_, cancelled)) = state.active.as_mut() {
            *cancelled = true;
        }
        state.document = state.document.wrapping_add(1);
        state.entry_epoch = state.entry_epoch.wrapping_add(1);
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
    fn pre_cancelled_and_replaced_requests_are_rejected_after_300_cancels() {
        let intent = EntryIntent::default();
        let gate = PreparationGate::default();

        // 1. Cancel before begin(), followed by 300 subsequent pre-cancellations: late A must still fail.
        let token_a = intent.issue_document().unwrap();
        assert!(intent.cancel("req-a").is_ok());
        for i in 1..=300 {
            assert!(intent.cancel(&format!("pre-{i}")).is_ok());
        }
        assert!(intent
            .begin_with_gate(Some(&gate), "req-a".into(), &token_a)
            .is_err());
        assert!(gate.commit(Some("req-a"), || Ok(())).is_err());

        // 2. Fresh entry after pre-cancellations succeeds, and invalid cancel while task B exists does not pollute epoch.
        let token_b = intent.issue_document().unwrap();
        assert!(intent
            .begin_with_gate(Some(&gate), "req-b".into(), &token_b)
            .is_ok());
        intent.finish("req-b");
        let token_c = intent.issue_document().unwrap();
        let cancelled = intent.cancel_with("unrelated", || Ok(()), |_| false);
        assert!(!cancelled.unwrap().0);
        assert!(intent
            .begin_with_gate(Some(&gate), "req-c".into(), &token_c)
            .is_ok());
        intent.finish("req-c");
        gate.retire("req-b");
        gate.retire("req-c");

        // 3. Replaying an already-consumed token or stale page generation fails.
        assert!(intent.begin("replay".into(), &token_c).is_err());
        assert!(intent.begin("stale".into(), "999:0").is_err());
    }
}
