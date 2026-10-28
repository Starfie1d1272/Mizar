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

#[cfg(test)]
mod tests {
    use super::*;

    fn input(kind: InputKind, name: &str) -> Input {
        Input {
            kind,
            name: name.into(),
        }
    }
    fn key(name: &str) -> Input {
        input(InputKind::Key, name)
    }
    fn axis(name: &str) -> Input {
        input(InputKind::Axis, name)
    }
    fn values(entries: &[(Input, &[&str])]) -> Bindings {
        entries
            .iter()
            .map(|(k, v)| (k.clone(), v.iter().map(|s| s.to_string()).collect()))
            .collect()
    }
    fn file(id: &str, owned: &[Input], o: Bindings, a: Bindings, c: Bindings) -> FileInput {
        FileInput {
            id: id.into(),
            owned: owned.iter().cloned().collect(),
            original: o,
            applied: a,
            current: c,
        }
    }
    fn one(file: FileInput) -> FilePlan {
        plan(&[file]).unwrap().remove("f").unwrap()
    }

    #[test]
    fn missing_empty_and_deletion_are_distinct() {
        let k = key("x");
        let empty = values(&[(k.clone(), &[""])]);
        let missing = Bindings::new();
        assert_eq!(
            one(file(
                "f",
                &[k.clone()],
                missing.clone(),
                empty.clone(),
                empty.clone()
            )),
            FilePlan::Restore([k.clone()].into())
        );
        assert_eq!(
            one(file(
                "f",
                &[k.clone()],
                empty.clone(),
                missing.clone(),
                missing.clone()
            )),
            FilePlan::Restore([k.clone()].into())
        );
        assert_eq!(
            one(file(
                "f",
                &[k.clone()],
                empty.clone(),
                missing.clone(),
                empty
            )),
            FilePlan::Unchanged
        );
    }

    #[test]
    fn unchanged_restorable_and_intermediate_values() {
        let k = key("x");
        let o = values(&[(k.clone(), &["personal"])]);
        let a = values(&[(k.clone(), &["preset"])]);
        assert_eq!(
            one(file("f", &[k.clone()], o.clone(), a.clone(), o.clone())),
            FilePlan::Unchanged
        );
        // C=A is observationally identical if the user independently chose A (ABA).
        assert_eq!(
            one(file("f", &[k.clone()], o.clone(), a.clone(), a.clone())),
            FilePlan::Restore([k.clone()].into())
        );
        let intermediate = values(&[(k.clone(), &["default"])]);
        assert_eq!(one(file("f", &[k], o, a, intermediate)), FilePlan::Conflict);
    }

    #[test]
    fn axes_duplicates_and_unowned_additions() {
        let k = key("mouse_x");
        let x = axis("mouse_x");
        let extra = key("new");
        let o = values(&[(x.clone(), &["old", "old2"]), (k.clone(), &["key"])]);
        let a = values(&[(x.clone(), &["new axis"]), (k.clone(), &["key"])]);
        let c = values(&[
            (x.clone(), &["new axis"]),
            (k.clone(), &["key"]),
            (extra, &["private command"]),
        ]);
        assert_eq!(
            one(file("f", &[x.clone(), k], o, a, c)),
            FilePlan::Restore([x].into())
        );
    }

    #[test]
    fn one_conflict_blocks_its_file_but_not_other_files() {
        let x = key("x");
        let y = key("y");
        let o = values(&[(x.clone(), &["o"]), (y.clone(), &["o"])]);
        let a = values(&[(x.clone(), &["a"]), (y.clone(), &["a"])]);
        let c = values(&[(x.clone(), &["a"]), (y.clone(), &["external"])]);
        let files = [
            file("f", &[x.clone(), y], o.clone(), a.clone(), c),
            file("g", &[x.clone()], o, a.clone(), a),
        ];
        let p = plan(&files).unwrap();
        assert_eq!(p["f"], FilePlan::Conflict);
        assert_eq!(p["g"], FilePlan::Restore([x].into()));
    }

    #[test]
    fn invalid_inputs_return_only_fixed_codes() {
        let k = key("x");
        let invalid = values(&[(k.clone(), &[])]);
        assert_eq!(
            plan(&[file("f", &[k], invalid, Bindings::new(), Bindings::new())]),
            Err(PlanError::EmptyValues)
        );
        let f = || file("f", &[], Bindings::new(), Bindings::new(), Bindings::new());
        assert_eq!(plan(&[f(), f()]), Err(PlanError::DuplicateFile));
    }
}
