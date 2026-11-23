//! Ownership and document fencing of a pending workspace entry.

use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
struct EntryIntentState {
    document: u64,
    pending: Option<(String, u64)>,
    next_epoch: u64,
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
    pub(crate) fn issue_document(&self, id: String) -> Result<String, String> {
        let mut state = self.0.lock().map_err(|_| "进入状态不可用。")?;
        if state.active.is_some() {
            return Err("正在进入工作台，请稍候。".into());
        }
        let epoch = state.next_epoch;
        state.next_epoch = state.next_epoch.wrapping_add(1);
        state.pending = Some((id, epoch));
        Ok(format!("{}:{epoch}", state.document))
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
        if state.active.is_some() {
            return Err("正在进入工作台，请稍候。".into());
        }
        if !state
            .pending
            .as_ref()
            .is_some_and(|(owner, issued)| owner == &id && *issued == epoch)
        {
            return Err("进入已取消。".into());
        }
        state.pending = None;
        state.active = Some((id, false));
        Ok(())
    }
    pub(crate) fn cancel_with<T>(
        &self,
        id: &str,
        read: impl FnOnce() -> Result<T, String>,
    ) -> Result<(bool, T), String> {
        let mut state = self.0.lock().map_err(|_| "进入状态不可用。")?;
        let matched = if let Some((active, cancelled)) = state.active.as_mut() {
            if active == id {
                *cancelled = true;
                true
            } else {
                false
            }
        } else if state
            .pending
            .as_ref()
            .is_some_and(|(pending_id, _)| pending_id == id)
        {
            state.pending = None;
            true
        } else {
            false
        };
        Ok((matched, read()?))
    }
    pub(crate) fn cancel(&self, id: &str) -> Result<(), String> {
        self.cancel_with(id, || Ok(())).map(|_| ())
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
            if state
                .pending
                .as_ref()
                .is_some_and(|(pending_id, _)| pending_id == id)
            {
                state.pending = None;
            }
        }
    }
    pub(crate) fn cancel_all(&self) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some((_, cancelled)) = state.active.as_mut() {
            *cancelled = true;
        }
        state.pending = None;
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

pub(crate) fn validate_id(intent_id: &str) -> Result<(), String> {
    if intent_id.len() != 36
        || !intent_id
            .bytes()
            .all(|c| c.is_ascii_hexdigit() || c == b'-')
    {
        return Err("进入请求无效。".into());
    }
    Ok(())
}

pub(crate) fn begin(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    intent_id: String,
    document: String,
) -> Result<(), String> {
    crate::window_presentation::check_demo_main(&window)?;
    validate_id(&intent_id)?;
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
    fn pre_cancellation_and_late_cancel_are_scoped_to_specific_request_identity() {
        let intent = EntryIntent::default();
        let gate = PreparationGate::default();

        // 1. Delayed cancel A -> B issues token -> A cancel arrives -> B still begins; late A fails.
        let token_a = intent.issue_document("req-a".into()).unwrap();
        let token_b = intent.issue_document("req-b".into()).unwrap();
        assert!(intent.cancel("req-a").is_ok());
        assert!(intent
            .begin_with_gate(Some(&gate), "req-a".into(), &token_a)
            .is_err());
        assert!(intent
            .begin_with_gate(Some(&gate), "req-b".into(), &token_b)
            .is_ok());
        intent.finish("req-b");
        gate.retire("req-b");

        // 2. Cancel before begin(), followed by 300 unrelated cancels: late req-c must still fail.
        let token_c = intent.issue_document("req-c".into()).unwrap();
        assert!(intent.cancel("req-c").is_ok());
        for i in 1..=300 {
            assert!(intent.cancel(&format!("pre-{i}")).is_ok());
        }
        assert!(intent
            .begin_with_gate(Some(&gate), "req-c".into(), &token_c)
            .is_err());
        assert!(gate.commit(Some("req-c"), || Ok(())).is_err());

        // 3. Replaying a consumed token or stale page generation fails.
        assert!(intent.begin("replay".into(), &token_b).is_err());
        assert!(intent.begin("stale".into(), "999:0").is_err());
    }
}
