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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::production_exit::{finish_then_restore, ExitGate};
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn failed_exit_keeps_tracking_and_allows_operations_then_retry_stops_worker() {
        let running = Arc::new(AtomicBool::new(true));
        let ticks = Arc::new(AtomicUsize::new(0));
        let worker_running = running.clone();
        let worker_ticks = ticks.clone();
        let worker = DesktopWorker {
            running,
            dispatch: Arc::new(Mutex::new(())),
            handle: Arc::new(Mutex::new(Some(thread::spawn(move || {
                while worker_running.load(Ordering::Relaxed) {
                    worker_ticks.fetch_add(1, Ordering::Relaxed);
                    thread::sleep(Duration::from_millis(1));
                }
            })))),
        };
        let gate = ExitGate::default();
        for failed_restore in [false, true] {
            assert!(gate.begin());
            assert!(finish_then_restore(
                || if failed_restore {
                    Ok(())
                } else {
                    Err("OBS failed".into())
                },
                || Err("restore failed".into()),
            )
            .is_err());
            gate.cancel();
            assert!(gate.check().is_ok());
            let before = ticks.load(Ordering::Relaxed);
            let deadline = Instant::now() + Duration::from_secs(1);
            while ticks.load(Ordering::Relaxed) == before && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(1));
            }
            assert!(ticks.load(Ordering::Relaxed) > before);
        }
        assert!(gate.begin());
        finish_then_restore(|| Ok(()), || Ok(())).unwrap();
        worker.stop();
        assert!(!worker.running.load(Ordering::Relaxed));
        assert!(worker.handle.lock().unwrap().is_none());
    }
}
