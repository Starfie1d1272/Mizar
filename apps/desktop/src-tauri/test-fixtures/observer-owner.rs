//! Standalone Windows owner fixture using the production Job implementation.
mod startup_log {
    pub struct DesktopLog {
        pub directory: std::path::PathBuf,
    }
    impl DesktopLog {
        pub fn event(&self, _: &str, _: &str, _: Option<&str>) {}
    }
}
#[path = "../src/observer_job.rs"]
mod observer_job;
#[path = "../src/windows_startup.rs"]
mod windows_startup;
fn main() {
    let session = format!("fixture-{}", std::process::id());
    let _job = observer_job::create(&session).unwrap();
    println!("{}", observer_job::name(&session));
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).unwrap();
}
