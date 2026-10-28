//! Shared, optional identity for a coordinated core/full session.
//! No identity is inferred for older records.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ConfigIdentity {
    pub account: u32,
    pub video: PathBuf,
    pub executable: PathBuf,
    pub keys: PathBuf,
    pub slot: u32,
    pub format: String,
}

impl ConfigIdentity {
    pub(crate) fn from_value(value: &Value) -> Result<Self, &'static str> {
        let account = value["account"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .filter(|n| *n != 0)
            .ok_or("invalid_identity")?;
        let path = |name: &str| -> Result<PathBuf, &'static str> {
            let value = value[name]
                .as_str()
                .filter(|v| Path::new(v).is_absolute())
                .ok_or("invalid_identity")?;
            Ok(PathBuf::from(value))
        };
        let slot = value["slot"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .ok_or("invalid_identity")?;
        let format = value["format"]
            .as_str()
            .filter(|s| *s == "vcfg")
            .ok_or("invalid_identity")?;
        Ok(Self {
            account,
            video: path("video")?,
            executable: path("executable")?,
            keys: path("keys")?,
            slot,
            format: format.into(),
        })
    }
    pub(crate) fn value(&self) -> Value {
        json!({"account":self.account,"video":self.video,"executable":self.executable,"keys":self.keys,"slot":self.slot,"format":self.format})
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionIdentity {
    pub session_id: String,
    pub config: ConfigIdentity,
}
impl SessionIdentity {
    pub(crate) fn read(record: &Value) -> Result<Option<Self>, &'static str> {
        match (record.get("sessionId"), record.get("configIdentity")) {
            (None, None) => Ok(None),
            (Some(id), Some(config)) => {
                let id = id
                    .as_str()
                    .filter(|v| {
                        !v.is_empty()
                            && v.len() <= 128
                            && v.bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                    })
                    .ok_or("invalid_session")?;
                Ok(Some(Self {
                    session_id: id.into(),
                    config: ConfigIdentity::from_value(config)?,
                }))
            }
            _ => Err("invalid_session"),
        }
    }
    pub(crate) fn write(&self, record: &mut Value) -> Result<(), &'static str> {
        let object = record.as_object_mut().ok_or("invalid_session")?;
        object.insert("sessionId".into(), json!(self.session_id));
        object.insert("configIdentity".into(), self.config.value());
        if Self::read(record)?.as_ref() != Some(self) {
            return Err("invalid_session");
        }
        Ok(())
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum Relation {
    Same,
    Different,
    Legacy,
}
pub(crate) fn compare(a: Option<&SessionIdentity>, b: Option<&SessionIdentity>) -> Relation {
    match (a, b) {
        (Some(a), Some(b)) if a == b => Relation::Same,
        (Some(_), Some(_)) => Relation::Different,
        _ => Relation::Legacy,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(id: &str) -> SessionIdentity {
        let root = std::env::temp_dir();
        SessionIdentity {
            session_id: id.into(),
            config: ConfigIdentity {
                account: 42,
                video: root.join("video"),
                executable: root.join("cs2.exe"),
                keys: root.join("keys"),
                slot: 0,
                format: "vcfg".into(),
            },
        }
    }
    #[test]
    fn roundtrip_and_compare_require_both_identity_and_id() {
        let a = sample("session-1");
        let mut record = json!({"version":1});
        a.write(&mut record).unwrap();
        let bytes = serde_json::to_vec(&record).unwrap();
        let loaded = SessionIdentity::read(&serde_json::from_slice::<Value>(&bytes).unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(compare(Some(&a), Some(&loaded)), Relation::Same);
        assert_eq!(
            compare(Some(&a), Some(&sample("session-2"))),
            Relation::Different
        );
        let mut other = a.clone();
        other.config.account = 43;
        assert_eq!(compare(Some(&a), Some(&other)), Relation::Different);
        assert_eq!(compare(Some(&a), None), Relation::Legacy);
        assert_eq!(compare(None, None), Relation::Legacy);
    }
    #[test]
    fn old_and_malformed_records_are_not_adopted() {
        assert_eq!(SessionIdentity::read(&json!({"version":1})).unwrap(), None);
        assert!(SessionIdentity::read(&json!({"sessionId":"s"})).is_err());
        let mut value = json!({});
        sample("s").write(&mut value).unwrap();
        value["configIdentity"]["account"] = json!(0);
        assert!(SessionIdentity::read(&value).is_err());
    }
}
