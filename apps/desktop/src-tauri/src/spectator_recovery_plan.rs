//! Pure, per-file three-way planning for future spectator key recovery.
//! This module performs no I/O and does not establish ownership or write files.
use std::collections::{BTreeMap, BTreeSet};

/// A key and an axis with the same name are distinct fields.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) enum InputKind {
    Key,
    Axis,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct Input {
    pub kind: InputKind,
    pub name: String,
}

/// Each present field has one or more values, in file order. An absent map
/// entry is missing; a single empty string is an explicit empty binding.
/// Multiple values retain duplicate entries rather than collapsing them.
pub(crate) type Bindings = BTreeMap<Input, Vec<String>>;

pub(crate) struct FileInput {
    /// Opaque caller-supplied identity, not a path validated by this planner.
    pub id: String,
    pub owned: BTreeSet<Input>,
    pub original: Bindings,
    pub applied: Bindings,
    pub current: Bindings,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum FilePlan {
    Unchanged,
    /// Only these fields need restoring from the original input. All other
    /// current fields must be preserved by the eventual writer.
    Restore(BTreeSet<Input>),
    Conflict,
}

/// Fixed codes only: never return command values in diagnostics.
#[derive(Debug, Eq, PartialEq)]
pub(crate) enum PlanError {
    DuplicateFile,
    EmptyValues,
}

pub(crate) fn plan(files: &[FileInput]) -> Result<BTreeMap<String, FilePlan>, PlanError> {
    let mut result = BTreeMap::new();
    for file in files {
        if result.contains_key(&file.id) {
            return Err(PlanError::DuplicateFile);
        }
        if [&file.original, &file.applied, &file.current]
            .iter()
            .any(|bindings| bindings.values().any(Vec::is_empty))
        {
            return Err(PlanError::EmptyValues);
        }
        let mut restore = BTreeSet::new();
        let mut conflict = false;
        for key in &file.owned {
            let original = file.original.get(key);
            let applied = file.applied.get(key);
            let current = file.current.get(key);
            if current == original {
                continue;
            }
            if current == applied {
                restore.insert(key.clone());
            } else {
                conflict = true;
            }
        }
        let decision = if conflict {
            FilePlan::Conflict
        } else if restore.is_empty() {
            FilePlan::Unchanged
        } else {
            FilePlan::Restore(restore)
        };
        result.insert(file.id.clone(), decision);
    }
    Ok(result)
}
