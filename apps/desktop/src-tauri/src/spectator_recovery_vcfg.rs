//! Translation between bounded vcfg text and the pure recovery plan.
//! No file access or ownership decisions are made here.
use crate::cs2_frame_rate::scalar_section_with_end;
use crate::spectator_recovery_plan::{self, Bindings, FileInput, FilePlan, Input, InputKind};
use std::collections::BTreeSet;

const LIMIT: usize = 256 * 1024;

struct Section {
    entries: Vec<(crate::cs2_frame_rate::Token, crate::cs2_frame_rate::Token)>,
    end: usize,
}

fn section(text: &str, kind: &InputKind) -> Result<Section, &'static str> {
    let name = match kind {
        InputKind::Key => "bindings",
        InputKind::Axis => "analogbindings",
    };
    let (entries, end) =
        scalar_section_with_end(text, &["config", name]).map_err(|_| "invalid_vcfg")?;
    Ok(Section { entries, end })
}

fn bindings(keys: &Section, axes: &Section) -> Bindings {
    let mut result = Bindings::new();
    for (kind, section) in [(InputKind::Key, keys), (InputKind::Axis, axes)] {
        for (key, value) in &section.entries {
            result
                .entry(Input {
                    kind: kind.clone(),
                    name: key.value.clone(),
                })
                .or_default()
                .push(value.value.clone());
        }
    }
    result
}

/// Parse both supported sections without normalizing the original key spelling.
pub(crate) fn parse_bindings(text: &str) -> Result<Bindings, &'static str> {
    if text.len() > LIMIT {
        return Err("file_too_large");
    }
    Ok(bindings(
        &section(text, &InputKind::Key)?,
        &section(text, &InputKind::Axis)?,
    ))
}

/// Build a forward write from a trusted candidate while preserving all fields
/// outside the explicitly owned set. This performs no file I/O.
pub(crate) fn plan_application(
    original: &str,
    candidate: &str,
    expected: &Bindings,
    owned: &BTreeSet<Input>,
) -> Result<String, &'static str> {
    if original.len() > LIMIT || candidate.len() > LIMIT {
        return Err("file_too_large");
    }
    if owned.is_empty()
        || expected.keys().any(|field| !owned.contains(field))
        || expected.values().any(Vec::is_empty)
    {
        return Err("invalid_plan");
    }
    let original_keys = section(original, &InputKind::Key)?;
    let original_axes = section(original, &InputKind::Axis)?;
    let candidate_keys = section(candidate, &InputKind::Key)?;
    let candidate_axes = section(candidate, &InputKind::Axis)?;
    let before = bindings(&original_keys, &original_axes);
    let candidate_values = bindings(&candidate_keys, &candidate_axes);
    for field in owned {
        if candidate_values.get(field) != expected.get(field) {
            return Err("invalid_plan");
        }
    }
    // Reuse the inverse three-way patch: candidate is the desired original,
    // while the current original is the known applied state of that inverse.
    let scoped_before: Bindings = before
        .iter()
        .filter(|(field, _)| owned.contains(*field))
        .map(|(field, values)| (field.clone(), values.clone()))
        .collect();
    let output = restore(candidate, &scoped_before, original, owned)?
        .unwrap_or_else(|| original.to_string());
    let after = bindings(
        &section(&output, &InputKind::Key)?,
        &section(&output, &InputKind::Axis)?,
    );
    for field in owned {
        if after.get(field) != expected.get(field) {
            return Err("invalid_plan");
        }
    }
    for (field, values) in &before {
        if !owned.contains(field) && after.get(field) != Some(values) {
            return Err("invalid_plan");
        }
    }
    Ok(output)
}

/// Returns None for no change, an updated file for safe restoration, or a
/// fixed error code. The caller must revalidate identity and bytes before I/O.
pub(crate) fn restore(
    original: &str,
    applied: &Bindings,
    current: &str,
    owned: &BTreeSet<Input>,
) -> Result<Option<String>, &'static str> {
    if original.len() > LIMIT || current.len() > LIMIT {
        return Err("file_too_large");
    }
    let original_keys = section(original, &InputKind::Key)?;
    let original_axes = section(original, &InputKind::Axis)?;
    let current_keys = section(current, &InputKind::Key)?;
    let current_axes = section(current, &InputKind::Axis)?;
    let file = FileInput {
        id: "file".into(),
        owned: owned.clone(),
        original: bindings(&original_keys, &original_axes),
        applied: applied.clone(),
        current: bindings(&current_keys, &current_axes),
    };
    let decision = spectator_recovery_plan::plan(&[file])
        .map_err(|_| "invalid_plan")?
        .remove("file")
        .ok_or("invalid_plan")?;
    let fields = match decision {
        FilePlan::Unchanged => return Ok(None),
        FilePlan::Conflict => return Err("conflict"),
        FilePlan::Restore(fields) => fields,
    };
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for (kind, before, now) in [
        (InputKind::Key, &original_keys, &current_keys),
        (InputKind::Axis, &original_axes, &current_axes),
    ] {
        let mut insert = String::new();
        for (key, value) in &before.entries {
            if fields.contains(&Input {
                kind: kind.clone(),
                name: key.value.clone(),
            }) {
                insert.push_str("\n");
                insert.push_str(&original[key.start..value.end]);
            }
        }
        for (key, value) in &now.entries {
            if fields.contains(&Input {
                kind: kind.clone(),
                name: key.value.clone(),
            }) {
                edits.push((key.start, value.end, String::new()));
            }
        }
        if !insert.is_empty() {
            edits.push((now.end, now.end, insert));
        }
    }
    edits.sort_by_key(|edit| edit.0);
    let mut output = current.to_string();
    for (start, end, replacement) in edits.into_iter().rev() {
        output.replace_range(start..end, &replacement);
    }
    if output.len() > LIMIT {
        return Err("file_too_large");
    }
    Ok(Some(output))
}
