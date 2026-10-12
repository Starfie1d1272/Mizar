use std::{
    ffi::c_void,
    fs,
    os::windows::{fs::OpenOptionsExt, process::CommandExt},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
#[link(name = "kernel32")]
extern "system" {
    fn CreateEventW(
        attributes: *const c_void,
        manual: i32,
        initial: i32,
        name: *const u16,
    ) -> isize;
    fn CloseHandle(handle: isize) -> i32;
}
struct Event(isize);
impl Drop for Event {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
#[test]
fn actual_main_rejects_gui_and_headless_without_pinning_the_product_image() {
    let name: Vec<u16> = "Global\\MizarUpdateActive\0".encode_utf16().collect();
    let handle = unsafe { CreateEventW(std::ptr::null(), 0, 0, name.as_ptr()) };
    assert_ne!(handle, 0);
    let _active = Event(handle);
    let root = std::env::temp_dir().join(format!("mizar-real-entry-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let image = root.join("Mizar.exe");
    fs::copy(env!("CARGO_BIN_EXE_mizar-desktop"), &image).unwrap();
    // A real but unresponsive target window must not make ShowWindow wait across threads.
    let ready = root.join("window-ready.txt");
    let target = root.join("target-window.ps1");
    let source = format!(
        r#"Add-Type -AssemblyName System.Windows.Forms
$form = New-Object Windows.Forms.Form
$form.Text = 'Mizar 应用更新'
$form.Add_Shown({{ [IO.File]::WriteAllText('{}','ready'); Start-Sleep -Seconds 5; $form.Close() }})
[Windows.Forms.Application]::Run($form)
"#,
        ready.display().to_string().replace('\'', "''")
    );
    let mut bytes = vec![0xef, 0xbb, 0xbf];
    bytes.extend(source.as_bytes());
    fs::write(&target, bytes).unwrap();
    let mut window = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&target)
        .creation_flags(0x08000000)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let wait = Instant::now() + Duration::from_secs(10);
    while !ready.exists() {
        assert!(Instant::now() < wait, "target did not start");
        thread::sleep(Duration::from_millis(20));
    }
    for headless in [false, true] {
        let mut command = Command::new(&image);
        if headless {
            command.arg("--no-browser");
        }
        let mut child = command
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("real main kept the image mapped during update");
            }
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(status.code(), Some(1));
        let gate = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(4)
            .open(&image)
            .unwrap();
        drop(gate);
        assert!(
            !root.join("state").exists(),
            "rejected entry initialized a runtime"
        );
    }
    window.wait().unwrap();
    fs::remove_dir_all(root).unwrap();
}
