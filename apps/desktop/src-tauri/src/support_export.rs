//! Native save of already generated, bounded ZIP parts. No archive parsing or IPC body.
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path},
};

const MAX_BYTES: u64 = 256 * 1024 * 1024;
const MANIFEST_LIMIT: u64 = 1024 * 1024;
const PART_LIMIT: u64 = 18_874_368;

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
        .ok_or_else(|| io::Error::other("diagnostic parent missing"))?
        .ancestors()
    {
        let metadata = fs::symlink_metadata(ancestor)?;
        if !metadata.is_dir() || !plain(&metadata) {
            return Err(io::Error::other("diagnostic parent is not plain"));
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
        return Err(io::Error::other("diagnostic source is linked or reparsed"));
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
        return Err(io::Error::other("diagnostic source is hard-linked"));
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
        return Err(io::Error::other("diagnostic final path exceeds budget"));
    }
    let actual = String::from_utf16(&value[..length as usize]).map_err(io::Error::other)?;
    // Parents and the opened target are already checked and held against replacement.
    // Resolve DOS short names before comparing the final handle path.
    let expected = fs::canonicalize(path)?;
    let expected = expected
        .to_str()
        .ok_or_else(|| io::Error::other("diagnostic path encoding invalid"))?;
    let normalize = |value: &str| {
        value
            .replace('/', "\\")
            .trim_start_matches("\\\\?\\")
            .trim_end_matches('\\')
            .to_lowercase()
    };
    if normalize(&actual) != normalize(expected) {
        return Err(io::Error::other("diagnostic handle escaped fixed path"));
    }
    Ok(())
}
fn checked(path: &Path) -> io::Result<(File, String)> {
    parents(path)?;
    let before = fs::symlink_metadata(path)?;
    if !before.is_file() || !plain(&before) {
        return Err(io::Error::other("diagnostic source is not a plain file"));
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
            return Err(io::Error::other("diagnostic source changed before open"));
        }
    }
    let named = File::open(path)?;
    if identity(&named)? != file_id || !plain(&file.metadata()?) {
        return Err(io::Error::other("diagnostic source identity changed"));
    }
    Ok((file, file_id))
}

// Hold each ancestor without FILE_SHARE_DELETE, starting at the volume root,
// so a checked Windows directory cannot be renamed or replaced while reading.
// FILE_FLAG_OPEN_REPARSE_POINT prevents following the final component.
#[cfg(windows)]
fn hold_directories(path: &Path) -> io::Result<Vec<File>> {
    use std::os::windows::fs::OpenOptionsExt;
    let mut ancestors: Vec<_> = path.ancestors().collect();
    ancestors.reverse();
    let mut held = Vec::new();
    for dir in ancestors {
        let meta = fs::symlink_metadata(dir)?;
        if !meta.is_dir() || !plain(&meta) {
            return Err(io::Error::other("diagnostic directory is not plain"));
        }
        let file = OpenOptions::new()
            .read(true)
            .share_mode(0x3)
            .custom_flags(0x02200000)
            .open(dir)?;
        if !plain(&file.metadata()?) || !file.metadata()?.is_dir() {
            return Err(io::Error::other("diagnostic directory is not plain"));
        }
        verify_handle_path(&file, dir)?;
        held.push(file);
    }
    Ok(held)
}
#[cfg(not(windows))]
fn hold_directories(_path: &Path) -> io::Result<Vec<File>> {
    Err(io::Error::other("diagnostic directory is not plain"))
}

/// Temporary files are deleted through their original handle, never by a re-resolved path.
struct Pending(File, bool);
impl Drop for Pending {
    fn drop(&mut self) {
        if self.1 {
            return;
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            let delete: u8 = 1;
            unsafe {
                SetFileInformationByHandle(
                    self.0.as_raw_handle(),
                    4,
                    &delete as *const _ as *const _,
                    1,
                );
            }
        }
    }
}
#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn SetFileInformationByHandle(
        file: *mut std::ffi::c_void,
        class: u32,
        information: *const std::ffi::c_void,
        size: u32,
    ) -> i32;
}
fn create_pending(path: &Path, lease: bool) -> io::Result<Pending> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // DELETE permits handle-based rename/disposition. A lease is removed even on crash.
        options
            .access_mode(0x40000000 | 0x00010000)
            .share_mode(1)
            .custom_flags(0x00200000 | if lease { 0x04000000 } else { 0 });
    }
    #[cfg(not(windows))]
    let _ = lease;
    let pending = Pending(options.open(path)?, false);
    identity(&pending.0)?;
    #[cfg(windows)]
    verify_handle_path(&pending.0, path)?;
    Ok(pending)
}

// Rename the exact open output, not a pathname that could be substituted between close/rename.
// ReplaceIfExists is false: a racing or existing user file is never overwritten.
#[cfg(windows)]
fn publish(mut output: Pending, target: &Path) -> io::Result<()> {
    use std::{
        mem::{offset_of, size_of},
        os::windows::{ffi::OsStrExt, io::AsRawHandle},
    };
    #[repr(C)]
    struct Rename {
        flags: u32,
        root: *mut std::ffi::c_void,
        length: u32,
        name: [u16; 1],
    }
    let wide: Vec<u16> = target.as_os_str().encode_wide().collect();
    let bytes = offset_of!(Rename, name) + wide.len() * 2;
    // usize allocation provides the alignment required for FILE_RENAME_INFO.
    let mut buffer = vec![0usize; bytes.max(size_of::<Rename>()).div_ceil(size_of::<usize>())];
    let info = buffer.as_mut_ptr().cast::<Rename>();
    unsafe {
        (*info).length = (wide.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(
            wide.as_ptr(),
            std::ptr::addr_of_mut!((*info).name).cast::<u16>(),
            wide.len(),
        );
        if SetFileInformationByHandle(output.0.as_raw_handle(), 3, info.cast(), bytes as u32) == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    // Close without the temporary-file deletion guard, now that the final name is committed.
    output.1 = true;
    Ok(())
}
#[cfg(not(windows))]
fn publish(_output: Pending, _target: &Path) -> io::Result<()> {
    Err(io::Error::other("native diagnostic save requires Windows"))
}

fn bounded_read(file: &mut File, limit: u64) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::other("diagnostic file exceeds limit"));
    }
    Ok(bytes)
}
fn transfer(
    input: &mut File,
    mut output: Option<&mut File>,
    bytes: u64,
    digest: &str,
) -> io::Result<()> {
    let mut hash = Sha256::new();
    let mut count = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        count += n as u64;
        if count > bytes {
            return Err(io::Error::other("diagnostic source grew"));
        }
        hash.update(&buffer[..n]);
        if let Some(target) = output.as_mut() {
            target.write_all(&buffer[..n])?;
        }
    }
    if count != bytes || !format!("{:x}", hash.finalize()).eq_ignore_ascii_case(digest) {
        return Err(io::Error::other("diagnostic size or SHA-256 mismatch"));
    }
    Ok(())
}

/// Holds the source and lease across the native folder dialog, including cancellation.
/// Admission checks expiry once; an admitted save may finish after that deadline.
pub struct PreparedExport {
    export_id: String,
    files: Vec<(String, u64, String, File)>,
    manifest_bytes: Vec<u8>,
    single_file_name: Option<String>,
    _manifest: File,
    _lease: Pending,
    _directories: Vec<File>,
}
fn save_error(error: io::Error) -> String {
    format!("诊断包未能保存，请在有效期内重试或重新生成：{error}")
}
fn absolute(path: &Path) -> io::Result<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(io::Error::other(
            "diagnostic path must be absolute and normalized",
        ));
    }
    Ok(())
}
/// Only Host's state root and a controlled ID are accepted, never frontend paths/digests.
pub fn prepare_generated(state_root: &Path, export_id: &str) -> Result<PreparedExport, String> {
    prepare_inner(state_root, export_id).map_err(save_error)
}
fn prepare_inner(state_root: &Path, export_id: &str) -> io::Result<PreparedExport> {
    if export_id.len() != 36
        || !export_id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
    {
        return Err(io::Error::other("invalid export ID"));
    }
    absolute(state_root)?;
    let source = state_root.join("support-export").join(export_id);
    let _source_guard = hold_directories(&source)?;
    // The cleaner uses the same create_new lease before deciding to remove a directory.
    let _lease = create_pending(&source.join("saving.lease"), true)?;
    let (mut manifest_file, _) = checked(&source.join("generated.json"))?;
    let manifest_bytes = bounded_read(&mut manifest_file, MANIFEST_LIMIT)?;
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)?;
    if manifest["schema"] != "mizar-support-export/2"
        || manifest["exportId"] != export_id
        || manifest["phase"] != "ready"
    {
        return Err(io::Error::other("export is not ready"));
    }
    let date = |name: &str| -> io::Result<i64> {
        chrono::DateTime::parse_from_rfc3339(
            manifest[name]
                .as_str()
                .ok_or_else(|| io::Error::other("missing export lifetime"))?,
        )
        .map(|date| date.timestamp_millis())
        .map_err(io::Error::other)
    };
    let created = date("createdAt")?;
    let expires = date("expiresAt")?;
    let now = chrono::Utc::now().timestamp_millis();
    if created > now || expires <= now || expires <= created || expires - created > 15 * 60_000 {
        return Err(io::Error::other(
            "export has expired or has an invalid lifetime",
        ));
    }
    let parts = manifest["parts"]
        .as_array()
        .filter(|parts| !parts.is_empty() && parts.len() <= 32)
        .ok_or_else(|| io::Error::other("invalid export part list"))?;
    // Validate the entire list and open every source before touching the selected destination.
    let mut files = Vec::new();
    let mut total = 0;
    for (index, part) in parts.iter().enumerate() {
        let name = format!("part-{}.zip", index + 1);
        let bytes = part["bytes"]
            .as_u64()
            .filter(|bytes| *bytes > 0 && *bytes <= PART_LIMIT)
            .ok_or_else(|| io::Error::other("invalid export part size"))?;
        let digest = part["sha256"]
            .as_str()
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| io::Error::other("invalid export digest"))?;
        total += bytes;
        if part["name"] != name || total > MAX_BYTES {
            return Err(io::Error::other("invalid export name or total budget"));
        }
        let (input, _) = checked(&source.join(&name))?;
        if input.metadata()?.len() != bytes {
            return Err(io::Error::other("export source size changed"));
        }
        files.push((name, bytes, digest.to_owned(), input));
    }
    if manifest["outputBytes"].as_u64() != Some(total) {
        return Err(io::Error::other("export total does not match its parts"));
    }
    let single_file_name = if files.len() == 1 {
        Some(format!(
            "mizar-support-{}.zip",
            chrono::DateTime::from_timestamp_millis(created)
                .ok_or_else(|| io::Error::other("invalid export creation time"))?
                .format("%Y-%m-%dT%H-%M-%SZ")
        ))
    } else {
        None
    };
    Ok(PreparedExport {
        single_file_name,
        export_id: export_id.to_owned(),
        files,
        manifest_bytes,
        _manifest: manifest_file,
        _lease,
        _directories: _source_guard,
    })
}
impl PreparedExport {
    pub fn suggested_filename(&self) -> Option<&str> {
        self.single_file_name.as_deref()
    }
    /// Destination must come exclusively from the native dialog.
    pub fn save(self, destination: &Path) -> Result<(), String> {
        self.save_inner(destination).map_err(save_error)
    }
    fn save_inner(self, destination: &Path) -> io::Result<()> {
        absolute(destination)?;
        let Self {
            export_id,
            files,
            manifest_bytes,
            single_file_name,
            _manifest,
            _lease,
            _directories,
        } = self;
        let single = single_file_name.is_some();
        let target = if single {
            destination
                .parent()
                .ok_or_else(|| io::Error::other("save destination has no parent"))?
                .to_path_buf()
        } else {
            destination.join(format!("mizar-support-{export_id}"))
        };
        let parent = if single {
            target.as_path()
        } else {
            destination
        };
        let _destination_guard = hold_directories(parent)?;
        if !single {
            match fs::create_dir(&target) {
                Ok(()) => (),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
                Err(error) => return Err(error),
            }
        }
        let _target_guard = hold_directories(&target)?;
        for (name, bytes, digest, mut input) in files {
            let final_path = if single {
                destination.to_path_buf()
            } else {
                target.join(&name)
            };
            match fs::symlink_metadata(&final_path) {
                Ok(_) => {
                    let (mut existing, _) = checked(&final_path)?;
                    transfer(&mut existing, None, bytes, &digest)?;
                    continue;
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                Err(error) => return Err(error),
            }
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(io::Error::other)?
                .as_nanos();
            let mut pending =
                create_pending(&target.join(format!("{name}.{unique}.partial")), false)?;
            transfer(&mut input, Some(&mut pending.0), bytes, &digest)?;
            pending.0.sync_all()?;
            publish(pending, &final_path)?;
        }
        // A single ZIP already contains final coverage and indexes. The trusted source
        // manifest stays private in the cache and is needed only for multi-volume delivery.
        if single {
            return Ok(());
        }
        // The manifest is the completion marker; publish only after every part succeeds.
        let final_path = target.join("generated.json");
        match fs::symlink_metadata(&final_path) {
            Ok(_) => {
                let (mut existing, _) = checked(&final_path)?;
                if bounded_read(&mut existing, MANIFEST_LIMIT)? != manifest_bytes {
                    return Err(io::Error::other("destination has a different manifest"));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let unique = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(io::Error::other)?
                    .as_nanos();
                let mut pending =
                    create_pending(&target.join(format!("generated.{unique}.partial")), false)?;
                pending.0.write_all(&manifest_bytes)?;
                pending.0.sync_all()?;
                publish(pending, &final_path)?;
            }
            Err(error) => return Err(error),
        }
        Ok(())
    }
}
