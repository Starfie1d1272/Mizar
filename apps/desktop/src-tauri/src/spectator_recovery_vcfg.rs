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
