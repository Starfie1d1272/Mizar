//! Bounded pin metadata and OS process identity for the existing Host log owner.
use super::{diagnostic_uuid, pin_identity, pin_source_name};
use chrono::Utc;
use serde_json::{json, Value};
use std::{collections::HashSet, fs, io, path::Path};

// The bridge is scoped to the existing local logs directory and UUID names.
// No HTTP endpoint, arbitrary path, copied body, or second retention owner.
fn read_bounded_json(path: &Path, maximum: u64) -> io::Result<Option<Value>> {
    #[cfg(windows)]
    let _parents = match crate::support_export::hold_directories(
        path.parent()
            .ok_or_else(|| io::Error::other("diagnostic parent missing"))?,
    ) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let (mut file, _) = match crate::support_export::checked(path) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if file.metadata()?.len() > maximum {
        return Err(io::Error::other("diagnostic delivery metadata budget"));
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    (&mut file).take(maximum + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum {
        return Err(io::Error::other("diagnostic delivery metadata budget"));
    }
    Ok(Some(serde_json::from_slice(&bytes)?))
}
pub(super) fn read_pin_json(path: &Path) -> io::Result<Option<Value>> {
    read_bounded_json(path, 1024 * 1024)
}
pub(super) fn remove_missing_ok(path: &Path) -> io::Result<()> {
    crate::support_export::remove_metadata(path)
}

fn validate_pin(receipt: &Value, id: &str) -> io::Result<()> {
    let kind = receipt["kind"].as_str().unwrap_or("");
    pin_identity(receipt, id, kind).map_err(io::Error::other)?;
    if !["incident", "export", "active"].contains(&kind)
        || diagnostic_uuid(receipt["producerRunId"].as_str()).is_none()
        || !matches!(receipt["state"].as_str(), Some("prepared" | "committed"))
        || !(receipt["expiresAt"]
            .as_str()
            .is_some_and(|value| chrono::DateTime::parse_from_rfc3339(value).is_ok())
            || (receipt["expiresAt"].is_null()
                && receipt["state"] == "committed"
                && matches!(kind, "incident" | "active")))
    {
        return Err(io::Error::other("invalid host pin identity or lifetime"));
    }
    let segments = receipt["segments"]
        .as_array()
        .filter(|segments| segments.len() <= 4096)
        .ok_or_else(|| io::Error::other("invalid host pin range"))?;
    for source in segments {
        if !source["name"].as_str().is_some_and(pin_source_name)
            || !source["bytes"]
                .as_u64()
                .is_some_and(|bytes| bytes <= 2 * 1024 * 1024)
            || !source["sha256"].as_str().is_some_and(|digest| {
                digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        {
            return Err(io::Error::other("invalid host pin source"));
        }
    }
    Ok(())
}

/// Runs before the writer starts. A complete interrupted prepare/commit is
/// recoverable; an ambiguous or truncated record remains in place and protects
/// all retained sources until its ownership can be established.
pub(super) fn recover_pin_metadata(directory: &Path) -> io::Result<Vec<Value>> {
    let pins = directory.join("host-pins");
    let entries = match fs::read_dir(&pins) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut outcomes = Vec::new();
    for (index, entry) in entries.enumerate() {
        if index >= 256 {
            return Err(io::Error::other("host pin recovery inventory budget"));
        }
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".partial") else {
            continue;
        };
        let recovered = (|| -> io::Result<()> {
            if diagnostic_uuid(Some(id)).is_none() {
                return Err(io::Error::other("invalid host pin filename"));
            }
            let candidate = read_pin_json(&entry.path())?
                .ok_or_else(|| io::Error::other("host pin recovery source missing"))?;
            validate_pin(&candidate, id)?;
            let target = pins.join(format!("{id}.json"));
            let previous = read_pin_json(&target)?;
            if let Some(previous) = &previous {
                validate_pin(previous, id)?;
                let mut expected = previous.clone();
                if previous["state"] == "prepared" && candidate["state"] == "committed" {
                    expected["state"] = json!("committed");
                    if matches!(previous["kind"].as_str(), Some("incident" | "active")) {
                        expected["expiresAt"] = Value::Null;
                    }
                }
                if expected != candidate {
                    return Err(io::Error::other("host pin recovery transition differs"));
                }
            }
            crate::support_export::recover_metadata(
                &entry.path(),
                &target,
                &candidate,
                previous.as_ref(),
            )
        })();
        outcomes.push(match recovered {
            Ok(()) => json!({"name":name,"result":"recovered"}),
            Err(error) => json!({"name":name,"result":"retained","reason":error.to_string()}),
        });
    }
    Ok(outcomes)
}

/// Unknown protection refuses deletion, while the caller may keep recording
/// within the ordinary byte budget. Receipt corruption is not a startup gate.
pub(super) fn pin_protection(directory: &Path) -> io::Result<(HashSet<String>, HashSet<String>)> {
    let pins = directory.join("host-pins");
    let entries = match fs::read_dir(&pins) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok((HashSet::new(), HashSet::new()))
        }
        Err(error) => return Err(error),
    };
    let mut protected = HashSet::new();
    let mut extra = HashSet::new();
    for (index, entry) in entries.enumerate() {
        if index >= 256 {
            return Err(io::Error::other("host pin protection inventory budget"));
        }
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name
            .strip_suffix(".json")
            .or_else(|| name.strip_suffix(".partial"))
        else {
            continue;
        };
        if diagnostic_uuid(Some(id)).is_none() {
            return Err(io::Error::other("invalid host pin filename"));
        }
        let Some(receipt) = read_pin_json(&entry.path())? else {
            continue;
        };
        validate_pin(&receipt, id)?;
        if receipt["expiresAt"]
            .as_str()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .is_some_and(|deadline| deadline < Utc::now())
        {
            continue;
        }
        for segment in receipt["segments"].as_array().unwrap() {
            let name = segment["name"].as_str().unwrap().to_owned();
            protected.insert(name.clone());
            if receipt["kind"] == "incident" && receipt["state"] == "committed" {
                extra.insert(name);
            }
        }
    }
    Ok((protected, extra))
}
