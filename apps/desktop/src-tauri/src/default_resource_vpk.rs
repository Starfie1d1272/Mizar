//! Bounded, fixed-entry VPK directory parsing. This module is not wired into
//! the runtime: secure file opening and source conflict handling are separate work.
//!
//! Format reference: ValvePak Package.Read.cs, MIT license,
//! https://github.com/ValveResourceFormat/ValvePak/blob/6796d11731a52a303b2feb82193203b8731bfa2c/ValvePak/ValvePak/Package.Read.cs

const MAGIC: u32 = 0x55aa1234;
const TREE_LIMIT: usize = 32 * 1024 * 1024;
const ENTRY_LIMIT: usize = 250_000;
const RESOURCE_LIMIT: usize = 1024 * 1024;
const DIRECTORY_ARCHIVE: u16 = 0x7fff;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Error {
    Truncated,
    Unsupported,
    Limit,
    Invalid,
    Duplicate,
    Missing,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Storage {
    Directory { offset: u64 },
    Volume { index: u16, offset: u64 },
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Entry {
    pub(crate) storage: Storage,
    pub(crate) body_len: usize,
    pub(crate) preload: Vec<u8>,
}

fn u16_at(data: &[u8], at: usize) -> Result<u16, Error> {
    let b = data
        .get(at..at.checked_add(2).ok_or(Error::Invalid)?)
        .ok_or(Error::Truncated)?;
    Ok(u16::from_le_bytes([b[0], b[1]]))
}
fn u32_at(data: &[u8], at: usize) -> Result<u32, Error> {
    let b = data
        .get(at..at.checked_add(4).ok_or(Error::Invalid)?)
        .ok_or(Error::Truncated)?;
    Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}
fn cstr<'a>(tree: &'a [u8], pos: &mut usize) -> Result<&'a [u8], Error> {
    let remaining = tree.get(*pos..).ok_or(Error::Truncated)?;
    let end = remaining
        .iter()
        .position(|b| *b == 0)
        .ok_or(Error::Truncated)?;
    let value = &remaining[..end];
    *pos = pos.checked_add(end + 1).ok_or(Error::Invalid)?;
    Ok(value)
}

/// Input is exactly the header and directory tree, not the whole VPK. The
/// caller must obtain it with bounded reads and securely verify file identity.
/// `directory_file_len` is the size of the same opened directory file.
pub(crate) fn find_default(prefix: &[u8], directory_file_len: u64) -> Result<Entry, Error> {
    if u32_at(prefix, 0)? != MAGIC {
        return Err(Error::Invalid);
    }
    let version = u32_at(prefix, 4)?;
    let header = match version {
        1 => 12usize,
        2 => 28usize,
        _ => return Err(Error::Unsupported),
    };
    let tree_len = u32_at(prefix, 8)? as usize;
    if tree_len > TREE_LIMIT {
        return Err(Error::Limit);
    }
    let tree_end = header.checked_add(tree_len).ok_or(Error::Invalid)?;
    if prefix.len() < tree_end || directory_file_len < tree_end as u64 {
        return Err(Error::Truncated);
    }
    if prefix.len() != tree_end {
        return Err(Error::Invalid);
    }
    let data_len = if version == 2 {
        let file_data = u32_at(prefix, 12)? as u64;
        let total = (tree_end as u64)
            .checked_add(file_data)
            .and_then(|v| v.checked_add(u32_at(prefix, 16).ok()? as u64))
            .and_then(|v| v.checked_add(u32_at(prefix, 20).ok()? as u64))
            .and_then(|v| v.checked_add(u32_at(prefix, 24).ok()? as u64))
            .ok_or(Error::Truncated)?;
        if total != directory_file_len {
            return Err(Error::Invalid);
        }
        file_data
    } else {
        directory_file_len - tree_end as u64
    };
    let tree = &prefix[header..];
    let mut pos = 0;
    let mut count = 0usize;
    let mut found = None;
    loop {
        let ext = cstr(tree, &mut pos)?;
        if ext.is_empty() {
            break;
        }
        loop {
            let dir = cstr(tree, &mut pos)?;
            if dir.is_empty() {
                break;
            }
            loop {
                let name = cstr(tree, &mut pos)?;
                if name.is_empty() {
                    break;
                }
                count = count.checked_add(1).ok_or(Error::Limit)?;
                if count > ENTRY_LIMIT {
                    return Err(Error::Limit);
                }
                let metadata = tree
                    .get(pos..pos.checked_add(18).ok_or(Error::Invalid)?)
                    .ok_or(Error::Truncated)?;
                pos += 18;
                if u16_at(metadata, 16)? != 0xffff {
                    return Err(Error::Invalid);
                }
                let preload_len = u16_at(metadata, 4)? as usize;
                let archive = u16_at(metadata, 6)?;
                let offset = u32_at(metadata, 8)? as u64;
                let body_len = u32_at(metadata, 12)? as usize;
                let end = pos.checked_add(preload_len).ok_or(Error::Invalid)?;
                let preload = tree.get(pos..end).ok_or(Error::Truncated)?;
                pos = end;
                if ext.eq_ignore_ascii_case(b"vcfg")
                    && dir.eq_ignore_ascii_case(b"cfg")
                    && name.eq_ignore_ascii_case(b"user_keys_default")
                {
                    if found.is_some() {
                        return Err(Error::Duplicate);
                    }
                    if preload_len.checked_add(body_len).ok_or(Error::Limit)? > RESOURCE_LIMIT {
                        return Err(Error::Limit);
                    }
                    let body_end = offset.checked_add(body_len as u64).ok_or(Error::Invalid)?;
                    let storage = if archive == DIRECTORY_ARCHIVE {
                        if body_end > data_len {
                            return Err(Error::Truncated);
                        }
                        Storage::Directory {
                            offset: (tree_end as u64)
                                .checked_add(offset)
                                .ok_or(Error::Invalid)?,
                        }
                    } else if archive <= 999 {
                        Storage::Volume {
                            index: archive,
                            offset,
                        }
                    } else {
                        return Err(Error::Unsupported);
                    };
                    found = Some(Entry {
                        storage,
                        body_len,
                        preload: preload.to_vec(),
                    });
                }
            }
        }
    }
    if pos != tree.len() {
        return Err(Error::Invalid);
    }
    found.ok_or(Error::Missing)
}

/// Assemble only a body read from the selected offset, never a path from VPK.
pub(crate) fn assemble(entry: &Entry, body: &[u8]) -> Result<Vec<u8>, Error> {
    if body.len() != entry.body_len {
        return Err(Error::Truncated);
    }
    let size = entry
        .preload
        .len()
        .checked_add(body.len())
        .ok_or(Error::Limit)?;
    if size > RESOURCE_LIMIT {
        return Err(Error::Limit);
    }
    let mut bytes = Vec::with_capacity(size);
    bytes.extend_from_slice(&entry.preload);
    bytes.extend_from_slice(body);
    std::str::from_utf8(&bytes).map_err(|_| Error::Invalid)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(version: u32, archive: u16, offset: u32, body_len: u32, duplicate: bool) -> Vec<u8> {
        let mut tree = b"vcfg\0cfg\0".to_vec();
        for _ in 0..if duplicate { 2 } else { 1 } {
            tree.extend_from_slice(b"user_keys_default\0");
            tree.extend_from_slice(&0u32.to_le_bytes());
            tree.extend_from_slice(&2u16.to_le_bytes());
            tree.extend_from_slice(&archive.to_le_bytes());
            tree.extend_from_slice(&offset.to_le_bytes());
            tree.extend_from_slice(&body_len.to_le_bytes());
            tree.extend_from_slice(&0xffffu16.to_le_bytes());
            tree.extend_from_slice(b"ab");
        }
        tree.extend_from_slice(b"\0\0\0");
        let mut out = MAGIC.to_le_bytes().to_vec();
        out.extend_from_slice(&version.to_le_bytes());
        out.extend_from_slice(&(tree.len() as u32).to_le_bytes());
        if version == 2 {
            out.extend_from_slice(&[0; 16]);
        }
        out.extend_from_slice(&tree);
        out
    }
    #[test]
    fn external_and_preload() {
        let p = fixture(1, 7, 5, 2, false);
        let e = find_default(&p, p.len() as u64).unwrap();
        assert_eq!(
            e.storage,
            Storage::Volume {
                index: 7,
                offset: 5
            }
        );
        assert_eq!(assemble(&e, b"cd").unwrap(), b"abcd");
        assert_eq!(assemble(&e, b"c"), Err(Error::Truncated));
    }
    #[test]
    fn directory_data_v1_and_v2() {
        for v in [1, 2] {
            let mut p = fixture(v, DIRECTORY_ARCHIVE, 1, 2, false);
            if v == 2 {
                p[12..16].copy_from_slice(&3u32.to_le_bytes());
            }
            let e = find_default(&p, p.len() as u64 + 3).unwrap();
            assert_eq!(
                e.storage,
                Storage::Directory {
                    offset: p.len() as u64 + 1
                }
            );
        }
    }
    #[test]
    fn rejects_bad_metadata_and_bounds() {
        let p = fixture(1, 1000, 0, 0, false);
        assert_eq!(find_default(&p, p.len() as u64), Err(Error::Unsupported));
        let p = fixture(1, 0, 0, u32::MAX, false);
        assert_eq!(find_default(&p, p.len() as u64), Err(Error::Limit));
        let p = fixture(1, DIRECTORY_ARCHIVE, u32::MAX, 1, false);
        assert_eq!(find_default(&p, p.len() as u64), Err(Error::Truncated));
        let p = fixture(1, 0, 0, 0, true);
        assert_eq!(find_default(&p, p.len() as u64), Err(Error::Duplicate));
        for n in 0..p.len() {
            assert!(find_default(&p[..n], p.len() as u64).is_err());
        }
    }
    #[test]
    fn rejects_excessive_tree_and_oversized_preload_plus_body() {
        let mut p = fixture(1, 0, 0, 0, false);
        p[8..12].copy_from_slice(&((TREE_LIMIT + 1) as u32).to_le_bytes());
        assert_eq!(find_default(&p, p.len() as u64), Err(Error::Limit));
        let p = fixture(1, 0, 0, RESOURCE_LIMIT as u32, false);
        assert_eq!(find_default(&p, p.len() as u64), Err(Error::Limit));
    }
    #[test]
    fn rejects_unsupported_or_missing_and_non_utf8_body() {
        let mut p = fixture(1, 0, 0, 1, false);
        p[4..8].copy_from_slice(&3u32.to_le_bytes());
        assert_eq!(find_default(&p, p.len() as u64), Err(Error::Unsupported));
        p[4..8].copy_from_slice(&1u32.to_le_bytes());
        p[12] = b'x';
        assert_eq!(find_default(&p, p.len() as u64), Err(Error::Missing));
        let p = fixture(1, 0, 0, 1, false);
        let e = find_default(&p, p.len() as u64).unwrap();
        assert_eq!(assemble(&e, &[0xff]), Err(Error::Invalid));
    }
}
