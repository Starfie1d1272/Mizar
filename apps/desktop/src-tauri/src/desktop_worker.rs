use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

pub struct DesktopWorker {
    pub running: Arc<AtomicBool>,
    pub dispatch: Arc<Mutex<()>>,
    pub handle: Arc<Mutex<Option<thread::JoinHandle<()>>>>,
}
impl DesktopWorker {
    pub fn stop(&self) {
        if let Ok(_dispatch) = self.dispatch.lock() {
            self.running.store(false, Ordering::Relaxed);
        }
        if let Ok(mut handle) = self.handle.lock() {
            if let Some(handle) = handle.take() {
                let until = Instant::now() + Duration::from_millis(300);
                while !handle.is_finished() && Instant::now() < until {
                    thread::sleep(Duration::from_millis(10));
                }
                if handle.is_finished() {
                    let _ = handle.join();
                }
                // A blocked CS2 native call may finish later. The dispatch gate
                // prevents this detached worker from using Tauri after shutdown.
            }
        }
    }
}
impl Drop for DesktopWorker {
    fn drop(&mut self) {
        self.stop();
    }
}
