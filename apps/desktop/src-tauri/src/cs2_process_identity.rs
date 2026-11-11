//! Persisted process identity shared by independent game transactions.
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct ProcessIdentity {
    pub pid: u32,
    pub created: u64,
    pub executable: String,
}
impl ProcessIdentity {
    pub(crate) fn read(record: &Value) -> Result<Option<Self>, String> {
        if record["pid"].is_null() && record["created"].is_null() {
            return Ok(None);
        }
        let identity: Self = serde_json::from_value(record.clone())
            .map_err(|_| "CS2 进程身份记录无效，恢复记录仍保留。")?;
        if identity.pid == 0 || identity.executable.is_empty() {
            return Err("CS2 进程身份记录无效，恢复记录仍保留。".into());
        }
        Ok(Some(identity))
    }
}
