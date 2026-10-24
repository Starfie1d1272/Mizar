//! The desktop owns the observer Job; helpers join it before starting their child.
use crate::windows_startup::RuntimeJob;
use std::{io, os::windows::process::CommandExt, process::{Command, Stdio}};

#[link(name = "kernel32")]
extern "system" {
    fn OpenJobObjectW(access: u32, inherit: i32, name: *const u16) -> isize;
    fn GetCurrentProcess() -> isize;
    fn AssignProcessToJobObject(job: isize, process: isize) -> i32;
    fn CloseHandle(handle: isize) -> i32;
}

pub fn name(session: &str) -> String { format!("Local\\MizarObserver-{session}") }

pub fn create(session: &str) -> io::Result<RuntimeJob> { RuntimeJob::named(&name(session)) }

pub fn run(args: &[String]) -> io::Result<i32> {
    let [job, python, rest @ ..] = args else { return Err(io::Error::other("observer_arguments")); };
    if !job.starts_with("Local\\MizarObserver-") { return Err(io::Error::other("observer_job_name")); }
    let wide: Vec<u16> = job.encode_utf16().chain(Some(0)).collect();
    let handle = unsafe { OpenJobObjectW(0x0001, 0, wide.as_ptr()) };
    if handle == 0 { return Err(io::Error::last_os_error()); }
    let assigned = unsafe { AssignProcessToJobObject(handle, GetCurrentProcess()) };
    let error = io::Error::last_os_error();
    // Only the desktop retains a Job handle while the observer is running.
    unsafe { CloseHandle(handle); }
    if assigned == 0 { return Err(error); }
    // This attempt owns a nested Job before Python can create descendants.
    // Killing the relay also closes this handle and reaps that attempt.
    let attempt = RuntimeJob::new()?;
    attempt.assign_current()?;
    let status = Command::new(python).args(rest).stdin(Stdio::inherit())
        .stdout(Stdio::inherit()).stderr(Stdio::inherit()).creation_flags(0x08000000).status()?;
    let code = status.code().unwrap_or(1);
    attempt.terminate_with_code(code as u32)?;
    Ok(code)
}
