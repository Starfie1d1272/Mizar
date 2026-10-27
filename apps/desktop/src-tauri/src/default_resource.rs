//! Staged default resource reader. Do not connect to the runtime until the
//! Windows filesystem and concurrent replacement cases are validated.
use crate::default_resource_vpk::{self as vpk, Storage};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom},
    path::{Component, Path},
};

const FILE_LIMIT: u64 = 1024 * 1024;
const TREE_LIMIT: u64 = 32 * 1024 * 1024;
pub(crate) const PARSER_VERSION: &str = "mizar-default-resource-1";

#[derive(Debug)]
pub(crate) enum Error {
    Missing,
    SourceConflict,
    UnsafePath,
    Changed,
    Io(io::Error),
    Vpk(vpk::Error),
    InvalidVcfg(String),
    Limit,
}
impl From<vpk::Error> for Error {
    fn from(value: vpk::Error) -> Self {
        Self::Vpk(value)
    }
}
impl From<io::Error> for Error {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Source {
    Loose,
    VpkDirectory,
    VpkVolume(u16),
    IdenticalBoth,
}
#[derive(Debug)]
pub(crate) struct Resource {
    pub(crate) bytes: Vec<u8>,
    pub(crate) sha256: String,
    pub(crate) source: Source,
    pub(crate) parser_version: &'static str,
    pub(crate) bindings: BTreeMap<String, String>,
    pub(crate) analogbindings: BTreeMap<String, String>,
}
fn plain(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    true
}
fn parents(path: &Path) -> io::Result<()> {
    for ancestor in path
        .parent()
        .ok_or_else(|| io::Error::other("resource parent missing"))?
        .ancestors()
    {
        let metadata = fs::symlink_metadata(ancestor)?;
        if !metadata.is_dir() || !plain(&metadata) {
            return Err(io::Error::other("resource parent is not plain"));
        }
    }
    Ok(())
}
#[cfg(windows)]
fn identity(file: &File) -> io::Result<String> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    #[repr(C)]
    #[derive(Default)]
    struct Time {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Information {
        attributes: u32,
        creation: Time,
        access: Time,
        write: Time,
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(file: *mut c_void, information: *mut Information) -> i32;
    }
    let mut value = Information::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut value) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if value.links != 1 || value.attributes & 0x400 != 0 {
        return Err(io::Error::other("resource source is linked or reparsed"));
    }
    Ok(format!(
        "windows:{:x}:{:x}:{:x}",
        value.volume, value.index_high, value.index_low
    ))
}
#[cfg(not(windows))]
fn identity(file: &File) -> io::Result<String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    if metadata.nlink() != 1 {
        return Err(io::Error::other("resource source is hard-linked"));
    }
    Ok(format!("unix:{:x}:{:x}", metadata.dev(), metadata.ino()))
}
#[cfg(windows)]
fn verify_handle_path(file: &File, path: &Path) -> io::Result<()> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFinalPathNameByHandleW(
            file: *mut c_void,
            path: *mut u16,
            length: u32,
            flags: u32,
        ) -> u32;
    }
    let mut value = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            value.as_mut_ptr(),
            value.len() as u32,
            0,
        )
    };
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    if length as usize >= value.len() {
        return Err(io::Error::other("resource final path exceeds budget"));
    }
    let actual = String::from_utf16(&value[..length as usize]).map_err(io::Error::other)?;
    let expected = std::path::absolute(path)?;
    let expected = expected
        .to_str()
        .ok_or_else(|| io::Error::other("resource path encoding invalid"))?;
    let normalize = |value: &str| {
        value
            .replace('/', "\\")
            .trim_start_matches("\\\\?\\")
            .to_lowercase()
    };
    if normalize(&actual) != normalize(expected) {
        return Err(io::Error::other("resource handle escaped fixed path"));
    }
    Ok(())
}
fn checked(path: &Path) -> io::Result<(File, String)> {
    parents(path)?;
    let before = fs::symlink_metadata(path)?;
    if !before.is_file() || !plain(&before) {
        return Err(io::Error::other("resource source is not a plain file"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000).share_mode(0x1);
    }
    let file = options.open(path)?;
    let file_id = identity(&file)?;
    #[cfg(windows)]
    verify_handle_path(&file, path)?;
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::MetadataExt;
        let actual = file.metadata()?;
        if actual.ino() != before.ino() || actual.dev() != before.dev() {
            return Err(io::Error::other("resource source changed before open"));
        }
    }
    let named = File::open(path)?;
    if identity(&named)? != file_id || !plain(&file.metadata()?) {
        return Err(io::Error::other("resource source identity changed"));
    }
    Ok((file, file_id))
}

// Hold each ancestor without FILE_SHARE_DELETE, starting at the volume root,
// so a checked Windows directory cannot be renamed or replaced while reading.
// FILE_FLAG_OPEN_REPARSE_POINT prevents following the final component.
#[cfg(windows)]
fn hold_directories(path: &Path) -> Result<Vec<File>, Error> {
    use std::os::windows::fs::OpenOptionsExt;
    let mut ancestors: Vec<_> = path.ancestors().collect();
    ancestors.reverse();
    let mut held = Vec::new();
    for dir in ancestors {
        let meta = fs::symlink_metadata(dir)?;
        if !meta.is_dir() || !plain(&meta) {
            return Err(Error::UnsafePath);
        }
        let file = OpenOptions::new()
            .read(true)
            .share_mode(0x3)
            .custom_flags(0x02200000)
            .open(dir)?;
        if !plain(&file.metadata()?) || !file.metadata()?.is_dir() {
            return Err(Error::UnsafePath);
        }
        verify_handle_path(&file, dir).map_err(|_| Error::UnsafePath)?;
        held.push(file);
    }
    Ok(held)
}
#[cfg(not(windows))]
fn hold_directories(_path: &Path) -> Result<Vec<File>, Error> {
    Ok(Vec::new())
}

// Verify the same named file and stable size/mtime after every bounded read.
fn stable(path: &Path, file: &File, id: &str, before: &fs::Metadata) -> Result<(), Error> {
    parents(path).map_err(|_| Error::Changed)?;
    let (named, named_id) = checked(path).map_err(|_| Error::Changed)?;
    let after = file.metadata()?;
    let named_meta = named.metadata()?;
    if named_id != id
        || identity(file)? != id
        || after.len() != before.len()
        || after.modified()? != before.modified()?
        || named_meta.len() != after.len()
        || named_meta.modified()? != after.modified()?
    {
        return Err(Error::Changed);
    }
    Ok(())
}
fn open_optional(path: &Path) -> Result<Option<(File, String, fs::Metadata)>, Error> {
    match checked(path) {
        Ok((file, id)) => {
            let meta = file.metadata()?;
            Ok(Some((file, id, meta)))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) if e.kind() == io::ErrorKind::Other => Err(Error::UnsafePath),
        Err(e) => Err(Error::Io(e)),
    }
}
fn read_range(
    path: &Path,
    file: &mut File,
    id: &str,
    meta: &fs::Metadata,
    offset: u64,
    len: usize,
) -> Result<Vec<u8>, Error> {
    let end = offset.checked_add(len as u64).ok_or(Error::Limit)?;
    if end > meta.len() {
        return Err(Error::Vpk(vpk::Error::Truncated));
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = vec![0; len];
    file.read_exact(&mut bytes)?;
    stable(path, file, id, meta)?;
    Ok(bytes)
}
fn loose(path: &Path) -> Result<Option<Vec<u8>>, Error> {
    let Some((mut f, id, meta)) = open_optional(path)? else {
        return Ok(None);
    };
    if meta.len() > FILE_LIMIT {
        return Err(Error::Limit);
    }
    let bytes = read_range(path, &mut f, &id, &meta, 0, meta.len() as usize)?;
    std::str::from_utf8(&bytes).map_err(|_| Error::InvalidVcfg("invalid UTF-8".into()))?;
    Ok(Some(bytes))
}
fn packed(path: &Path, csgo: &Path) -> Result<Option<(Vec<u8>, Source)>, Error> {
    let Some((mut f, id, meta)) = open_optional(path)? else {
        return Ok(None);
    };
    let first = read_range(path, &mut f, &id, &meta, 0, 12)?;
    let version = u32::from_le_bytes(first[4..8].try_into().unwrap());
    let header = match version {
        1 => 12,
        2 => 28,
        _ => return Err(Error::Vpk(vpk::Error::Unsupported)),
    };
    let tree = u32::from_le_bytes(first[8..12].try_into().unwrap()) as u64;
    if tree > TREE_LIMIT {
        return Err(Error::Limit);
    }
    let prefix_len = tree.checked_add(header).ok_or(Error::Limit)?;
    let prefix = read_range(path, &mut f, &id, &meta, 0, prefix_len as usize)?;
    let entry = match vpk::find_default(&prefix, meta.len()) {
        Ok(entry) => entry,
        Err(vpk::Error::Missing) => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let (body, source) = match entry.storage {
        Storage::Directory { offset } => (
            read_range(path, &mut f, &id, &meta, offset, entry.body_len)?,
            Source::VpkDirectory,
        ),
        Storage::Volume { index, offset } => {
            let volume = csgo.join(format!("pak01_{index:03}.vpk"));
            let Some((mut vf, vid, vmeta)) = open_optional(&volume)? else {
                return Err(Error::Missing);
            };
            let b = read_range(&volume, &mut vf, &vid, &vmeta, offset, entry.body_len)?;
            stable(path, &f, &id, &meta)?;
            (b, Source::VpkVolume(index))
        }
    };
    Ok(Some((vpk::assemble(&entry, &body)?, source)))
}
fn section(text: &str, name: &str) -> Result<BTreeMap<String, String>, Error> {
    let pairs = crate::cs2_frame_rate::scalar_section(text, &["config", name])
        .map_err(Error::InvalidVcfg)?;
    let mut map = BTreeMap::new();
    for (key, value) in pairs {
        let normalized = key.value.to_ascii_lowercase();
        if normalized.is_empty() || map.insert(normalized, value.value).is_some() {
            return Err(Error::InvalidVcfg(format!(
                "duplicate or empty key in {name}"
            )));
        }
    }
    Ok(map)
}
/// `root` is the user-selected CS2 installation root; no user cfg is read.
pub(crate) fn read_default(root: &Path) -> Result<Resource, Error> {
    if !root.is_absolute()
        || root
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(Error::UnsafePath);
    }
    let csgo = root.join("game").join("csgo");
    let _csgo_guards = hold_directories(&csgo)?;
    let cfg = csgo.join("cfg");
    let _cfg_guards = match hold_directories(&cfg) {
        Ok(guards) => Some(guards),
        Err(Error::Io(e)) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let loose = if _cfg_guards.is_some() {
        loose(&cfg.join("user_keys_default.vcfg"))?
    } else {
        None
    };
    let packed = packed(&csgo.join("pak01_dir.vpk"), &csgo)?;
    let (bytes, source) = match (loose, packed) {
        (None, None) => return Err(Error::Missing),
        (Some(bytes), None) => (bytes, Source::Loose),
        (None, Some(value)) => value,
        (Some(a), Some((b, _))) if a == b => (a, Source::IdenticalBoth),
        (Some(_), Some(_)) => return Err(Error::SourceConflict),
    };
    let text =
        std::str::from_utf8(&bytes).map_err(|_| Error::InvalidVcfg("invalid UTF-8".into()))?;
    let bindings = section(text, "bindings")?;
    let analogbindings = section(text, "analogbindings")?;
    Ok(Resource {
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        bytes,
        source,
        parser_version: PARSER_VERSION,
        bindings,
        analogbindings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    // Excerpt from the fixed CS2 mirror recorded in #342, not an installation.
    // https://github.com/SteamTracking/GameTracking-CS2/blob/5278de99318192d682ec7f0e1cc3ea9449f10c6e/game/csgo/cfg/user_keys_default.vcfg
    const CFG: &[u8] = b"\"config\" { \"bindings\" { \"0\" \"slot10\" \"1\" \"slot1\" \"a\" \"+left\" } \"analogbindings\" { \"MOUSE_X\" \"yaw\" \"MOUSE_Y\" \"pitch\" } }";
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "mizar-resource-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(p.join("game/csgo/cfg")).unwrap();
            Self(p)
        }
        fn write_loose(&self, bytes: &[u8]) {
            fs::write(self.0.join("game/csgo/cfg/user_keys_default.vcfg"), bytes).unwrap();
        }
        fn write_vpk(&self, bytes: &[u8], volume: bool) {
            let mut tree = b"vcfg\0cfg\0user_keys_default\0".to_vec();
            tree.extend_from_slice(&0u32.to_le_bytes());
            tree.extend_from_slice(&0u16.to_le_bytes());
            tree.extend_from_slice(&(if volume { 3u16 } else { 0x7fff }).to_le_bytes());
            tree.extend_from_slice(&0u32.to_le_bytes());
            tree.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            tree.extend_from_slice(&0xffffu16.to_le_bytes());
            tree.extend_from_slice(b"\0\0\0");
            let mut dir = 0x55aa1234u32.to_le_bytes().to_vec();
            dir.extend_from_slice(&1u32.to_le_bytes());
            dir.extend_from_slice(&(tree.len() as u32).to_le_bytes());
            dir.extend_from_slice(&tree);
            if volume {
                fs::write(self.0.join("game/csgo/pak01_003.vpk"), bytes).unwrap();
            } else {
                dir.extend_from_slice(bytes);
            }
            fs::write(self.0.join("game/csgo/pak01_dir.vpk"), dir).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn loose_fixture_and_duplicate_keys() {
        let f = Fixture::new();
        f.write_loose(CFG);
        let r = read_default(&f.0).unwrap();
        assert_eq!(r.source, Source::Loose);
        assert_eq!(r.bytes, CFG);
        assert_eq!(r.bindings["0"], "slot10");
        assert_eq!(r.bindings["a"], "+left");
        assert_eq!(r.analogbindings["mouse_x"], "yaw");
        assert_eq!(r.sha256.len(), 64);
        f.write_loose(
            b"\"config\" { \"bindings\" { \"A\" \"x\" \"a\" \"x\" } \"analogbindings\" {} }",
        );
        assert!(matches!(read_default(&f.0), Err(Error::InvalidVcfg(_))));
    }
    #[test]
    fn vpk_and_conflict() {
        for volume in [false, true] {
            let f = Fixture::new();
            f.write_vpk(CFG, volume);
            let r = read_default(&f.0).unwrap();
            assert_eq!(
                r.source,
                if volume {
                    Source::VpkVolume(3)
                } else {
                    Source::VpkDirectory
                }
            );
            f.write_loose(CFG);
            assert_eq!(read_default(&f.0).unwrap().source, Source::IdenticalBoth);
            f.write_loose(b"different");
            assert!(matches!(read_default(&f.0), Err(Error::SourceConflict)));
        }
    }
    #[test]
    fn missing_and_malformed_are_explicit() {
        let f = Fixture::new();
        assert!(matches!(read_default(&f.0), Err(Error::Missing)));
        f.write_loose(b"\"config\" { \"bindings\" {} }");
        assert!(matches!(read_default(&f.0), Err(Error::InvalidVcfg(_))));
        f.write_vpk(CFG, false);
        fs::write(f.0.join("game/csgo/pak01_dir.vpk"), b"bad").unwrap();
        assert!(matches!(
            read_default(&f.0),
            Err(Error::Vpk(vpk::Error::Truncated))
        ));
    }
    #[cfg(windows)]
    #[test]
    fn held_directory_cannot_be_renamed() {
        let f = Fixture::new();
        let cfg = f.0.join("game/csgo/cfg");
        let guards = hold_directories(&cfg).unwrap();
        assert!(fs::rename(&cfg, f.0.join("game/csgo/moved")).is_err());
        drop(guards);
        fs::rename(&cfg, f.0.join("game/csgo/moved")).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn detects_replacement_after_open() {
        let f = Fixture::new();
        f.write_loose(CFG);
        let path = f.0.join("game/csgo/cfg/user_keys_default.vcfg");
        let (file, id, meta) = open_optional(&path).unwrap().unwrap();
        fs::rename(&path, f.0.join("old")).unwrap();
        fs::write(&path, CFG).unwrap();
        assert!(matches!(
            stable(&path, &file, &id, &meta),
            Err(Error::Changed)
        ));
    }
    #[test]
    fn rejects_duplicate_axis_and_missing_volume() {
        let f = Fixture::new();
        f.write_loose(b"\"config\" { \"bindings\" {} \"analogbindings\" { \"MOUSE_X\" \"yaw\" \"mouse_x\" \"yaw\" } }");
        assert!(matches!(read_default(&f.0), Err(Error::InvalidVcfg(_))));
        fs::remove_file(f.0.join("game/csgo/cfg/user_keys_default.vcfg")).unwrap();
        f.write_vpk(CFG, true);
        fs::remove_file(f.0.join("game/csgo/pak01_003.vpk")).unwrap();
        assert!(matches!(read_default(&f.0), Err(Error::Missing)));
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlinks() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let file = f.0.join("game/csgo/cfg/user_keys_default.vcfg");
        let other = f.0.join("other");
        fs::write(&other, CFG).unwrap();
        symlink(&other, &file).unwrap();
        assert!(matches!(read_default(&f.0), Err(Error::UnsafePath)));
        fs::remove_file(file).unwrap();
        fs::remove_dir(f.0.join("game/csgo/cfg")).unwrap();
        symlink(&f.0, f.0.join("game/csgo/cfg")).unwrap();
        assert!(matches!(read_default(&f.0), Err(Error::UnsafePath)));
    }
}
